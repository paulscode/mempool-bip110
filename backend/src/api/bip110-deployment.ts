import logger from '../logger';
import blocks from './blocks';
import { Common } from './common';
import config from '../config';
import BlocksRepository from '../repositories/BlocksRepository';
import { bitcoinCoreApi } from './bitcoin/bitcoin-api-factory';
import bip110Cache from './bip110-cache';
import bip110NodeSupport from './bip110-node-support';
import {
  BIP110_PARAMS,
  Bip110ChainVerdict,
  Bip110DivergenceReason,
  Bip110EnforcementContext,
  Bip110State,
  RETARGET_PERIOD,
  activationHeightFor,
  bip110Context,
  deriveMandatoryWindow,
} from './bip110-params';

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
// Height parameters live in config (defaults are the spec values) so the whole
// activation timeline can be exercised on regtest or against shifted mainnet heights.
const SIGNALING_REFRESH_INTERVAL_MS = 30000;      // re-poll the signaling count while block indexing back-fills
const RECENT_SIGNALING_LIMIT = 25;                // how many recent signaling blocks to surface in the UI

export type { Bip110State };

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

  /** Most recent BIP-110 signaling blocks in the current period (newest first) */
  recentSignalingBlocks: { height: number; time: number }[];

  // ── Mandatory signaling ─────────────────────────────────────────────────
  /** Blocks in the mandatory window that failed to signal (0 unless the chain diverged) */
  mandatoryNonSignalingCount: number;
  /** Height at which lock-in occurred / will occur, when known */
  lockInHeight: number | null;

  /** Node enforcement + chain compliance context (see bip110-params.ts) */
  enforcement: Bip110EnforcementContext;
}

class Bip110DeploymentApi {
  private cachedInfo: Bip110DeploymentInfo | null = null;
  private lastHeight: number = -1;
  /** Violation-stats version the cached info was computed against */
  private lastStatsVersion: number = -1;
  /** Height at which LOCKED_IN was entered (if we know it) */
  private lockedInHeight: number | null = null;
  /** Published signaling count for the current retarget period */
  private periodSignalingCache: { periodStart: number; count: number } | null = null;
  /** height -> signaling, fetched cheaply from block headers for the current period */
  private periodSignals: Map<number, boolean> = new Map();
  /** height -> block timestamp, for signaling blocks in the current period */
  private signalingTimes: Map<number, number> = new Map();
  private periodSignalsStart: number = -1;
  /** Guard against overlapping header fills */
  private fillingSignals: boolean = false;
  /** Whether the one-time historical lock-in scan has completed */
  private lockInScanned: boolean = false;
  /** Guard against overlapping lock-in scans */
  private scanning: boolean = false;
  /** Set once the deployment locks in and per-period signaling stops mattering */
  private signalingRefreshStopped: boolean = false;
  /** Guard against overlapping mandatory-window seals */
  private sealingWindow: boolean = false;
  /** Listeners notified when the published deployment info materially changes */
  private changeCallbacks: (() => void)[] = [];
  /** Fingerprint of the last info we announced, to avoid redundant broadcasts */
  private lastAnnounced: string = '';

