import config from '../config';
import logger from '../logger';
import bitcoinClient from './bitcoin/bitcoin-client';
import { BIP110_PARAMS, Bip110NodeSupport, Bip110State } from './bip110-params';

/**
 * Detects whether the connected Bitcoin node implements and enforces BIP-110.
 *
 * This matters for almost every label in the UI: an "invalid" block cannot exist in the
 * chain of a node that enforces the rules, so seeing one means either the user is on a
 * non-enforcing node (and their chain has diverged from the BIP-110 chain), or our
 * detector is wrong. Guessing wrong in the other direction — telling someone their node
 * accepted an invalid block — is the worst outcome this app can produce.
 *
 * Detection is via getdeploymentinfo (Core v25+), which also gives us the authoritative
 * deployment state, lock-in height and per-period signaling count. Those are strictly
 * better than the app's own re-derivation of the same values, which is blind to an
 * early lock-in when database indexing is disabled and forgets it entirely on restart.
 */

const POLL_INTERVAL_MS = 600000; // 10 minutes — catches a node upgraded underneath us
const DEPLOYMENT_NAME = 'reduced_data';

export interface Bip110NodeInfo {
  support: Bip110NodeSupport;
  source: 'getdeploymentinfo' | 'getblockchaininfo' | 'config' | 'unknown';
  subversion: string | null;
  /** Deployment state as the node reports it, when it reports one */
  state: Bip110State | null;
  /** Height at which the node entered its current state */
  since: number | null;
  /** Whether the node is enforcing the rules right now */
  active: boolean;
  /** Signaling count in the current period, straight from the node */
  periodSignaling: number | null;
  periodElapsed: number | null;
  /** First height of the current retarget period, per the node */
  periodStart: number | null;
  /**
   * Per-block signaling map for the current period: one character per block from
   * periodStart, '#' = signals bit 4, '-' = does not. Authoritative, and a single RPC
   * replaces ~2 header fetches per block across the whole period.
   */
  signalling: string | null;
  /** Deployment parameters as the node itself defines them, when it reports them */
  maxActivationHeight: number | null;
  activeDuration: number | null;
}

class Bip110NodeSupportApi {
  private info: Bip110NodeInfo = {
    support: 'unknown',
    source: 'unknown',
    subversion: null,
    state: null,
    since: null,
    active: false,
    periodSignaling: null,
    periodElapsed: null,
    periodStart: null,
    signalling: null,
    maxActivationHeight: null,
    activeDuration: null,
  };
  private onChangeCallbacks: (() => void)[] = [];
  private polling: boolean = false;
  private started: boolean = false;

  public getInfo(): Bip110NodeInfo {
    return this.info;
  }

  public onChange(cb: () => void): void {
    this.onChangeCallbacks.push(cb);
  }

