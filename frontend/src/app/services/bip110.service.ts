import { Injectable } from '@angular/core';
import { Bip110EnforcementContext } from '@interfaces/node-api.interface';

/** Severity of a block's BIP-110 status. Ordered least to most serious. */
export type Bip110Severity = 'none' | 'hypothetical' | 'pending' | 'uncertain' | 'invalid';

export type Bip110Milestone = 'mandatory-start' | 'lock-in' | 'activation' | 'expiry';

export interface BlockVerdict {
  /** Block signals bit 4 — independent of severity, never suppressed by it */
  signaling: boolean;
  severity: Bip110Severity;
  reason: 'non-signaling' | 'violating-transactions' | null;
  milestone: Bip110Milestone | null;
  /** 'degraded' means the exemption could not be evaluated for this block */
  statsConfidence: 'exact' | 'degraded';
  /** Violating transaction count, as reported */
  violationCount: number;
}

/** Minimal shape a block needs for a verdict */
export interface VerdictBlockInput {
  height: number;
  version?: number;
  violationCount?: number | null;
  statsConfidence?: 'exact' | 'degraded' | null;
}

/**
 * BIP110 (Reduced Data Temporary Softfork) Service
 * 
 * Provides utilities for detecting and displaying BIP110-related information:
 * - Miner signaling detection (deployment 'reduced_data', version bit 4, 55% threshold)
 * - Transaction violation flags for all 7 BIP110 consensus rules
 * 
 * See bip-0110.mediawiki for the full specification.
 * 
 * NOTE: Uses BigInt for all flag operations because flags use bits 35-41,
 * which exceed JavaScript's 32-bit limit for bitwise operators.
 */
@Injectable({
  providedIn: 'root'
})
export class Bip110Service {
  
  // BIP110 flag bit positions (must match backend TransactionFlags)
  // Using bits 35-41 - MUST use BigInt for proper bitwise operations
  static readonly FLAGS = {
    LARGE_SCRIPTPUBKEY:  0x08_00_00_00_00n,  // bit 35 - Rule 1: scriptPubKey > 34 bytes (OP_RETURN > 83)
    LARGE_PUSHDATA:      0x10_00_00_00_00n,  // bit 36 - Rule 2: PUSHDATA*/witness element > 256 bytes
    UNDEFINED_WITNESS:   0x20_00_00_00_00n,  // bit 37 - Rule 3: Spending undefined witness version (not v0/v1/P2A)
    TAPROOT_ANNEX:       0x40_00_00_00_00n,  // bit 38 - Rule 4: Witness stack with Taproot annex
    LARGE_CONTROL_BLOCK: 0x80_00_00_00_00n,  // bit 39 - Rule 5: Taproot control block > 257 bytes
    OP_SUCCESS:          0x01_00_00_00_00_00n,  // bit 40 - Rule 6: OP_SUCCESS* in tapscript (even unexecuted)
    OP_IF_NOTIF:         0x02_00_00_00_00_00n,  // bit 41 - Rule 7: OP_IF/OP_NOTIF executing in tapscript
  };

  // Combined mask for any BIP110 violation (BigInt)
  static readonly ANY_VIOLATION_MASK: bigint = 
    Bip110Service.FLAGS.LARGE_SCRIPTPUBKEY |
    Bip110Service.FLAGS.LARGE_PUSHDATA |
    Bip110Service.FLAGS.UNDEFINED_WITNESS |
    Bip110Service.FLAGS.TAPROOT_ANNEX |
    Bip110Service.FLAGS.LARGE_CONTROL_BLOCK |
    Bip110Service.FLAGS.OP_SUCCESS |
    Bip110Service.FLAGS.OP_IF_NOTIF;
  
  // BIP110 deployment 'reduced_data' signaling version bit (55% threshold: 1109/2016 blocks)
  static readonly VERSION_BIT = 4;

  /**
   * Convert flags to BigInt for proper bitwise operations
   */
  private static toBigInt(flags: number | bigint | undefined): bigint {
    if (flags === undefined || flags === null) return 0n;
    return typeof flags === 'bigint' ? flags : BigInt(flags);
  }

  /**
   * Check if transaction flags indicate any BIP110 violation (static version)
   */
  static hasAnyViolation(flags: number | bigint | undefined): boolean {
    if (flags === undefined || flags === null) return false;
    const bigFlags = Bip110Service.toBigInt(flags);
    return (bigFlags & Bip110Service.ANY_VIOLATION_MASK) !== 0n;
  }