  constructor() {
    // The signaling count is read from the indexed `blocks` table, which the
    // block indexer back-fills over time (tip-downward). Re-poll periodically so
    // the count climbs as indexing progresses, rather than only updating when a
    // new block arrives. The timer is unref'd so it never holds the process open.
    const timer = setInterval(() => { void this.$periodicRefresh(); }, SIGNALING_REFRESH_INTERVAL_MS);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  /**
   * Periodic background refresh of the current period's signaling count.
   *
   * Stops once the deployment reaches LOCKED_IN: from then on the count has no
   * consensus meaning, and re-walking up to 2016 block headers every 30 seconds for the
   * rest of the app's life is pure waste.
   */
  private async $periodicRefresh(): Promise<void> {
    const currentHeight = blocks.getCurrentBlockHeight();
    if (currentHeight < 0) {
      return;
    }

    // Publish the enforcement context on every tick, before any early return.
    //
    // Computing it is the only thing that publishes it, and until now that happened
    // solely as a side effect of the websocket handler asking for deployment info — on
    // client connect or on a new block. With no clients connected and no block for ten
    // minutes, the block scanner and the real-time block path would both run against a
    // null context, i.e. not knowing whether the rules apply to the height in front of
    // them. Post lock-in the early return below made that permanent.
    this.getDeploymentInfo();

    if (this.signalingRefreshStopped) {
      return;
    }
    const state = this.computeState(currentHeight);
    if (state !== 'defined' && state !== 'started') {
      // Seal the mandatory window before shutting the refresh off — the divergence
      // detection depends on this data, and once the header map stops being filled
      // there is no other cheap source for it.
      //
      // Only stop once the seal has actually succeeded. Sealing bails out and retries
      // when block data is temporarily incomplete, so unconditionally stopping here
      // would strand the window permanently unverified after a single failed attempt.
      await this.$sealMandatoryWindowIfNeeded(currentHeight);
      if (bip110Cache.getMandatorySeal().sealed) {
        this.signalingRefreshStopped = true;
        logger.info('BIP-110: deployment locked in — stopping periodic signaling refresh');
      }
      return;
    }
    const periodStart = currentHeight - (currentHeight % RETARGET_PERIOD);
    await this.$fillPeriodSignals(periodStart, currentHeight);
    await this.$sealMandatoryWindowIfNeeded(currentHeight);
  }

  /**
   * Record the outcome of the mandatory-signaling window, once, while the data is
   * still cheap to obtain.
   *
   * On an enforcing node every block in the window signals by construction, so this is
   * a no-op. On a non-enforcing node a non-signaling block in the window means the
   * chain has diverged from the BIP-110 chain, which is the single most important thing
   * this app can tell the user.
   */
  private async $sealMandatoryWindowIfNeeded(currentHeight: number): Promise<void> {
    if (bip110Cache.getMandatorySeal().sealed || this.sealingWindow) {
      return;
    }
    const window = deriveMandatoryWindow(this.resolveLockInHeight(currentHeight));
    if (window == null) {
      // Locked in before the window opened: mandatory signaling never applied
      bip110Cache.sealMandatoryWindow(null, 0);
      return;
    }
    if (currentHeight < window.end) {
      return; // window still open — nothing final to record yet
    }

    this.sealingWindow = true;
    try {
      let firstNonSignaling: number | null = null;
      let nonSignalingCount = 0;
      for (let h = window.start; h <= window.end; h++) {
        const signaling = await this.$isSignalingAtHeight(h);
        if (signaling === null) {
          return; // incomplete data — retry on a later refresh rather than record a guess
        }
        if (!signaling) {
          nonSignalingCount++;
          if (firstNonSignaling == null) {
            firstNonSignaling = h;
          }
        }
      }
      bip110Cache.sealMandatoryWindow(firstNonSignaling, nonSignalingCount);
      this.cachedInfo = null;
      this.lastHeight = -1;
    } catch (e) {
      logger.warn(`BIP-110: failed to seal mandatory window, will retry. Reason: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.sealingWindow = false;
    }
  }

  /**
   * Populate the signaling map from the node's `signalling` string.
   *
   * getdeploymentinfo returns one character per block elapsed in the current retarget
   * period ('#' = signals bit 4, '-' = does not), indexed from period_start. The
   * mandatory-signaling window is exactly one retarget period, so while it is open this
   * single field covers it completely.
   *
   * Returns the number of heights filled.
   */
  private applyNodeSignalling(periodStart: number): number {
    const node = bip110NodeSupport.getInfo();
    if (node.support !== 'enforcing' || !node.signalling || node.periodStart == null) {
      return 0;
    }
    if (node.periodStart !== periodStart) {
      return 0; // stale (period rolled over since the last probe) — refreshed on next block
    }
    let filled = 0;
    for (let i = 0; i < node.signalling.length; i++) {
      const height = periodStart + i;
      const signaling = node.signalling[i] === '#';
      if (this.periodSignals.get(height) !== signaling) {
        this.periodSignals.set(height, signaling);
        filled++;
      }
    }
    return filled;
  }

  /**
   * Whether the block at this height signals bit 4. Returns null if it can't be
   * determined right now (so callers can retry rather than record a false negative).
   */
  private async $isSignalingAtHeight(height: number): Promise<boolean | null> {
    const known = this.periodSignals.get(height);
    if (known !== undefined) {
      return known;
    }
    try {
      const hash = await bitcoinCoreApi.$getBlockHash(height);
      const headerHex = await bitcoinCoreApi.$getBlockHeader(hash);
      const version = Buffer.from(headerHex.slice(0, 8), 'hex').readUInt32LE(0);
      return (version & (1 << BIP110_PARAMS.signalingBit)) !== 0;
    } catch (e) {
      return null;
    }
  }

  /**
   * Register a listener for material changes to the deployment info.
   *
   * The websocket layer caches the payload it hands to clients and only refreshes it on
   * a new block. But most of this data settles asynchronously *between* blocks — the
   * signaling map fills over the first minute after startup, and the chain verdict
   * turns as the scanner works. Without this, a divergence detected seconds after
   * startup would not reach the UI until the next block, up to ten minutes later.
   */
  public onChange(cb: () => void): void {
    this.changeCallbacks.push(cb);
  }

  /**
   * Announce the current info if anything a viewer would notice has changed.
   */
  private announceIfChanged(info: Bip110DeploymentInfo): void {
    const fingerprint = [
      info.state, info.periodSignaling, info.periodBlocks, info.mandatoryNonSignalingCount,
      info.inMandatorySignaling, info.lockInHeight, info.activationHeight,
      info.enforcement.chainVerdict, info.enforcement.firstDivergenceHeight,
      info.enforcement.nodeSupport,
    ].join('|');
    if (fingerprint === this.lastAnnounced) {
      return;
    }
    this.lastAnnounced = fingerprint;
    this.changeCallbacks.forEach((cb) => {
      try {
        cb();
      } catch (e) {
        logger.debug(`BIP-110 deployment change callback failed: ${e instanceof Error ? e.message : e}`);
      }
    });
  }

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
    // Recompute on a new tip, and also whenever the background scanner has written new
    // stats — the chain verdict depends on those, so caching purely on height would
    // leave a verdict of 'unknown' frozen until the next block arrived.
    const statsVersion = bip110Cache.getStatsVersion();
    if (currentHeight !== this.lastHeight || statsVersion !== this.lastStatsVersion || !this.cachedInfo) {
      this.cachedInfo = this.computeDeploymentInfo(currentHeight);
      this.lastHeight = currentHeight;
      this.lastStatsVersion = statsVersion;
      this.announceIfChanged(this.cachedInfo);
    }
    return this.cachedInfo;
  }

  /**
   * Compute the full deployment state for a given chain tip height.
   */
  private computeDeploymentInfo(currentHeight: number): Bip110DeploymentInfo {
    const computedState = this.computeState(currentHeight);
    const enforcement = this.buildEnforcementContext(currentHeight, computedState);
    const state = enforcement.state;
    // Publish for blocks.ts and the API layer (avoids a circular import)
    bip110Context.set(enforcement);

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
      void this.$fillPeriodSignals(periodStartHeight, currentHeight);
    }
    const signalingPercent = periodBlocks > 0 ? (periodSignaling / periodBlocks) * 100 : 0;
    const thresholdReached = periodSignaling >= BIP110_PARAMS.threshold;

    // Milestone computations.
    //
    // The mandatory window is NOT a bare height range: per spec, "mandatory signaling
    // ends once the deployment reaches the LOCKED_IN state". If the threshold was met in
    // the period before the window opens, mandatory signaling never applies at all — and
    // treating it as a height range would make the app paint perfectly valid
    // non-signaling blocks red.
    const window = enforcement.mandatoryWindow;
    const inMandatorySignaling = state === 'started'
      && window != null
      && currentHeight >= window.start
      && currentHeight <= window.end;
    const blocksUntilMandatory = (window != null && currentHeight < window.start)
      ? window.start - currentHeight
      : 0;

    const activationHeight = enforcement.activationHeight;
    const expiryHeight = enforcement.expiryHeight;
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
      threshold: BIP110_PARAMS.threshold,
      signalingPercent,
      thresholdReached,
      blocksUntilMandatory,
      inMandatorySignaling,
      activationHeight,
      expiryHeight,
      blocksUntilExpiry,
      rulesExpired,
      recentSignalingBlocks: this.getRecentSignalingBlocks(periodStartHeight, RECENT_SIGNALING_LIMIT),
      mandatoryNonSignalingCount: this.countMandatoryNonSignaling(currentHeight, window),
      lockInHeight: enforcement.lockInHeight,
      enforcement,
    };
  }

  /**
   * Non-signaling blocks seen so far in the mandatory window.
   * Prefers the sealed value; falls back to what the header map currently knows.
   */
  private countMandatoryNonSignaling(currentHeight: number, window: { start: number, end: number } | null): number {
    const seal = bip110Cache.getMandatorySeal();
    if (seal.sealed) {
      return seal.nonSignalingCount;
    }
    if (window == null || currentHeight < window.start) {
      return 0;
    }
    let count = 0;
    const end = Math.min(currentHeight, window.end);
    for (let h = window.start; h <= end; h++) {
      if (this.periodSignals.get(h) === false) {
        count++;
      }
    }
    return count;
  }

  /**
   * The most recent signaling blocks in the current period (newest first).
   */
  private getRecentSignalingBlocks(periodStart: number, limit: number): { height: number; time: number }[] {
    if (this.periodSignalsStart !== periodStart) {
      return [];
    }
    const heights: number[] = [];
    for (const [height, signaling] of this.periodSignals) {
      if (signaling) {
        heights.push(height);
      }
    }
    heights.sort((a, b) => b - a);
    return heights.slice(0, limit).map((height) => ({ height, time: this.signalingTimes.get(height) ?? 0 }));
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
    const { activationHeight, expiryHeight } = this.resolveMilestones(currentHeight);

    if (activationHeight != null) {
      if (expiryHeight != null && currentHeight >= expiryHeight) {
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
    if (latestBlock && latestBlock.timestamp < BIP110_PARAMS.startTime) {
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
   * The effective lock-in height.
   *
   * Preference order:
   *   1. The node's own `since` height when it reports LOCKED_IN or later — it is the
   *      thing actually validating this chain, so its answer is authoritative.
   *   2. A threshold lock-in this process detected or recovered by scanning.
   *   3. The mandatory backstop, once the chain has passed it.
   *
   * The backstop is computed locally rather than stored, so a later discovery of the
   * real (earlier) lock-in height can still take precedence.
   */
  private resolveLockInHeight(currentHeight: number): number | null {
    const node = bip110NodeSupport.getInfo();
    if (node.support === 'enforcing' && node.since != null) {
      if (node.state === 'locked_in') {
        return node.since;
      }
      if (node.state === 'active' || node.state === 'expired') {
        // ACTIVE began one retarget period after lock-in
        return node.since - RETARGET_PERIOD;
      }
      if (node.state === 'started' || node.state === 'defined') {
        return null; // node says it has not locked in — trust that over our backstop
      }
    }

    if (this.lockedInHeight != null) {
      return this.lockedInHeight;
    }
    if (currentHeight >= BIP110_PARAMS.mandatoryLockIn) {
      return BIP110_PARAMS.mandatoryLockIn;
    }
    return null;
  }

  /**
   * The deployment's milestone heights, derived once.
   *
   * Both the state machine and the enforcement context need these, and they must agree:
   * deriving them separately let `computeState` miss the max_activation_height clamp,
   * so the app could report LOCKED_IN while simultaneously treating blocks past the
   * clamped activation as in-scope.
   */
  private resolveMilestones(currentHeight: number): {
    lockInHeight: number | null, activationHeight: number | null, expiryHeight: number | null,
  } {
    const node = bip110NodeSupport.getInfo();
    const lockInHeight = this.resolveLockInHeight(currentHeight);

    // The node's own deployment parameters outrank our configured defaults when it
    // reports them (Knots exposes max_activation_height / active_duration; Core does not).
    const maxActivation = node.support === 'enforcing' && node.maxActivationHeight != null
      ? node.maxActivationHeight
      : BIP110_PARAMS.maxActivationHeight;
    const activeDuration = node.support === 'enforcing' && node.activeDuration != null
      ? node.activeDuration
      : BIP110_PARAMS.activeDuration;

    let activationHeight = lockInHeight != null ? activationHeightFor(lockInHeight) : null;
    if (activationHeight != null && activationHeight > maxActivation) {
      activationHeight = maxActivation;
    }
    const expiryHeight = activationHeight != null ? activationHeight + activeDuration : null;
    return { lockInHeight, activationHeight, expiryHeight };
  }

  /**
   * Build the enforcement context consumed by the UI and by the violation scanner.
   */
  private buildEnforcementContext(currentHeight: number, state: Bip110State): Bip110EnforcementContext {
    const node = bip110NodeSupport.getInfo();
    const { lockInHeight, activationHeight, expiryHeight } = this.resolveMilestones(currentHeight);
    const mandatoryWindow = deriveMandatoryWindow(lockInHeight);

    const nodeState = node.support === 'enforcing' ? node.state : null;
    if (nodeState != null && nodeState !== state) {
      logger.warn(`BIP-110: node reports state '${nodeState}' but local computation says '${state}' — using the node's`);
    }

    const ctx: Bip110EnforcementContext = {
      nodeSupport: node.support,
      nodeSupportSource: node.source,
      nodeSubversion: node.subversion,
      currentTipHeight: currentHeight,
      state: nodeState ?? state,
      stateSource: nodeState != null ? 'node' : 'computed',
      lockInHeight,
      activationHeight,
      expiryHeight,
      mandatoryWindow,
      chainVerdict: 'unknown',
      firstDivergenceHeight: null,
      divergenceReason: null,
      strictVerdicts: BIP110_PARAMS.strictVerdicts,
    };

    const verdict = this.computeChainVerdict(currentHeight, ctx);
    ctx.chainVerdict = verdict.verdict;
    ctx.firstDivergenceHeight = verdict.firstDivergenceHeight;
    ctx.divergenceReason = verdict.reason;

    return ctx;
  }

  /**
   * Does the chain this node is following actually obey BIP-110?
   *
   * This is the observable form of "did BIP-110 succeed?" — the state machine can only
   * ever reach ACTIVE, so the real question is whether the chain in front of us honours
   * the rules. Two ways to answer no: a non-signaling block inside a live mandatory
   * window, or a post-activation block carrying non-exempt violations.
   *
   * 'compliant' requires the in-scope range to be fully scanned. Announcing compliance
   * merely because we haven't looked yet would be the worst kind of wrong.
   */
  private computeChainVerdict(currentHeight: number, ctx: Bip110EnforcementContext): {
    verdict: Bip110ChainVerdict,
    firstDivergenceHeight: number | null,
    reason: Bip110DivergenceReason | null,
  } {
    // 1. Mandatory-signaling divergence (sealed once the window closes)
    const seal = bip110Cache.getMandatorySeal();
    if (seal.sealed && seal.nonSignalingCount > 0) {
      return {
        verdict: 'divergent',
        firstDivergenceHeight: seal.firstNonSignaling,
        reason: 'non-signaling',
      };
    }
    // Live window: check what we have so far without waiting for the seal
    if (ctx.mandatoryWindow != null && currentHeight >= ctx.mandatoryWindow.start) {
      const end = Math.min(currentHeight, ctx.mandatoryWindow.end);
      for (let h = ctx.mandatoryWindow.start; h <= end; h++) {
        if (this.periodSignals.get(h) === false) {
          return { verdict: 'divergent', firstDivergenceHeight: h, reason: 'non-signaling' };
        }
      }
    }

    // 2. Post-activation violations
    if (ctx.activationHeight == null || currentHeight < ctx.activationHeight) {
      return { verdict: 'unknown', firstDivergenceHeight: null, reason: null };
    }
    const rangeEnd = ctx.expiryHeight != null ? Math.min(currentHeight, ctx.expiryHeight - 1) : currentHeight;
    const violationHeights = bip110Cache.getViolationHeightsInRange(ctx.activationHeight, rangeEnd);
    if (violationHeights.length > 0) {
      return {
        verdict: 'divergent',
        firstDivergenceHeight: violationHeights[0],
        reason: 'violating-transactions',
      };
    }

    // 3. Clean — but only claim so once the whole in-scope range has been looked at
    const firstUnscanned = bip110Cache.firstUnscannedInRange(ctx.activationHeight, rangeEnd);
    if (firstUnscanned != null) {
      return { verdict: 'unknown', firstDivergenceHeight: null, reason: null };
    }
    return { verdict: 'compliant', firstDivergenceHeight: null, reason: null };
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

    // Fetch/refresh signaling for the period (cheap: block headers only).
    await this.$fillPeriodSignals(periodStart, height);
    const signaling = this.periodSignalingCache?.periodStart === periodStart
      ? this.periodSignalingCache.count
      : this.countSignalingInCurrentPeriod(periodStart, height);

    // Lock in at the end of a retarget period if the threshold was reached.
    if (this.lockedInHeight == null
        && height % RETARGET_PERIOD === RETARGET_PERIOD - 1
        && signaling >= BIP110_PARAMS.threshold) {
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
      const startHeight = await BlocksRepository.$getFirstBlockHeightAtOrAfterTimestamp(BIP110_PARAMS.startTime);
      if (startHeight != null) {
        // First full retarget period boundary at/after the deployment start.
        let periodStart = Math.ceil(startHeight / RETARGET_PERIOD) * RETARGET_PERIOD;
        // Newest fully-completed retarget period (its last block exists on chain).
        const lastCompletePeriodStart =
          Math.floor((currentHeight - (RETARGET_PERIOD - 1)) / RETARGET_PERIOD) * RETARGET_PERIOD;

        for (; periodStart <= lastCompletePeriodStart && periodStart < BIP110_PARAMS.mandatoryLockIn; periodStart += RETARGET_PERIOD) {
          const periodEnd = periodStart + RETARGET_PERIOD - 1;
          const signaling = await BlocksRepository.$countSignalingBlocks(periodStart, periodEnd, BIP110_PARAMS.signalingBit);
          if (signaling >= BIP110_PARAMS.threshold) {
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
   * Fill the current period's signaling map directly from block headers.
   *
   * The signaling count only needs each block's version (the first 4 bytes of
   * the 80-byte header), which is far cheaper to fetch than the full blocks the
   * normal indexer processes. We fetch only the heights we don't already have,
   * newest-first, with bounded concurrency, publishing the running count after
   * each batch so the UI climbs within seconds instead of waiting for full-block
   * indexing. Failed fetches are simply retried on the next refresh.
   */
  private async $fillPeriodSignals(periodStart: number, currentHeight: number): Promise<void> {
    if (this.fillingSignals) {
      return;
    }
    this.fillingSignals = true;
    try {
      if (this.periodSignalsStart !== periodStart) {
        this.periodSignals.clear();
        this.signalingTimes.clear();
        this.periodSignalsStart = periodStart;
      }

      // Prefer the node's own per-block signaling map: one RPC covers the whole period,
      // versus two header fetches per block. It is also authoritative rather than
      // re-derived, which matters because this data decides whether a block inside the
      // mandatory window gets called invalid.
      this.applyNodeSignalling(periodStart);

      const missing: number[] = [];
      for (let h = currentHeight; h >= periodStart; h--) {
        if (!this.periodSignals.has(h)) {
          missing.push(h);
        }
      }

      if (missing.length === 0) {
        await this.$publishSignaling(periodStart, currentHeight);
        // The node's signaling map has no timestamps, and the UI only surfaces the most
        // recent handful of signaling blocks — so fetch times for just those rather than
        // for every signaling block in the period (which, during mandatory signaling on
        // an enforcing node, would be all 2016 of them).
        await this.$fillRecentSignalingTimes(periodStart, currentHeight);
        return;
      }

      const CONCURRENCY = 8;
      for (let i = 0; i < missing.length; i += CONCURRENCY) {
        const batch = missing.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (h) => {
          try {
            const hash = await bitcoinCoreApi.$getBlockHash(h);
            const headerHex = await bitcoinCoreApi.$getBlockHeader(hash);
            // Block header layout: version(4) | prev(32) | merkle(32) | time(4) | ...
            const version = Buffer.from(headerHex.slice(0, 8), 'hex').readUInt32LE(0);
            const signaling = (version & (1 << BIP110_PARAMS.signalingBit)) !== 0;
            this.periodSignals.set(h, signaling);
            if (signaling) {
              const time = Buffer.from(headerHex.slice(136, 144), 'hex').readUInt32LE(0);
              this.signalingTimes.set(h, time);
            }
          } catch (e) {
            // leave this height unset; it will be retried on the next refresh
          }
        }));
        await this.$publishSignaling(periodStart, currentHeight);
      }
    } finally {
      this.fillingSignals = false;
    }
  }

  /**
   * Fetch block timestamps for the most recent signaling blocks only.
   *
   * Used when the signaling map came from the node (which reports no times). Bounded to
   * the number the UI actually shows, so this stays a handful of RPCs regardless of how
   * many blocks in the period signal.
   */
  private async $fillRecentSignalingTimes(periodStart: number, currentHeight: number): Promise<void> {
    const wanted: number[] = [];
    for (let h = currentHeight; h >= periodStart && wanted.length < RECENT_SIGNALING_LIMIT; h--) {
      if (this.periodSignals.get(h) === true) {
        wanted.push(h);
      }
    }
    const needed = wanted.filter((h) => !this.signalingTimes.has(h));
    if (needed.length === 0) {
      return;
    }
    const CONCURRENCY = 8;
    for (let i = 0; i < needed.length; i += CONCURRENCY) {
      const batch = needed.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (h) => {
        try {
          const hash = await bitcoinCoreApi.$getBlockHash(h);
          const headerHex = await bitcoinCoreApi.$getBlockHeader(hash);
          // Block header layout: version(4) | prev(32) | merkle(32) | time(4) | ...
          const time = Buffer.from(headerHex.slice(136, 144), 'hex').readUInt32LE(0);
          this.signalingTimes.set(h, time);
        } catch (e) {
          // leave unset; retried on the next refresh
        }
      }));
    }
    this.cachedInfo = null;
    this.lastHeight = -1;
  }

  /**
   * Recompute and publish the period's signaling count from all known sources
   * (header map, in-memory recent blocks, and the indexed DB as a fallback),
   * then invalidate the cached info so the next read reflects it.
   */
  private async $publishSignaling(periodStart: number, currentHeight: number): Promise<void> {
    // The node's own count is authoritative when we have it; the derived sources are
    // floors, since each can only under-count (partial header fills, a memory cache that
    // holds only recent blocks, an indexer still back-filling).
    const node = bip110NodeSupport.getInfo();
    if (node.support === 'enforcing' && node.periodStart === periodStart && node.periodSignaling != null) {
      this.periodSignalingCache = { periodStart, count: node.periodSignaling };
      this.cachedInfo = null;
      this.lastHeight = -1;
      return;
    }

    let count = Math.max(
      this.countSignalsInMap(periodStart, currentHeight),
      this.countSignalingInCurrentPeriod(periodStart, currentHeight),
    );
    if (config.DATABASE.ENABLED === true) {
      try {
        count = Math.max(count, await BlocksRepository.$countSignalingBlocks(periodStart, currentHeight, BIP110_PARAMS.signalingBit));
      } catch (e) {
        // DB is a fallback only; ignore failures (logged in the repository)
      }
    }
    this.periodSignalingCache = { periodStart, count };
    this.cachedInfo = null;
    this.lastHeight = -1;
  }

  /**
   * Count signaling blocks in [periodStart, currentHeight] from the header map.
   */
  private countSignalsInMap(periodStart: number, currentHeight: number): number {
    if (this.periodSignalsStart !== periodStart) {
      return 0;
    }
    let count = 0;
    for (const [height, signaling] of this.periodSignals) {
      if (signaling && height >= periodStart && height <= currentHeight) {
        count++;
      }
    }
    return count;
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