  /**
   * Begin periodic detection. Safe to call more than once.
   */
  public start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    void this.$refresh();
    const timer = setInterval(() => { void this.$refresh(); }, POLL_INTERVAL_MS);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  /**
   * Re-probe the node. Called on startup, on each new block, and on a timer.
   */
  public async $refresh(): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      const next = await this.$probe();
      if (this.hasChanged(next)) {
        const before = this.info;
        this.info = next;
        if (before.support !== next.support || before.state !== next.state) {
          logger.info(`BIP-110: node support = ${next.support} (via ${next.source})`
            + (next.state ? `, node-reported state = ${next.state}` : ''));
        }
        this.onChangeCallbacks.forEach((cb) => {
          try {
            cb();
          } catch (e) {
            logger.debug(`BIP-110 node support change callback failed: ${e instanceof Error ? e.message : e}`);
          }
        });
      }
    } finally {
      this.polling = false;
    }
  }

  private hasChanged(next: Bip110NodeInfo): boolean {
    const a = this.info;
    return a.support !== next.support
        || a.source !== next.source
        || a.state !== next.state
        || a.since !== next.since
        || a.active !== next.active
        || a.periodSignaling !== next.periodSignaling
        || a.periodElapsed !== next.periodElapsed
        || a.periodStart !== next.periodStart
        || a.signalling !== next.signalling
        || a.maxActivationHeight !== next.maxActivationHeight
        || a.activeDuration !== next.activeDuration;
  }

  private async $probe(): Promise<Bip110NodeInfo> {
    const forced = config.BIP110.ENFORCING;
    const subversion = await this.$getSubversion();

    // An explicit config value wins outright — it exists so an operator can correct us.
    if (forced === true || forced === false) {
      const detected = await this.$probeDeploymentInfo(subversion);
      return {
        ...detected,
        support: forced ? 'enforcing' : 'not-enforcing',
        source: 'config',
      };
    }

    return this.$probeDeploymentInfo(subversion);
  }

  private async $getSubversion(): Promise<string | null> {
    try {
      const netInfo = await bitcoinClient.getNetworkInfo();
      return netInfo?.subversion ?? null;
    } catch (e) {
      return null;
    }
  }

  private async $probeDeploymentInfo(subversion: string | null): Promise<Bip110NodeInfo> {
    const empty: Bip110NodeInfo = {
      support: 'unknown',
      source: 'unknown',
      subversion,
      state: null,
      since: null,
      active: false,
      periodSignaling: null,
      periodElapsed: null,
      periodStart: null,
      signalling: null,
      maxActivationHeight: null,
      activeDuration: null,
    };

    let deployments: any = null;
    let source: Bip110NodeInfo['source'] = 'unknown';
    try {
      const info = await bitcoinClient.getDeploymentInfo();
      deployments = info?.deployments ?? null;
      source = 'getdeploymentinfo';
    } catch (e) {
      // Pre-v25 nodes don't have getdeploymentinfo; the older field carries the same
      // bip9 deployment objects.
      try {
        const chainInfo = await bitcoinClient.getBlockchainInfo();
        deployments = chainInfo?.softforks ?? null;
        source = 'getblockchaininfo';
      } catch (e2) {
        // RPC genuinely unreachable — stay 'unknown' rather than guessing
        return empty;
      }
    }

    if (!deployments || typeof deployments !== 'object') {
      return empty;
    }

    const found = this.findBip110Deployment(deployments);
    if (!found) {
      // The node answered, and it has no such deployment: it does not enforce BIP-110.
      return { ...empty, support: 'not-enforcing', source };
    }

    const bip9 = found.bip9 || {};
    const stats = bip9.statistics || {};
    return {
      support: 'enforcing',
      source,
      subversion,
      state: this.translateState(bip9.status, found.active),
      since: typeof bip9.since === 'number' ? bip9.since : null,
      active: found.active === true,
      periodSignaling: typeof stats.count === 'number' ? stats.count : null,
      periodElapsed: typeof stats.elapsed === 'number' ? stats.elapsed : null,
      periodStart: typeof stats.period_start === 'number' ? stats.period_start : null,
      signalling: typeof bip9.signalling === 'string' ? bip9.signalling : null,
      // Knots exposes these BIP-110-specific extensions; Core does not. When present
      // they are the node's own parameters and outrank our configured defaults.
      maxActivationHeight: typeof bip9.max_activation_height === 'number' ? bip9.max_activation_height : null,
      activeDuration: typeof bip9.active_duration === 'number' ? bip9.active_duration : null,
    };
  }

  /**
   * Match by deployment name, falling back to any bip9 deployment using our version bit
   * — the name is what the spec asks for, but the bit is what actually governs
   * signaling, and an implementation that renames the deployment still enforces it.
   */
  private findBip110Deployment(deployments: any): any | null {
    const byName = deployments[DEPLOYMENT_NAME];
    if (byName) {
      return byName;
    }
    for (const key of Object.keys(deployments)) {
      const dep = deployments[key];
      if (dep?.type === 'bip9' && dep?.bip9?.bit === BIP110_PARAMS.signalingBit) {
        return dep;
      }
    }
    return null;
  }

  /**
   * Core reports bip9 status as defined|started|locked_in|active|failed. BIP-110 adds a
   * terminal 'expired'; a node that doesn't report it will say 'active' until the
   * deployment is dropped, and our own height-based computation covers the difference.
   */
  private translateState(status: string | undefined, active: boolean | undefined): Bip110State | null {
    switch (status) {
      case 'defined': return 'defined';
      case 'started': return 'started';
      case 'locked_in': return 'locked_in';
      case 'active': return 'active';
      case 'expired': return 'expired';
      default: return active ? 'active' : null;
    }
  }
}

export default new Bip110NodeSupportApi();
