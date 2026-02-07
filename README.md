# Mempool BIP110 🔍

> A fork of [Mempool](https://mempool.space/) (v3.2.1) that visualizes **BIP110 (Reduced Data Temporary Softfork)** miner signaling and transaction rule violations in real time.

---

## What is BIP110?

[BIP110](https://groups.google.com/g/bitcoindev/c/nOZim6FbuF8) is a proposed temporary soft fork for Bitcoin that limits methods of embedding arbitrary data into transactions. It targets techniques like inscriptions and other data-heavy payloads that burden node operators, while preserving all known monetary use cases. The proposal uses BIP9-style miner signaling (version bit 4, 55% activation threshold) for a one-year deployment.

For the full specification, see [`bip-0110.mediawiki`](https://github.com/dathonohm/bips/blob/reduced-data/bip-0110.mediawiki) or the [reference implementation](https://github.com/bitcoinknots/bitcoin/compare/29.x-knots...dathonohm:bitcoin:uasf-modified-bip9).

## What Does This Fork Do?

This fork adds two kinds of visual indicators to the Mempool explorer:

### 🟢 Miner Signaling (Green)
Blocks from miners signaling BIP110 support (version bit 4) are highlighted with a **green glow** on all cube faces in the blockchain view, a **"BIP110 ✓" badge** on the block detail page, and a pulsing **"None ✓"** badge when the block contains zero violations.

### 🟠 Rule Violations (Orange)
Transactions that **would be invalid under BIP110** are highlighted with **pulsing neon orange** in the block overview graph, **warning badges** in the transaction list, and a **radioactive icon** on the blockchain cube view. Hovering over badges shows which specific rules are violated. These indicators are visible **now**, before activation, for educational purposes.

When a signaling block also contains violations, both effects combine: green border with orange interior.

---

## BIP110 Rules Detected

Under BIP110, transactions are invalid if they contain any of the following (per the [specification](https://github.com/dathonohm/bips/blob/reduced-data/bip-0110.mediawiki)):

| # | Rule | Threshold |
|---|------|-----------|
| 1 | **Large scriptPubKey** — New output scriptPubKeys exceeding 34 bytes, unless OP_RETURN (up to 83 bytes) | 34 / 83 bytes |
| 2 | **Large PUSHDATA / witness** — OP_PUSHDATA\* payloads or witness stack elements exceeding 256 bytes (except BIP16 redeemScript) | 256 bytes |
| 3 | **Undefined witness version** — Spending undefined witness or Tapleaf versions (not v0, v1, or P2A) | — |
| 4 | **Taproot annex** — Witness stacks with a Taproot annex | — |
| 5 | **Large control block** — Taproot control blocks exceeding 257 bytes (a merkle tree with 128 script leaves) | 257 bytes |
| 6 | **OP_SUCCESS\*** — Tapscripts including OP_SUCCESS\* opcodes anywhere, even unexecuted | — |
| 7 | **OP_IF / OP_NOTIF** — Tapscripts executing OP_IF or OP_NOTIF (regardless of result) | — |

> **Note:** Inputs spending UTXOs created before the activation height are exempt from these rules.

**Miner signaling** is detected via version bit 4: `(block.version & (1 << 4)) !== 0`. The activation threshold is 55% (1109/2016 blocks per retarget period).

---

## Installation

This fork is based on Mempool v3.2.1 and can be installed using the same methods.

### Start9 (Recommended)
Use the [Mempool BIP110 Start9 Wrapper](https://github.com/paulscode/mempool-bip110-startos) for easy installation on StartOS alongside the original Mempool.

### Docker
See the [`docker/`](./docker/) directory for Docker deployment instructions.

### Manual Installation
See [`backend/`](./backend/) and [`frontend/`](./frontend/) for manual setup instructions.

### Backend Requirements
The backend works with either **Bitcoin Core** or **Bitcoin Knots** as the RPC source. For best results (full prevout data for accurate violation detection), use an **Esplora** backend. The `BACKEND: "none"` (Core RPC) mode also works, with minor limitations on annex detection documented in the [changelog](./CHANGELOG-BIP110.md).

---

## Links

- [BIP110 Specification](https://github.com/dathonohm/bips/blob/reduced-data/bip-0110.mediawiki)
- [BIP110 Discussion (bitcoindev)](https://groups.google.com/g/bitcoindev/c/nOZim6FbuF8)
- [BIP110 Reference Implementation](https://github.com/bitcoinknots/bitcoin/compare/29.x-knots...dathonohm:bitcoin:uasf-modified-bip9)
- [Original Mempool Project](https://mempool.space/)
- [Changelog](./CHANGELOG-BIP110.md)

---

## License

This project inherits the [Affero General Public License (AGPL)](./COPYING.md) from the original Mempool project.

---

# Upstream Mempool Documentation

<br>

Mempool is the fully-featured mempool visualizer, explorer, and API service running at [mempool.space](https://mempool.space/). 

It is an open-source project developed and operated for the benefit of the Bitcoin community, with a focus on the emerging transaction fee market that is evolving Bitcoin into a multi-layer ecosystem.

# Installation Methods

Mempool can be self-hosted on a wide variety of your own hardware, ranging from a simple one-click installation on a Raspberry Pi full-node distro all the way to a robust production instance on a powerful FreeBSD server. 

Most people should use a <a href="#one-click-installation">one-click install method</a>.

Other install methods are meant for developers and others with experience managing servers. If you want support for your own production instance of Mempool, or if you'd like to have your own instance of Mempool run by the mempool.space team on their own global ISP infrastructure—check out <a href="https://mempool.space/enterprise" target="_blank">Mempool Enterprise®</a>.

<a id="one-click-installation"></a>
## One-Click Installation

Mempool can be conveniently installed on the following full-node distros: 
- [Umbrel](https://github.com/getumbrel/umbrel)
- [RaspiBlitz](https://github.com/rootzoll/raspiblitz)
- [RoninDojo](https://code.samourai.io/ronindojo/RoninDojo)
- [myNode](https://github.com/mynodebtc/mynode)
- [StartOS](https://github.com/Start9Labs/start-os)
- [nix-bitcoin](https://github.com/fort-nix/nix-bitcoin/blob/a1eacce6768ca4894f365af8f79be5bbd594e1c3/examples/configuration.nix#L129)

**We highly recommend you deploy your own Mempool instance this way.** No matter which option you pick, you'll be able to get your own fully-sovereign instance of Mempool up quickly without needing to fiddle with any settings.

## Advanced Installation Methods

Mempool can be installed in other ways too, but we only recommend doing so if you're a developer, have experience managing servers, or otherwise know what you're doing.

- See the [`docker/`](./docker/) directory for instructions on deploying Mempool with Docker.
- See the [`backend/`](./backend/) and [`frontend/`](./frontend/) directories for manual install instructions oriented for developers.
- See the [`production/`](./production/) directory for guidance on setting up a more serious Mempool instance designed for high performance at scale.
