import * as fs from 'fs';
const fsPromises = fs.promises;
import config from '../config';
import logger from '../logger';

/**
 * Persistent cache for BIP110 violation statistics per block.
 *
 * Problem: $indexBlock() only fetches the coinbase transaction (onlyCoinbase=true)
 * for performance, so BIP110 violation analysis is never done for historic blocks.
 * This cache stores violation stats computed when blocks are fully analyzed
 * (either during real-time processing or via background scanning).
 *
 * Memory-efficient design using typed arrays indexed by block height:
 *   - counts:  Uint16Array  — violation tx count per block (2 bytes each)
 *   - weights: Uint32Array  — violation weight per block   (4 bytes each)
 *   - tags:    Uint32Array  — first 4 bytes of the block hash (4 bytes each)
 *   - Total for ~1M blocks: ~10 MB RAM + ~10 MB on disk (binary format)
 *
 * Sentinel value 0xFFFF in counts[] means "not yet scanned".
 *
 * The hash tag exists because the cache is keyed by height, and heights are not stable
 * across a reorg. Without it, a reorged block inherits the previous block's violation
 * count forever (isScanned() returns true, so it is never recomputed). Reorgs are
 * exactly what to expect around activation, and the app's own reorg handling is gated
 * on database indexing being enabled — so this check has to be self-contained.
 *
 * Disk format (cache/bip110-stats.bin):
 *   Header (32 bytes): version(u32) + scanHeight(u32) + capacity(u32)
 *                      + mandatoryFirstNonSignaling(u32) + mandatoryNonSignalingCount(u32)
 *                      + mandatorySealed(u32) + reserved(u32 × 2)
 *   Data (capacity × 10 bytes): [count(u16) + weight(u32) + hashTag(u32)] per block
 */

/** Sentinel: block at this height has NOT been scanned yet */
const NOT_SCANNED: number = 0xFFFF;
/** Sentinel: no hash tag recorded for this entry (pre-v3 data, or unknown hash) */
const NO_TAG: number = 0;
/** Binary file format version */
const BINARY_VERSION: number = 3;
/** Header: version(4) + scanHeight(4) + capacity(4) + mandatory seal(12) + reserved(8) */
const HEADER_SIZE: number = 32;
/** Per-block entry: count(2) + weight(4) + hashTag(4) */
const ENTRY_SIZE: number = 10;
/** u32 sentinel for "no value" in the header */
const HEADER_NONE: number = 0xFFFFFFFF;

/** Derive the 4-byte hash tag used to detect reorged heights */
export function hashTag(blockHash: string | null | undefined): number {
  if (!blockHash || blockHash.length < 8) {
    return NO_TAG;
  }
  const tag = parseInt(blockHash.slice(0, 8), 16);
  if (!Number.isFinite(tag)) {
    return NO_TAG;
  }
  // Never collide with the "no tag recorded" sentinel
  return tag === NO_TAG ? 1 : tag >>> 0;
}

class Bip110Cache {
  private counts: Uint16Array;    // violation tx count per block (index = height)
  private weights: Uint32Array;   // violation weight per block
  private tags: Uint32Array;      // first 4 bytes of the block hash (0 = unknown)
  private capacity: number = 0;
  // Retained for on-disk format compatibility only. The scanner derives its pending
  // work from the per-height entries themselves, so there is no resume watermark to
  // maintain; keeping the header field avoids another format bump.
  private scanHeight: number = Infinity;
  private isDirty: boolean = false;
  private isLoaded: boolean = false;
  private isSaving: boolean = false;
  private violationBlockCount: number = 0;  // running counter for fast access
  private scannedBlockCount: number = 0;    // running counter for fast access
  private readonly cacheFile: string;
  private readonly legacyCacheFile: string;

  // ── Mandatory-signaling window seal ───────────────────────────────────────
  // Recorded once while the deployment is STARTED and the header map is still being
  // filled, because the periodic header refresh is shut off at lock-in and an install
  // that first starts up afterwards has no other cheap source for this.
  private mandatoryFirstNonSignaling: number | null = null;
  private mandatoryNonSignalingCount: number = 0;
  private mandatorySealed: boolean = false;
  /** Incremented on every stats write; lets consumers detect scanner progress */
  private statsVersion: number = 0;

  constructor() {
    const cacheDir = config.MEMPOOL?.CACHE_DIR || './cache';
    this.cacheFile = cacheDir + '/bip110-stats.bin';
    this.legacyCacheFile = cacheDir + '/bip110-stats.json';
    this.counts = new Uint16Array(0);
    this.weights = new Uint32Array(0);
    this.tags = new Uint32Array(0);
  }

