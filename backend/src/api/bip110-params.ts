import config from '../config';

/**
 * BIP-110 deployment parameters and the canonical window predicates.
 *
 * Every module that needs to know "is this height enforced?" asks here, so the
 * definitions can never drift between the deployment tracker, the violation scanner
 * and the API layer. Values come from config (defaults are the bip-0110.mediawiki
 * constants) so the whole activation timeline can be exercised on regtest or against
 * shifted mainnet heights before it happens for real.
 */

export const RETARGET_PERIOD = 2016;

export const BIP110_PARAMS = {
  get mandatorySignalingStart(): number { return config.BIP110.HEIGHTS.MANDATORY_SIGNALING_START; },
  get mandatoryLockIn(): number { return config.BIP110.HEIGHTS.MANDATORY_LOCK_IN; },
  get maxActivationHeight(): number { return config.BIP110.HEIGHTS.MAX_ACTIVATION_HEIGHT; },
  get activeDuration(): number { return config.BIP110.HEIGHTS.ACTIVE_DURATION; },
  get threshold(): number { return config.BIP110.HEIGHTS.THRESHOLD; },
  get startTime(): number { return config.BIP110.HEIGHTS.START_TIME; },
  get signalingBit(): number { return config.BIP110.HEIGHTS.SIGNALING_BIT; },
  get scanFloor(): number { return config.BIP110.HEIGHTS.SCAN_FLOOR; },
  get strictVerdicts(): boolean { return config.BIP110.STRICT_VERDICTS !== false; },
};

export type Bip110State = 'defined' | 'started' | 'locked_in' | 'active' | 'expired';

export type Bip110NodeSupport = 'enforcing' | 'not-enforcing' | 'unknown';

export type Bip110ChainVerdict = 'compliant' | 'divergent' | 'unknown';

export type Bip110DivergenceReason = 'non-signaling' | 'violating-transactions';

/**
 * Everything the UI needs in order to decide what a block means.
 * Mirrored in the frontend at interfaces/node-api.interface.ts.
 */
export interface Bip110EnforcementContext {
  nodeSupport: Bip110NodeSupport;
  nodeSupportSource: 'getdeploymentinfo' | 'getblockchaininfo' | 'config' | 'unknown';
  nodeSubversion: string | null;
  /** Chain tip this context was computed for; unconfirmed txs are judged against it */
  currentTipHeight: number;

  state: Bip110State;
  stateSource: 'node' | 'computed';
  lockInHeight: number | null;
  activationHeight: number | null;
  expiryHeight: number | null;

  /** null when lock-in happened before the mandatory window, i.e. it never applied */
  mandatoryWindow: { start: number; end: number } | null;

  chainVerdict: Bip110ChainVerdict;
  firstDivergenceHeight: number | null;
  divergenceReason: Bip110DivergenceReason | null;

  /** Honours the STRICT_VERDICTS kill switch; when false the UI must stay conditional */
  strictVerdicts: boolean;
}

/**
 * The mandatory-signaling window was actually in force at height h.
 * A null window (lock-in before the window opened) means it never applied.
 */
export function inMandatoryWindow(height: number, ctx: Pick<Bip110EnforcementContext, 'mandatoryWindow'>): boolean {
  const w = ctx.mandatoryWindow;
  return w != null && height >= w.start && height <= w.end;
}

/**
 * The BIP-110 transaction rules are enforced for a block at height h.
 * Half-open: the block AT expiryHeight is the first block NOT enforced.
 */
export function inEnforcementWindow(height: number, ctx: Pick<Bip110EnforcementContext, 'activationHeight' | 'expiryHeight'>): boolean {
  if (ctx.activationHeight == null || height < ctx.activationHeight) {
    return false;
  }
  return ctx.expiryHeight == null || height < ctx.expiryHeight;
}

/**
 * The rules are known to be coming but are not yet enforced at h.
 */
export function pendingEnforcement(height: number, ctx: Pick<Bip110EnforcementContext, 'activationHeight' | 'lockInHeight'>): boolean {
  return ctx.activationHeight != null && height < ctx.activationHeight
      && ctx.lockInHeight != null && height >= ctx.lockInHeight;
}

/**
 * Derive the mandatory-signaling window from a known lock-in height.
 * Returns null if lock-in happened at or before the window would have opened, since
 * "mandatory signaling ends once the deployment reaches the LOCKED_IN state".
 */
export function deriveMandatoryWindow(lockInHeight: number | null): { start: number; end: number } | null {
  const start = BIP110_PARAMS.mandatorySignalingStart;
  const backstop = BIP110_PARAMS.mandatoryLockIn;
  if (lockInHeight != null && lockInHeight <= start) {
    return null;
  }
  const end = (lockInHeight != null ? Math.min(lockInHeight, backstop) : backstop) - 1;
  return { start, end };
}

/**
 * Activation height for a given lock-in height: the start of the next retarget period.
 */
export function activationHeightFor(lockInHeight: number): number {
  const periodStart = lockInHeight - (lockInHeight % RETARGET_PERIOD);
  return periodStart + RETARGET_PERIOD;
}

/**
 * Holder for the latest enforcement context.
 *
 * `bip110-deployment` computes it and publishes here; `blocks` and the API layer read
 * it. Going through a store rather than importing the deployment module directly keeps
 * blocks <-> deployment from becoming a circular import (the deployment tracker already
 * imports blocks for the chain tip).
 */
class Bip110ContextStore {
  private context: Bip110EnforcementContext | null = null;

  set(context: Bip110EnforcementContext): void {
    this.context = context;
  }

  get(): Bip110EnforcementContext | null {
    return this.context;
  }

  /** Activation height if known, else null. Convenience for the hot paths. */
  getActivationHeight(): number | null {
    return this.context?.activationHeight ?? null;
  }

  /** Whether BIP-110 transaction rules apply to a block at this height. */
  isEnforcedHeight(height: number): boolean {
    return this.context != null && inEnforcementWindow(height, this.context);
  }
}

export const bip110Context = new Bip110ContextStore();