  /**
   * Get human-readable list of BIP110 violations from flags (static version).
   *
   * `severity` selects the leading icon so the rule list matches the surrounding
   * verdict: ⛔ where the rules are actually enforced, ⚠️ everywhere else. Defaults to
   * the conditional icon, so a caller that hasn't got a verdict can never accidentally
   * present a hypothetical as a consensus failure.
   */
  static getViolationLabels(flags: number | bigint | undefined, severity: Bip110Severity = 'hypothetical'): string[] {
    if (flags === undefined || flags === null) return [];
    const bigFlags = Bip110Service.toBigInt(flags);
    const icon = severity === 'invalid' ? '⛔' : '⚠️';
    const violations: string[] = [];

    if (bigFlags & Bip110Service.FLAGS.LARGE_SCRIPTPUBKEY) {
      violations.push(`${icon} Rule 1: Large scriptPubKey (>34 bytes)`);
    }
    if (bigFlags & Bip110Service.FLAGS.LARGE_PUSHDATA) {
      violations.push(`${icon} Rule 2: Large PUSHDATA/witness element (>256 bytes)`);
    }
    if (bigFlags & Bip110Service.FLAGS.UNDEFINED_WITNESS) {
      violations.push(`${icon} Rule 3: Spending undefined witness version (not v0/v1/P2A)`);
    }
    if (bigFlags & Bip110Service.FLAGS.TAPROOT_ANNEX) {
      violations.push(`${icon} Rule 4: Taproot annex present`);
    }
    if (bigFlags & Bip110Service.FLAGS.LARGE_CONTROL_BLOCK) {
      violations.push(`${icon} Rule 5: Large control block (>257 bytes)`);
    }
    if (bigFlags & Bip110Service.FLAGS.OP_SUCCESS) {
      violations.push(`${icon} Rule 6: OP_SUCCESS* in tapscript`);
    }
    if (bigFlags & Bip110Service.FLAGS.OP_IF_NOTIF) {
      violations.push(`${icon} Rule 7: OP_IF/OP_NOTIF executing in tapscript`);
    }

    return violations;
  }

  /**
   * Explanatory note for a transaction whose rule matches could not be confirmed.
   *
   * Post-activation this is the single most likely thing to confuse someone: a
   * transaction with a large witness push and no warning is not a bug, it is the
   * exemption working. Say so explicitly rather than leaving silence to be interpreted.
   */
  static readonly EXEMPT_NOTE = 'Inputs spending UTXOs created before the activation height are '
    + 'exempt from the BIP-110 rules and remain valid.';

  /**
   * Check if transaction flags indicate any BIP110 violation (instance method)
   */
  hasAnyViolation(flags: number | bigint): boolean {
    return Bip110Service.hasAnyViolation(flags);
  }

  /**
   * Get human-readable list of BIP110 violations from flags (instance method)
   */
  getViolations(flags: number | bigint): string[] {
    return Bip110Service.getViolationLabels(flags);
  }

  /**
   * Check if block version signals BIP110 support
   */
  isSignaling(version: number): boolean {
    return (version & (1 << Bip110Service.VERSION_BIT)) !== 0;
  }