  /**
   * Ensure typed arrays are large enough for the given height.
   * Grows with headroom to avoid frequent resizes.
   */
  private ensureCapacity(minHeight: number): void {
    if (minHeight < this.capacity) return;

    const newCapacity = Math.max(minHeight + 10000, this.capacity * 2, 1000000);
    const newCounts = new Uint16Array(newCapacity);
    const newWeights = new Uint32Array(newCapacity);
    const newTags = new Uint32Array(newCapacity);

    // Fill new entries with NOT_SCANNED sentinel
    newCounts.fill(NOT_SCANNED);

    // Copy existing data (overwrites beginning of newCounts)
    if (this.capacity > 0) {
      newCounts.set(this.counts);
      newWeights.set(this.weights);
      newTags.set(this.tags);
    }

    this.counts = newCounts;
    this.weights = newWeights;
    this.tags = newTags;
    this.capacity = newCapacity;
  }

  /**
   * Load cache from disk (binary format, with legacy JSON fallback)
   */
  loadFromDisk(): void {
    try {
      if (fs.existsSync(this.cacheFile)) {
        this.loadBinary(this.cacheFile);
      } else if (fs.existsSync(this.legacyCacheFile)) {
        this.loadLegacyJson(this.legacyCacheFile);
        // Save in new binary format immediately
        this.isDirty = true;
        this.saveToDiskSync();
        logger.info('BIP110 cache migrated from JSON to binary format');
      }
      // Legacy JSON has no per-block hashes, so anything imported from it is untagged
      // and will be re-verified near the tip on demand.
    } catch (e) {
      logger.warn('Failed to load BIP110 cache: ' + (e instanceof Error ? e.message : e));
    }
    this.isLoaded = true;
  }

  private loadBinary(filePath: string): void {
    const buf = fs.readFileSync(filePath);
    if (buf.length < HEADER_SIZE) {
      logger.warn('BIP110 binary cache too small, starting fresh');
      return;
    }

    const version = buf.readUInt32LE(0);
    if (version !== BINARY_VERSION) {
      // No v2 -> v3 migration: back-filling hash tags would need one RPC per height,
      // which is no cheaper than simply rescanning in the background.
      logger.notice(`BIP110 cache version ${version} != ${BINARY_VERSION}, starting fresh`);
      return;
    }

    const scanH = buf.readUInt32LE(4);
    const cap = buf.readUInt32LE(8);
    const mandatoryFirst = buf.readUInt32LE(12);
    const mandatoryCount = buf.readUInt32LE(16);
    const mandatorySealed = buf.readUInt32LE(20);

    const expectedSize = HEADER_SIZE + cap * ENTRY_SIZE;
    if (buf.length < expectedSize) {
      logger.warn(`BIP110 cache truncated (expected ${expectedSize}, got ${buf.length}), starting fresh`);
      return;
    }

    this.capacity = cap;
    this.counts = new Uint16Array(cap);
    this.weights = new Uint32Array(cap);
    this.tags = new Uint32Array(cap);
    this.scanHeight = scanH === HEADER_NONE ? Infinity : scanH;
    this.mandatoryFirstNonSignaling = mandatoryFirst === HEADER_NONE ? null : mandatoryFirst;
    this.mandatoryNonSignalingCount = mandatoryCount === HEADER_NONE ? 0 : mandatoryCount;
    this.mandatorySealed = mandatorySealed === 1;

    // Read interleaved data: [count(u16), weight(u32), hashTag(u32)] per block
    let offset = HEADER_SIZE;
    let scanned = 0;
    let violations = 0;
    for (let i = 0; i < cap; i++) {
      const c = buf.readUInt16LE(offset);
      this.counts[i] = c;
      this.weights[i] = buf.readUInt32LE(offset + 2);
      this.tags[i] = buf.readUInt32LE(offset + 6);
      offset += ENTRY_SIZE;
      if (c !== NOT_SCANNED) {
        scanned++;
        if (c > 0) violations++;
      }
    }

    this.scannedBlockCount = scanned;
    this.violationBlockCount = violations;
    const sizeMB = (buf.length / 1024 / 1024).toFixed(1);
    const seal = this.mandatorySealed
      ? `mandatory window sealed (${this.mandatoryNonSignalingCount} non-signaling)`
      : 'mandatory window not yet sealed';
    logger.info(`BIP110 cache loaded (${sizeMB} MB): ${scanned} blocks scanned, ${violations} with violations, ${seal}`);
  }

