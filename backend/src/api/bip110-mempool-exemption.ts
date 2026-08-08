import logger from '../logger';
import bitcoinClient from './bitcoin/bitcoin-client';
import { Common } from './common';
import { TransactionExtended } from '../mempool.interfaces';
import { bip110Context } from './bip110-params';

/**
 * Resolves the spec's pre-activation UTXO exemption for *unconfirmed* transactions.
 *
 * Confirmed blocks get prevout heights for free from `getblock` verbosity 3. Mempool
 * transactions do not: the Esplora/Electrum shapes carry a prevout's scriptPubKey but
 * never its confirmation height, so without a lookup we cannot tell an input spending a
 * pre-activation UTXO (exempt, therefore valid) from one spending a recent UTXO
 * (genuinely invalid). Calling the first case invalid is the most common false
 * accusation available — spending old coins is the normal case.
 *
 * Cost is bounded by design:
 *   - only runs while the rules are actually enforced;
 *   - only for transactions the detector already flagged, which are rare;
 *   - results are cached by outpoint, since mempool transactions are re-evaluated on
 *     every mempool update;
 *   - on an enforcing node a violating transaction cannot enter the mempool at all, so
 *     in practice this path only ever runs on non-enforcing nodes.
 *
 * A failed lookup yields `null`, which callers must treat as "unverified" rather than
 * as a violation.
 */

/** Cap the outpoint cache so a flood of flagged transactions can't grow it unbounded */
const MAX_CACHE_ENTRIES = 50000;

class Bip110MempoolExemption {
  /** `${txid}:${vout}` -> confirmation height of the prevout (or null if unknown) */
  private heights: Map<string, number | null> = new Map();
  /** Outpoints currently being looked up, so concurrent callers share one RPC */
  private inflight: Map<string, Promise<number | null>> = new Map();

  /**
   * Re-evaluate a flagged mempool transaction with prevout heights resolved.
   *
   * Returns the exemption-aware flags plus a confidence marker. Returns `null` when the
   * transaction needs no re-evaluation (not flagged, or rules not in force), so callers
   * can skip the work entirely.
   */
  public async $resolveFlags(tx: TransactionExtended): Promise<{ flags: bigint, confidence: 'exact' | 'degraded' } | null> {
    const activationHeight = bip110Context.getActivationHeight();
    const ctx = bip110Context.get();
    if (activationHeight == null || ctx == null) {
      return null;
    }
    // An unconfirmed transaction can only be mined into the NEXT block, so judge it
    // against tip + 1. Using the tip itself would leave the last block before activation
    // treating soon-to-be-invalid transactions as merely hypothetical.
    if (!bip110Context.isEnforcedHeight(ctx.currentTipHeight + 1)) {
      return null;
    }
    if (!Common.hasAnyBIP110Violation(tx.flags)) {
      return null;
    }

    const prevoutHeights: (number | null)[] = [];
    let anyUnknown = false;
    for (const vin of tx.vin) {
      if (vin.is_coinbase) {
        prevoutHeights.push(null);
        continue;
      }
      const height = await this.$getPrevoutHeight(vin.txid, vin.vout);
      if (height == null) {
        anyUnknown = true;
      }
      prevoutHeights.push(height);
    }

    const flags = Common.getBIP110Flags(tx, { activationHeight, prevoutHeights });
    return { flags, confidence: anyUnknown ? 'degraded' : 'exact' };
  }

  /**
   * Confirmation height of an outpoint, or null if it can't be determined.
   *
   * `gettxout` must be called with include_mempool = FALSE here. With it true, the node
   * applies the mempool's view — in which this very transaction already spends the
   * output — and returns null for exactly the outpoints we need to resolve. Verified
   * against a live node: the same outpoint returns null with true and confirmations=1
   * with false.
   *
   * An unconfirmed prevout (a mempool chain, so absent from the confirmed UTXO set)
   * resolves to null and is treated as unverifiable rather than exempt — it cannot
   * predate activation, so it is never wrongly excused.
   */
  private async $getPrevoutHeight(txid: string, vout: number): Promise<number | null> {
    const key = `${txid}:${vout}`;
    if (this.heights.has(key)) {
      return this.heights.get(key) ?? null;
    }
    const existing = this.inflight.get(key);
    if (existing) {
      return existing;
    }

    const lookup = (async (): Promise<number | null> => {
      try {
        const txOut = await bitcoinClient.getTxOut(txid, vout, false);
        if (!txOut) {
          return null;
        }
        const confirmations = txOut.confirmations ?? 0;
        if (confirmations <= 0) {
          // Present in the UTXO set but unconfirmed: cannot predate activation, so it is
          // definitively not exempt (rather than unknown).
          return Number.MAX_SAFE_INTEGER;
        }
        const tipHeight = bip110Context.get()?.currentTipHeight;
        if (tipHeight == null) {
          return null;
        }
        return tipHeight - confirmations + 1;
      } catch (e) {
        logger.debug(`BIP-110: prevout height lookup failed for ${key}: ${e instanceof Error ? e.message : e}`);
        return null;
      }
    })();

    this.inflight.set(key, lookup);
    try {
      const height = await lookup;
      if (this.heights.size >= MAX_CACHE_ENTRIES) {
        this.heights.clear();
      }
      this.heights.set(key, height);
      return height;
    } finally {
      this.inflight.delete(key);
    }
  }

  /** Drop cached heights (e.g. after a reorg changes confirmation counts) */
  public clear(): void {
    this.heights.clear();
  }
}

export default new Bip110MempoolExemption();