  /**
   * Get violation count from flags
   */
  getViolationCount(flags: number | bigint): number {
    return this.getViolations(flags).length;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Canonical predicates — defined once, used everywhere
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * The mandatory-signaling window was actually in force at this height.
   *
   * Not a bare height range: per spec, "mandatory signaling ends once the deployment
   * reaches the LOCKED_IN state". A null window means lock-in happened before the window
   * would have opened, so mandatory signaling never applied and non-signaling blocks in
   * that range are perfectly valid.
   */
  static inMandatoryWindow(height: number, ctx: Bip110EnforcementContext | null): boolean {
    const w = ctx?.mandatoryWindow;
    return !!w && height >= w.start && height <= w.end;
  }

  /**
   * The BIP-110 transaction rules are enforced for a block at this height.
   * Half-open: the block AT expiryHeight is the first block NOT enforced.
   */
  static inEnforcementWindow(height: number, ctx: Bip110EnforcementContext | null): boolean {
    if (!ctx || ctx.activationHeight == null || height < ctx.activationHeight) {
      return false;
    }
    return ctx.expiryHeight == null || height < ctx.expiryHeight;
  }

  /** Rules are known to be coming but are not yet enforced at this height. */
  static pendingEnforcement(height: number, ctx: Bip110EnforcementContext | null): boolean {
    if (!ctx || ctx.activationHeight == null || ctx.lockInHeight == null) {
      return false;
    }
    return height < ctx.activationHeight && height >= ctx.lockInHeight;
  }

  /** Which deployment milestone, if any, falls on this height. */
  static milestoneAt(height: number, ctx: Bip110EnforcementContext | null): Bip110Milestone | null {
    if (!ctx) {
      return null;
    }
    // Suppressed entirely when the window never applied
    if (ctx.mandatoryWindow && height === ctx.mandatoryWindow.start) {
      return 'mandatory-start';
    }
    if (ctx.lockInHeight != null && height === ctx.lockInHeight) {
      return 'lock-in';
    }
    if (ctx.activationHeight != null && height === ctx.activationHeight) {
      return 'activation';
    }
    if (ctx.expiryHeight != null && height === ctx.expiryHeight) {
      return 'expiry';
    }
    return null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // blockVerdict — the single source of truth for colour and wording
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Classify a block. Severity is decided by the FIRST matching rule; the ordering is
   * the specification, not an implementation detail, because several conditions overlap:
   *
   *   1. non-signaling inside a live mandatory window  -> invalid
   *   2. no violations recorded                        -> none
   *   3. degraded data, or contradicts an enforcing node -> uncertain
   *   4. in the enforcement window with violations     -> invalid
   *   5. locked in but not yet active                  -> pending
   *   6. otherwise                                     -> hypothetical
   *
   * Rule 1 precedes rule 2 deliberately: a non-signaling block in the mandatory window is
   * invalid regardless of what it contains. Rule 3 precedes rule 4 deliberately: we never
   * escalate to red on data we don't trust.
   *
   * `signaling` and `milestone` are independent and compose on top; neither suppresses
   * a severity.
   */
  static blockVerdict(block: VerdictBlockInput, ctx: Bip110EnforcementContext | null): BlockVerdict {
    const height = block.height;
    const signaling = block.version != null
      ? (Number(block.version) & (1 << Bip110Service.VERSION_BIT)) !== 0
      : false;
    const violationCount = block.violationCount ?? 0;
    const statsConfidence = block.statsConfidence ?? 'exact';
    const milestone = Bip110Service.milestoneAt(height, ctx);

    const base: BlockVerdict = {
      signaling,
      severity: 'none',
      reason: null,
      milestone,
      statsConfidence,
      violationCount,
    };

    // The kill switch caps everything at 'hypothetical' so a misfiring detector can be
    // defused without a code deploy. Telling a user their chain is invalid when it isn't
    // is far worse than under-reporting.
    const strict = ctx?.strictVerdicts !== false;

    // Rule 1 — mandatory signaling
    if (Bip110Service.inMandatoryWindow(height, ctx) && !signaling) {
      return strict
        ? { ...base, severity: 'invalid', reason: 'non-signaling' }
        : { ...base, severity: 'hypothetical', reason: 'non-signaling' };
    }

    // Rule 2 — nothing to report
    if (violationCount <= 0) {
      return base;
    }

    const enforced = Bip110Service.inEnforcementWindow(height, ctx);

    // Rule 3 — never escalate on data we don't trust.
    // An enforcing node cannot have accepted an invalid block, so a hit here means our
    // detector is wrong (or the inputs are exempt), not that consensus failed.
    if (enforced && (statsConfidence === 'degraded' || ctx?.nodeSupport === 'enforcing')) {
      return { ...base, severity: 'uncertain', reason: 'violating-transactions' };
    }

    // Rule 4 — genuinely invalid
    if (enforced && strict) {
      return { ...base, severity: 'invalid', reason: 'violating-transactions' };
    }

    // Rule 5 — locked in, not yet active
    if (Bip110Service.pendingEnforcement(height, ctx)) {
      return { ...base, severity: 'pending', reason: 'violating-transactions' };
    }

    // Rule 6 — conditional / historical
    return { ...base, severity: 'hypothetical', reason: 'violating-transactions' };
  }

  /** CSS class for a verdict's severity (all amber severities share one class). */
  static severityClass(severity: Bip110Severity): string | null {
    switch (severity) {
      case 'invalid': return 'bip110-invalid';
      case 'hypothetical':
      case 'pending':
      case 'uncertain': return 'bip110-violations';
      default: return null;
    }
  }

  /**
   * Human-readable summary of a block's BIP-110 status, in the right tense.
   */
  static blockTooltip(verdict: BlockVerdict, ctx: Bip110EnforcementContext | null): string {
    const n = verdict.violationCount;
    const txs = `${n} transaction${n === 1 ? '' : 's'}`;
    switch (verdict.severity) {
      case 'invalid':
        return verdict.reason === 'non-signaling'
          ? 'This block is invalid under BIP-110: it does not signal during the mandatory signaling period'
          : `This block is invalid under BIP-110: it contains ${txs} that violate the consensus rules`;
      case 'uncertain':
        return `This block contains ${txs} matching BIP-110 rules, but the spending inputs could not be verified `
          + '— they may spend UTXOs created before activation, which are exempt';
      case 'pending':
        return `This block contains ${txs} that will be invalid once BIP-110 activates`
          + (ctx?.activationHeight != null ? ` at block ${ctx.activationHeight}` : '');
      case 'hypothetical':
        return ctx && ctx.expiryHeight != null && verdict.milestone == null && ctx.state === 'expired'
          ? `This block contains ${txs} that would have been invalid while the BIP-110 rules were enforced`
          : `This block contains ${txs} that would be invalid under BIP-110`;
      default:
        return '';
    }
  }

  /** Label for a milestone block's gold ribbon. */
  static milestoneLabel(milestone: Bip110Milestone, ctx: Bip110EnforcementContext | null): string {
    switch (milestone) {
      case 'mandatory-start': return 'Mandatory signaling begins';
      case 'lock-in': return ctx?.mandatoryWindow == null
        ? 'Locked in — mandatory signaling not required'
        : 'BIP-110 locked in';
      case 'activation': return 'BIP-110 active — rules enforced from here';
      case 'expiry': return 'BIP-110 rules expired';
      default: return '';
    }
  }
}