  private loadLegacyJson(filePath: string): void {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (data.version !== 1) return;

    this.scanHeight = data.scanHeight === -1 ? Infinity : (data.scanHeight ?? Infinity);

    // Determine max height to size arrays
    let maxHeight = 0;
    if (data.stats) {
      for (const heightStr of Object.keys(data.stats)) {
        maxHeight = Math.max(maxHeight, Number(heightStr));
      }
    }

    this.ensureCapacity(maxHeight + 1);

    // Mark all heights from scanHeight to maxHeight as scanned (count=0 means scanned, no violations)
    if (this.scanHeight !== Infinity) {
      for (let h = this.scanHeight; h <= maxHeight; h++) {
        if (this.counts[h] === NOT_SCANNED) {
          this.counts[h] = 0;
          this.weights[h] = 0;
          this.scannedBlockCount++;
        }
      }
    }

    // Import violation data
    if (data.stats) {
      for (const [heightStr, pair] of Object.entries(data.stats)) {
        const h = Number(heightStr);
        const [count, weight] = pair as [number, number];
        const wasScanned = this.counts[h] !== NOT_SCANNED;
        this.counts[h] = Math.min(count, NOT_SCANNED - 1);
        this.weights[h] = weight;
        if (count > 0) this.violationBlockCount++;
        if (!wasScanned) this.scannedBlockCount++;
      }
    }

    logger.info(`BIP110 cache imported from legacy JSON: ${Object.keys(data.stats || {}).length} violation blocks`);
  }

