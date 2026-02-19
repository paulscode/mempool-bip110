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
 * Data layout on disk (cache/bip110-stats.json):
 * {
 *   "version": 1,
 *   "scanHeight": 935000,   // lowest height contiguously scanned from tip
 *   "stats": {               // only blocks WITH violations are stored
 *     "935005": [3, 8500],   // [count, weight]
 *     "935023": [48, 145200]
 *   }
 * }
 */

interface Bip110CacheFile {
  version: number;
  scanHeight: number;
  stats: Record<string, [number, number]>;
}

class Bip110Cache {
  private statsMap: Map<number, [number, number]> = new Map(); // height -> [count, weight]
  private scanHeight: number = Infinity; // everything >= scanHeight has been scanned
  private isDirty: boolean = false;
  private isLoaded: boolean = false;
  private isSaving: boolean = false;
  private readonly cacheFile: string;

  constructor() {
    this.cacheFile = (config.MEMPOOL?.CACHE_DIR || './cache') + '/bip110-stats.json';
  }

  /**
   * Load cache from disk
   */
  loadFromDisk(): void {
    try {
      if (fs.existsSync(this.cacheFile)) {
        const raw = fs.readFileSync(this.cacheFile, 'utf8');
        const data: Bip110CacheFile = JSON.parse(raw);
        if (data.version === 1) {
          this.scanHeight = data.scanHeight ?? Infinity;
          this.statsMap.clear();
          if (data.stats) {
            for (const [heightStr, pair] of Object.entries(data.stats)) {
              this.statsMap.set(Number(heightStr), pair);
            }
          }
          logger.info(`BIP110 cache loaded: ${this.statsMap.size} blocks with violations, scanned to height ${this.scanHeight === Infinity ? 'none' : this.scanHeight}`);
        } else {
          logger.notice('BIP110 cache version mismatch, starting fresh');
        }
      }
    } catch (e) {
      logger.warn('Failed to load BIP110 cache: ' + (e instanceof Error ? e.message : e));
    }
    this.isLoaded = true;
  }

  /**
   * Save cache to disk (synchronous, for use during shutdown)
   */
  saveToDiskSync(): void {
    if (!this.isDirty) return;
    try {
      const data = this.serializeCache();
      fs.writeFileSync(this.cacheFile, JSON.stringify(data));
      this.isDirty = false;
      logger.debug(`BIP110 cache saved: ${this.statsMap.size} violation blocks, scanned to ${this.scanHeight}`);
    } catch (e) {
      logger.warn('Failed to save BIP110 cache: ' + (e instanceof Error ? e.message : e));
    }
  }

  /**
   * Save cache to disk (async, for periodic saves)
   */
  async saveToDisk(): Promise<void> {
    if (!this.isDirty || this.isSaving) return;
    this.isSaving = true;
    try {
      const data = this.serializeCache();
      const tmpFile = this.cacheFile + '.tmp';
      await fsPromises.writeFile(tmpFile, JSON.stringify(data));
      await fsPromises.rename(tmpFile, this.cacheFile);
      this.isDirty = false;
      logger.debug(`BIP110 cache saved: ${this.statsMap.size} violation blocks, scanned to ${this.scanHeight}`);
    } catch (e) {
      logger.warn('Failed to save BIP110 cache: ' + (e instanceof Error ? e.message : e));
    } finally {
      this.isSaving = false;
    }
  }

  private serializeCache(): Bip110CacheFile {
    const stats: Record<string, [number, number]> = {};
    for (const [height, pair] of this.statsMap) {
      stats[height.toString()] = pair;
    }
    return {
      version: 1,
      scanHeight: this.scanHeight === Infinity ? -1 : this.scanHeight,
      stats,
    };
  }

  /**
   * Record violation stats for a block.
   * Only stores entries for blocks that have violations (count > 0).
   */
  setBlockStats(height: number, count: number, weight: number): void {
    if (count > 0) {
      this.statsMap.set(height, [count, weight]);
    } else {
      this.statsMap.delete(height);
    }
    this.isDirty = true;
  }

  /**
   * Update the scan watermark — indicates the lowest height that has been
   * contiguously scanned from the current chain tip.
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
    if (height >= this.scanHeight) {
      const pair = this.statsMap.get(height);
      if (pair) {
        return { count: pair[0], weight: pair[1] };
      }
      return { count: 0, weight: 0 }; // Scanned, no violations
    }
    return null; // Not yet scanned
  }

  /**
   * Check if a specific height has been scanned.
   */
  isScanned(height: number): boolean {
    return height >= this.scanHeight;
  }

  getScanHeight(): number {
    return this.scanHeight;
  }

  getViolationBlockCount(): number {
    return this.statsMap.size;
  }

  getIsLoaded(): boolean {
    return this.isLoaded;
  }
}

export default new Bip110Cache();
