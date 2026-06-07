import logger from '../logger';
import blocks from './blocks';
import { Common } from './common';
import config from '../config';
import BlocksRepository from '../repositories/BlocksRepository';

/**
 * BIP-110 'reduced_data' deployment state tracker.
 *
 * Computes the deployment phase from the current chain tip and signaling data,
 * using the constants defined in bip-0110.mediawiki:
 *
 *   bit:                    4
 *   starttime:              1764547200 (~December 1, 2025)
 *   threshold:              1109/2016 (55%)
 *   max_activation_height:  965664
 *   active_duration:        52416 blocks (~1 year)
 *   mandatory signaling:    blocks 961632–963647
 *   mandatory lock-in:      height 963648
 *
 * State machine: DEFINED → STARTED → LOCKED_IN → ACTIVE → EXPIRED
 *
 * EXPIRED is a terminal state entered active_duration blocks after activation,
 * at which point the consensus rules are no longer enforced.
 */

// ── BIP-110 deployment constants ──────────────────────────────────────────────
const RETARGET_PERIOD = 2016;
const THRESHOLD = 1109;                           // 55% of 2016
const STARTTIME = 1764547200;                     // MTP threshold for DEFINED→STARTED
const MANDATORY_SIGNALING_START = 961632;         // first block of mandatory signaling period
const MANDATORY_LOCK_IN_HEIGHT = 963648;          // forced LOCKED_IN if threshold not reached earlier
const MAX_ACTIVATION_HEIGHT = 965664;             // ACTIVE starts here if locked in at mandatory
const ACTIVE_DURATION = 52416;                    // rules enforced for this many blocks after activation
const SIGNALING_BIT = 4;                          // deployment 'reduced_data' version bit

export type Bip110State = 'defined' | 'started' | 'locked_in' | 'active' | 'expired';

export interface Bip110DeploymentInfo {
  /** Current deployment state */
  state: Bip110State;
  /** Current chain tip height */
  currentHeight: number;

  // ── STARTED phase info ──────────────────────────────────────────────────
  /** Signaling blocks in the current retarget period */
  periodSignaling: number;
  /** Total blocks mined so far in the current retarget period */
  periodBlocks: number;
  /** Height of the first block of the current retarget period */
  periodStartHeight: number;
  /** Threshold needed (1109) */
  threshold: number;
  /** Signaling percentage in current period (0–100) */
  signalingPercent: number;
  /** Whether threshold has been reached in the current period */
  thresholdReached: boolean;

  // ── Countdown / milestone info ──────────────────────────────────────────
  /** Blocks remaining until mandatory signaling period begins */
  blocksUntilMandatory: number;
  /** Whether the current block is in the mandatory signaling window */
  inMandatorySignaling: boolean;
  /** Height at which the soft fork rules will activate (or did activate) */
  activationHeight: number | null;
  /** Height at which active_duration expires (rules stop being enforced) */
  expiryHeight: number | null;
  /** Blocks remaining in the active enforcement period (0 if not active or expired) */
  blocksUntilExpiry: number;
  /** Whether the rules have expired (active_duration elapsed) */
  rulesExpired: boolean;
}

class Bip110DeploymentApi {
  private cachedInfo: Bip110DeploymentInfo | null = null;
  private lastHeight: number = -1;
  /** Height at which LOCKED_IN was entered (if we know it) */
  private lockedInHeight: number | null = null;
  /** DB-backed signaling count for the current retarget period */
  private periodSignalingCache: { periodStart: number; count: number } | null = null;
  /** Guard against overlapping async signaling refreshes */
  private refreshing: boolean = false;
  /** Whether the one-time historical lock-in scan has completed */
  private lockInScanned: boolean = false;
  /** Guard against overlapping lock-in scans */
  private scanning: boolean = false;

  /**
   * Get the current deployment info. Recomputes only when chain tip changes.
   */
  public getDeploymentInfo(): Bip110DeploymentInfo | null {
    const currentHeight = blocks.getCurrentBlockHeight();
    if (currentHeight < 0) {
      return null;
    }
    // One-time scan to recover a threshold-based lock-in that may have happened
    // before this process started (lockedInHeight is otherwise in-memory only).
    if (!this.lockInScanned && this.lockedInHeight == null) {
      void this.$scanForLockIn(currentHeight);
    }
    if (currentHeight !== this.lastHeight || !this.cachedInfo) {
      this.cachedInfo = this.computeDeploymentInfo(currentHeight);
      this.lastHeight = currentHeight;
    }
    return this.cachedInfo;
  }