  /**
   * Save cache to disk in binary format (synchronous, for shutdown)
   */
  saveToDiskSync(): void {
    if (!this.isDirty) return;
    try {
      const buf = this.serializeBinary();
      fs.writeFileSync(this.cacheFile, new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      this.isDirty = false;
      logger.debug(`BIP110 cache saved (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
    } catch (e) {
      logger.warn('Failed to save BIP110 cache: ' + (e instanceof Error ? e.message : e));
    }
  }

  /**
   * Save cache to disk in binary format (async, for periodic saves)
   */
  async saveToDisk(): Promise<void> {
    if (!this.isDirty || this.isSaving) return;
    this.isSaving = true;
    try {
      const buf = this.serializeBinary();
      const tmpFile = this.cacheFile + '.tmp';
      await fsPromises.writeFile(tmpFile, new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      await fsPromises.rename(tmpFile, this.cacheFile);
      this.isDirty = false;
      logger.debug(`BIP110 cache saved (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
    } catch (e) {
      logger.warn('Failed to save BIP110 cache: ' + (e instanceof Error ? e.message : e));
    } finally {
      this.isSaving = false;
    }
  }

  private serializeBinary(): Buffer {
    const buf = Buffer.alloc(HEADER_SIZE + this.capacity * ENTRY_SIZE);
    buf.writeUInt32LE(BINARY_VERSION, 0);
    buf.writeUInt32LE(this.scanHeight === Infinity ? HEADER_NONE : this.scanHeight, 4);
    buf.writeUInt32LE(this.capacity, 8);
    buf.writeUInt32LE(this.mandatoryFirstNonSignaling ?? HEADER_NONE, 12);
    buf.writeUInt32LE(this.mandatoryNonSignalingCount, 16);
    buf.writeUInt32LE(this.mandatorySealed ? 1 : 0, 20);

    let offset = HEADER_SIZE;
    for (let i = 0; i < this.capacity; i++) {
      buf.writeUInt16LE(this.counts[i], offset);
      buf.writeUInt32LE(this.weights[i], offset + 2);
      buf.writeUInt32LE(this.tags[i], offset + 6);
      offset += ENTRY_SIZE;
    }

    return buf;
  }

  /**
   * Record violation stats for a block.
   * `blockHash` is optional but strongly preferred — without it the entry is untagged
   * and cannot be validated against a reorg.
   */
  setBlockStats(height: number, count: number, weight: number, blockHash?: string | null): void {
    this.ensureCapacity(height + 1);
    const wasScanned = this.counts[height] !== NOT_SCANNED;
    const hadViolations = wasScanned && this.counts[height] > 0;

    this.counts[height] = Math.min(count, NOT_SCANNED - 1);
    this.weights[height] = weight;
    this.tags[height] = hashTag(blockHash);

    // Update running counters
    if (!wasScanned) this.scannedBlockCount++;
    if (count > 0 && !hadViolations) this.violationBlockCount++;
    if (count === 0 && hadViolations) this.violationBlockCount--;

    this.isDirty = true;
    this.statsVersion++;
  }

  /**
   * Bumped on every stats write. The deployment tracker caches its computed info per
   * chain tip, but the chain verdict also depends on what the background scanner has
   * found — without this, a verdict computed as 'unknown' early in a sweep would stay
   * 'unknown' until the next block arrived, up to ten minutes later.
   */
  getStatsVersion(): number {
    return this.statsVersion;
  }

  /**
   * Whether a cached entry's hash tag matches the block currently at that height.
   *
   * Untagged entries (legacy imports, or writes that had no hash to hand) are accepted:
   * treating them as misses would invalidate the whole cache on upgrade. Callers that
   * care about reorg safety pass a hash and get a strict check.
   */
  private tagMatches(height: number, blockHash?: string | null): boolean {
    if (!blockHash) {
      return true;
    }
    const stored = this.tags[height];
    if (stored === NO_TAG) {
      return true;
    }
    return stored === hashTag(blockHash);
  }

  /**
   * Get violation stats for a block.
   * Returns { count, weight } if the block has been scanned.
   * Returns null if the block hasn't been scanned, or if the cached entry belongs to a
   * different block at that height (reorg).
   */
  getBlockStats(height: number, blockHash?: string | null): { count: number; weight: number } | null {
    if (height < 0 || height >= this.capacity) return null;
    const c = this.counts[height];
    if (c === NOT_SCANNED) return null;
    if (!this.tagMatches(height, blockHash)) return null;
    return { count: c, weight: this.weights[height] };
  }

  /**
   * Check if a specific height has been scanned.
   * Pass the current block hash to also reject entries orphaned by a reorg.
   */
  isScanned(height: number, blockHash?: string | null): boolean {
    if (height < 0 || height >= this.capacity) return false;
    if (this.counts[height] === NOT_SCANNED) return false;
    return this.tagMatches(height, blockHash);
  }

  /**
   * Drop cached entries at or above `height` (used when a reorg is detected).
   */
  invalidateFrom(height: number): number {
    let dropped = 0;
    for (let h = Math.max(0, height); h < this.capacity; h++) {
      if (this.counts[h] === NOT_SCANNED) continue;
      if (this.counts[h] > 0) this.violationBlockCount--;
      this.counts[h] = NOT_SCANNED;
      this.weights[h] = 0;
      this.tags[h] = NO_TAG;
      this.scannedBlockCount--;
      dropped++;
    }
    if (dropped > 0) {
      if (this.scanHeight !== Infinity && this.scanHeight >= height) {
        this.scanHeight = Infinity;
      }
      this.isDirty = true;
      this.statsVersion++;
      logger.info(`BIP110 cache: invalidated ${dropped} entries from height ${height}`);
    }
    return dropped;
  }

  // ── Mandatory-signaling window seal ───────────────────────────────────────

  /**
   * Persist the outcome of the mandatory-signaling window. Called once, while the
   * header map still covers the window, before the periodic refresh is shut off at
   * lock-in. Without this an install that first runs after lock-in has no cheap way to
   * tell whether its chain diverged during the window.
   */
  sealMandatoryWindow(firstNonSignaling: number | null, nonSignalingCount: number): void {
    this.mandatoryFirstNonSignaling = firstNonSignaling;
    this.mandatoryNonSignalingCount = nonSignalingCount;
    this.mandatorySealed = true;
    this.isDirty = true;
    this.statsVersion++;
    logger.info(`BIP110: mandatory signaling window sealed — ${nonSignalingCount} non-signaling block(s)`
      + (firstNonSignaling != null ? `, first at height ${firstNonSignaling}` : ''));
  }

  getMandatorySeal(): { sealed: boolean; firstNonSignaling: number | null; nonSignalingCount: number } {
    return {
      sealed: this.mandatorySealed,
      firstNonSignaling: this.mandatoryFirstNonSignaling,
      nonSignalingCount: this.mandatoryNonSignalingCount,
    };
  }

  /**
   * Lowest height at/above `from` that has not been scanned, or null if the whole range
   * up to `to` is covered. Used to decide whether the chain verdict may claim
   * "compliant" rather than "unknown".
   */
  firstUnscannedInRange(from: number, to: number): number | null {
    for (let h = Math.max(0, from); h <= to; h++) {
      if (h >= this.capacity || this.counts[h] === NOT_SCANNED) {
        return h;
      }
    }
    return null;
  }

  /**
   * Heights at/above `from` (up to `to`) that recorded at least one violation.
   */
  getViolationHeightsInRange(from: number, to: number): number[] {
    const heights: number[] = [];
    const end = Math.min(to, this.capacity - 1);
    for (let h = Math.max(0, from); h <= end; h++) {
      const c = this.counts[h];
      if (c !== NOT_SCANNED && c > 0) {
        heights.push(h);
      }
    }
    return heights;
  }

  getViolationBlockCount(): number {
    return this.violationBlockCount;
  }

  getScannedBlockCount(): number {
    return this.scannedBlockCount;
  }

  getIsLoaded(): boolean {
    return this.isLoaded;
  }
}

export default new Bip110Cache();
