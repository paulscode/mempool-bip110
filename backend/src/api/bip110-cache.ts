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
 *   - Total for ~1M blocks: ~6 MB RAM + ~6 MB on disk (binary format)
 *
 * Sentinel value 0xFFFF in counts[] means "not yet scanned".
 *
 * Disk format (cache/bip110-stats.bin):
 *   Header (12 bytes): version(u32) + scanHeight(u32) + capacity(u32)
 *   Data (capacity × 6 bytes): [count(u16) + weight(u32)] per block
 */

/** Sentinel: block at this height has NOT been scanned yet */
const NOT_SCANNED: number = 0xFFFF;
/** Binary file format version */
const BINARY_VERSION: number = 2;
/** Header: version(4) + scanHeight(4) + capacity(4) */
const HEADER_SIZE: number = 12;
/** Per-block entry: count(2) + weight(4) */
const ENTRY_SIZE: number = 6;

class Bip110Cache {
  private counts: Uint16Array;    // violation tx count per block (index = height)
  private weights: Uint32Array;   // violation weight per block
  private capacity: number = 0;
  private scanHeight: number = Infinity; // lowest height contiguously scanned from tip (scanner resume point)
  private isDirty: boolean = false;
  private isLoaded: boolean = false;
  private isSaving: boolean = false;
  private violationBlockCount: number = 0;  // running counter for fast access
  private scannedBlockCount: number = 0;    // running counter for fast access
  private readonly cacheFile: string;
  private readonly legacyCacheFile: string;

  constructor() {
    const cacheDir = config.MEMPOOL?.CACHE_DIR || './cache';
    this.cacheFile = cacheDir + '/bip110-stats.bin';
    this.legacyCacheFile = cacheDir + '/bip110-stats.json';
    this.counts = new Uint16Array(0);
    this.weights = new Uint32Array(0);
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

    // Fill new entries with NOT_SCANNED sentinel
    newCounts.fill(NOT_SCANNED);

    // Copy existing data (overwrites beginning of newCounts)
    if (this.capacity > 0) {
      newCounts.set(this.counts);
      newWeights.set(this.weights);
    }

    this.counts = newCounts;
    this.weights = newWeights;
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
      logger.notice(`BIP110 cache version ${version} != ${BINARY_VERSION}, starting fresh`);
      return;
    }

    const scanH = buf.readUInt32LE(4);
    const cap = buf.readUInt32LE(8);

    const expectedSize = HEADER_SIZE + cap * ENTRY_SIZE;
    if (buf.length < expectedSize) {
      logger.warn(`BIP110 cache truncated (expected ${expectedSize}, got ${buf.length}), starting fresh`);
      return;
    }

    this.capacity = cap;
    this.counts = new Uint16Array(cap);
    this.weights = new Uint32Array(cap);
    this.scanHeight = scanH === 0xFFFFFFFF ? Infinity : scanH;

    // Read interleaved data: [count(u16), weight(u32)] per block
    let offset = HEADER_SIZE;
    let scanned = 0;
    let violations = 0;
    for (let i = 0; i < cap; i++) {
      const c = buf.readUInt16LE(offset);
      this.counts[i] = c;
      this.weights[i] = buf.readUInt32LE(offset + 2);
      offset += ENTRY_SIZE;
      if (c !== NOT_SCANNED) {
        scanned++;
        if (c > 0) violations++;
      }
    }

    this.scannedBlockCount = scanned;
    this.violationBlockCount = violations;
    const sizeMB = (buf.length / 1024 / 1024).toFixed(1);
    logger.info(`BIP110 cache loaded (${sizeMB} MB): ${scanned} blocks scanned, ${violations} with violations, scan height ${this.scanHeight === Infinity ? 'none' : this.scanHeight}`);
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
    buf.writeUInt32LE(this.scanHeight === Infinity ? 0xFFFFFFFF : this.scanHeight, 4);
    buf.writeUInt32LE(this.capacity, 8);

    let offset = HEADER_SIZE;
    for (let i = 0; i < this.capacity; i++) {
      buf.writeUInt16LE(this.counts[i], offset);
      buf.writeUInt32LE(this.weights[i], offset + 2);
      offset += ENTRY_SIZE;
    }

    return buf;
  }

  /**
   * Record violation stats for a block.
   */
  setBlockStats(height: number, count: number, weight: number): void {
    this.ensureCapacity(height + 1);
    const wasScanned = this.counts[height] !== NOT_SCANNED;
    const hadViolations = wasScanned && this.counts[height] > 0;

    this.counts[height] = Math.min(count, NOT_SCANNED - 1);
    this.weights[height] = weight;

    // Update running counters
    if (!wasScanned) this.scannedBlockCount++;
    if (count > 0 && !hadViolations) this.violationBlockCount++;
    if (count === 0 && hadViolations) this.violationBlockCount--;

    this.isDirty = true;
  }

  /**
   * Update the scan watermark — the lowest height contiguously scanned from tip.
   * Used as the scanner's resume point.
   */
  updateScanHeight(height: number): void {
    if (height < this.scanHeight) {
      this.scanHeight = height;
      this.isDirty = true;
    }
  }

  /**
   * Get violation stats for a block.
   * Returns { count, weight } if the block has been scanned.
   * Returns null if the block hasn't been scanned yet.
   */
  getBlockStats(height: number): { count: number; weight: number } | null {
    if (height < 0 || height >= this.capacity) return null;
    const c = this.counts[height];
    if (c === NOT_SCANNED) return null;
    return { count: c, weight: this.weights[height] };
  }

  /**
   * Check if a specific height has been scanned.
   */
  isScanned(height: number): boolean {
    if (height < 0 || height >= this.capacity) return false;
    return this.counts[height] !== NOT_SCANNED;
  }

  getScanHeight(): number {
    return this.scanHeight;
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