  /**
   * Compute the full deployment state for a given chain tip height.
   */
  private computeDeploymentInfo(currentHeight: number): Bip110DeploymentInfo {
    const state = this.computeState(currentHeight);

    // Current retarget period signaling stats
    const periodStartHeight = currentHeight - (currentHeight % RETARGET_PERIOD);
    const periodBlocks = (currentHeight % RETARGET_PERIOD) + 1;

    // Signaling count for the current retarget period. Prefer the DB-backed
    // count (covers all ~2016 blocks); on a cache miss fall back to the limited
    // in-memory block cache for an immediate value and trigger an async refresh.
    let periodSignaling: number;
    if (this.periodSignalingCache && this.periodSignalingCache.periodStart === periodStartHeight) {
      periodSignaling = this.periodSignalingCache.count;
    } else {
      periodSignaling = this.countSignalingInCurrentPeriod(periodStartHeight, currentHeight);
      void this.$refreshSignaling(periodStartHeight, currentHeight);
    }
    const signalingPercent = periodBlocks > 0 ? (periodSignaling / periodBlocks) * 100 : 0;
    const thresholdReached = periodSignaling >= THRESHOLD;

    // Milestone computations
    const blocksUntilMandatory = Math.max(0, MANDATORY_SIGNALING_START - currentHeight);
    const inMandatorySignaling = currentHeight >= MANDATORY_SIGNALING_START && currentHeight < MANDATORY_LOCK_IN_HEIGHT;

    // Activation height: computed from when lock-in occurred
    let activationHeight: number | null = null;
    if (state === 'locked_in' || state === 'active' || state === 'expired') {
      if (this.lockedInHeight != null) {
        // Activation is at the start of the next retarget period after lock-in
        const lockInPeriodStart = this.lockedInHeight - (this.lockedInHeight % RETARGET_PERIOD);
        activationHeight = lockInPeriodStart + RETARGET_PERIOD;
      } else {
        // Fallback: use MAX_ACTIVATION_HEIGHT (mandatory lock-in case)
        activationHeight = MAX_ACTIVATION_HEIGHT;
      }
    }

    const expiryHeight = activationHeight != null ? activationHeight + ACTIVE_DURATION : null;
    const blocksUntilExpiry = expiryHeight != null && state === 'active'
      ? Math.max(0, expiryHeight - currentHeight)
      : 0;
    const rulesExpired = state === 'expired';

    return {
      state,
      currentHeight,
      periodSignaling,
      periodBlocks,
      periodStartHeight,
      threshold: THRESHOLD,
      signalingPercent,
      thresholdReached,
      blocksUntilMandatory,
      inMandatorySignaling,
      activationHeight,
      expiryHeight,
      blocksUntilExpiry,
      rulesExpired,
    };
  }

  /**
   * Determine the deployment state based on height and known history.
   *
   * State transitions (BIP-110):
   *   DEFINED   →  block.MTP ≥ starttime  →  STARTED
   *   STARTED   →  threshold reached OR height ≥ 963648  →  LOCKED_IN
   *   LOCKED_IN →  next retarget boundary  →  ACTIVE
   *   ACTIVE    →  height ≥ activation + active_duration  →  EXPIRED (terminal)
   *
   * Since we can't cheaply compute MTP, we use block timestamps from the cache
   * as a reasonable approximation. The DEFINED→STARTED transition only matters
   * for blocks near the starttime (~Dec 2025). After that, height-based logic
   * dominates.
   */
  private computeState(currentHeight: number): Bip110State {
    // Effective lock-in height: a detected threshold lock-in if known, otherwise
    // the mandatory backstop once the chain has passed MANDATORY_LOCK_IN_HEIGHT.
    // The mandatory fallback is computed locally (not persisted) so the async
    // historical scan can still set the real, earlier lock-in height.
    let lockedIn = this.lockedInHeight;
    if (lockedIn == null && currentHeight >= MANDATORY_LOCK_IN_HEIGHT) {
      lockedIn = MANDATORY_LOCK_IN_HEIGHT;
    }

    if (lockedIn != null) {
      const lockInPeriodStart = lockedIn - (lockedIn % RETARGET_PERIOD);
      const activationHeight = lockInPeriodStart + RETARGET_PERIOD;
      if (currentHeight >= activationHeight + ACTIVE_DURATION) {
        return 'expired';
      }
      if (currentHeight >= activationHeight) {
        return 'active';
      }
      return 'locked_in';
    }

    // Before starttime → DEFINED
    // Use the latest block timestamp as a proxy for MTP
    const latestBlocks = blocks.getBlocks();
    const latestBlock = latestBlocks.length > 0 ? latestBlocks[latestBlocks.length - 1] : null;
    if (latestBlock && latestBlock.timestamp < STARTTIME) {
      return 'defined';
    }

    // If we can't determine (no blocks yet), assume DEFINED
    if (!latestBlock) {
      return 'defined';
    }

    // We're in STARTED state — check if threshold was reached at the end of
    // the most recent completed retarget period
    // (In practice, we'd need to scan historical retarget periods, but for
    //  a live dashboard, we check the current period's signaling progress.)
    return 'started';
  }

  /**
   * Called when a new block arrives. Refreshes the signaling count and, at a
   * retarget boundary, records the lock-in height if the threshold was reached.
   * Runs asynchronously (fire-and-forget) since the caller is synchronous.
   */
  public onNewBlock(height: number): void {
    void this.$handleNewBlock(height);
  }

  private async $handleNewBlock(height: number): Promise<void> {
    const periodStart = height - (height % RETARGET_PERIOD);

    // Get an accurate full-period count for this block height.
    const signaling = await this.$getSignaling(periodStart, height);
    this.periodSignalingCache = { periodStart, count: signaling };

    // Lock in at the end of a retarget period if the threshold was reached.
    if (this.lockedInHeight == null
        && height % RETARGET_PERIOD === RETARGET_PERIOD - 1
        && signaling >= THRESHOLD) {
      this.lockedInHeight = height + 1; // Lock-in happens at the next retarget boundary
      logger.info(`BIP-110: Threshold reached at height ${height} (${signaling}/${RETARGET_PERIOD}). LOCKED_IN at ${this.lockedInHeight}.`);
    }

    // Clear cached info so it's recomputed with the fresh count.
    this.lastHeight = -1;
    this.cachedInfo = null;
  }

  /**
   * One-time scan of completed retarget periods to recover a threshold-based
   * lock-in that occurred before this process started. `lockedInHeight` is held
   * in memory only, so without this a restart would forget an earlier lock-in
   * until the next retarget boundary or the mandatory backstop.
   *
   * Counts are gated to blocks at/after the deployment starttime so unrelated
   * historical use of version bit 4 cannot be miscounted as signaling.
   */
  private async $scanForLockIn(currentHeight: number): Promise<void> {
    if (this.lockInScanned || this.lockedInHeight != null || this.scanning) {
      return;
    }
    if (config.DATABASE.ENABLED !== true) {
      this.lockInScanned = true; // nothing to scan without the DB
      return;
    }
    this.scanning = true;
    try {
      const startHeight = await BlocksRepository.$getFirstBlockHeightAtOrAfterTimestamp(STARTTIME);
      if (startHeight != null) {
        // First full retarget period boundary at/after the deployment start.
        let periodStart = Math.ceil(startHeight / RETARGET_PERIOD) * RETARGET_PERIOD;
        // Newest fully-completed retarget period (its last block exists on chain).
        const lastCompletePeriodStart =
          Math.floor((currentHeight - (RETARGET_PERIOD - 1)) / RETARGET_PERIOD) * RETARGET_PERIOD;

        for (; periodStart <= lastCompletePeriodStart && periodStart < MANDATORY_LOCK_IN_HEIGHT; periodStart += RETARGET_PERIOD) {
          const periodEnd = periodStart + RETARGET_PERIOD - 1;
          const signaling = await BlocksRepository.$countSignalingBlocks(periodStart, periodEnd, SIGNALING_BIT);
          if (signaling >= THRESHOLD) {
            this.lockedInHeight = periodStart + RETARGET_PERIOD; // start of the next period
            logger.info(`BIP-110: Historical threshold met in period [${periodStart}, ${periodEnd}] (${signaling}/${RETARGET_PERIOD}). LOCKED_IN at ${this.lockedInHeight}.`);
            this.cachedInfo = null;
            this.lastHeight = -1;
            break;
          }
        }
      }
      this.lockInScanned = true; // completed (whether or not a lock-in was found)
    } catch (e) {
      // Leave it unscanned so a later call retries; live detection and the
      // mandatory backstop still apply. (query errors are logged in the repository)
      logger.warn(`BIP-110: lock-in scan failed, will retry. Reason: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Refresh the cached DB-backed signaling count for a retarget period.
   * Guarded so overlapping reads don't issue a query storm.
   */
  private async $refreshSignaling(periodStart: number, currentHeight: number): Promise<void> {
    if (this.refreshing) {
      return;
    }
    this.refreshing = true;
    try {
      const count = await this.$getSignaling(periodStart, currentHeight);
      this.periodSignalingCache = { periodStart, count };
      // Invalidate so the next read reflects the accurate count.
      this.cachedInfo = null;
      this.lastHeight = -1;
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Count bit-4 signaling blocks in [periodStart, currentHeight]. Uses the
   * database (full retarget period) when indexing is enabled, otherwise falls
   * back to the limited in-memory block cache.
   */
  private async $getSignaling(periodStart: number, currentHeight: number): Promise<number> {
    if (config.DATABASE.ENABLED === true) {
      try {
        return await BlocksRepository.$countSignalingBlocks(periodStart, currentHeight, SIGNALING_BIT);
      } catch (e) {
        // Fall through to the in-memory count; the repository already logged it.
      }
    }
    return this.countSignalingInCurrentPeriod(periodStart, currentHeight);
  }

  /**
   * Count signaling blocks in the current retarget period using the in-memory
   * block cache. Note: this cache only holds the most recent blocks, so it
   * under-counts a full 2016-block period; it is a fallback only.
   */
  private countSignalingInCurrentPeriod(periodStart: number, currentHeight: number): number {
    const cachedBlocks = blocks.getBlocks();
    let count = 0;
    for (const block of cachedBlocks) {
      if (block.height >= periodStart && block.height <= currentHeight) {
        if (Common.isSignalingBIP110(block.version)) {
          count++;
        }
      }
    }
    return count;
  }
}

export default new Bip110DeploymentApi();
