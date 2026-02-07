# BIP110 Mempool Fork - Changelog

All changes are relative to upstream mempool/mempool v3.2.1.
See `bip-0110.mediawiki` in the project root for the full BIP specification.

## [Unreleased] - 2026-02-06

### Added

#### Backend — BIP110 Violation Detection (7 Rules per bip-0110.mediawiki Specification)

- **`getBIP110Flags()`** in `common.ts` — entry point; checks all 7 rules against a `TransactionExtended`, returns bigint flags
- **Rule 1 — Large scriptPubKey:** flags output scriptPubKeys exceeding 34 bytes (except OP_RETURN, which allows up to 83 bytes)
- **Rule 2 — Large PUSHDATA/witness:** flags witness stack elements exceeding 256 bytes; also checks scriptSig push data (exempting the BIP16 redeemScript push in P2SH inputs)
- **Rule 3 — Undefined witness version:** flags inputs spending witness program versions other than v0 (P2WPKH/P2WSH), v1 (Taproot/P2A)
- **Rule 4 — Taproot annex:** flags witness stacks with a Taproot annex (last element starts with `0x50`)
- **Rule 5 — Large control block:** flags Taproot control blocks exceeding 257 bytes (a merkle tree with 128 script leaves)
- **Rule 6 — OP_SUCCESS\*:** flags tapscripts containing OP_SUCCESS\* opcodes anywhere (even unexecuted)
- **Rule 7 — OP_IF/OP_NOTIF:** flags tapscripts executing the OP_IF or OP_NOTIF instruction (regardless of result)
- **BIP110 flags** added to `TransactionFlags` in `mempool.interfaces.ts` (bits 35-41) and mirrored in frontend `filters.utils.ts`
- **`bip110Signaling`**, **`bip110ViolationCount`**, **`bip110ViolationWeight`** fields added to `BlockExtension`
- Flags integrated into `getTransactionFlags()` pipeline in `common.ts`

#### Backend — BIP110 Miner Signaling Detection

- `isSignalingBIP110()` checks version bit 4 (BIP110 deployment `reduced_data`, threshold 1109/2016, 55%)
- Signaling computed for every block in `blocks.ts` and `BlocksRepository.ts`

#### Frontend — BIP110 Service

- New `Bip110Service` (`bip110.service.ts`) — BigInt flag operations, violation label generation, signaling check
- BIP110 violation filters added to `TransactionFilters` and `FilterGroups` in `filters.utils.ts` (goggles support)

#### Frontend — Block Overview Graph (Violation Coloring)

- BIP110 violation transactions display in **pulsing neon orange** (#ff6b00) in the block overview graph
- Violation highlighting takes highest priority over all other color modes (fee-based, age-based, audit, etc.)
- Works in both default and contrast themes (#ff8c00 for contrast)
- Violations remain fully visible in "age" gradient mode (no fading with age)
- Smooth pulse animation oscillates between neon orange and yellow-green at ~0.8 Hz
- `bip110` flag passed through vertex data to fragment shader for per-transaction radioactive symbol overlay

#### Frontend — Block Page

- **"BIP110 Violations"** row in block details table with info tooltip
- **Green "None ✓" badge** (pulsing) on signaling blocks with zero violations
- **Orange warning badge** with count when violations are present
- **"BIP110 ✓" badge** on block version row when miner signals support (version bit 4)
- **Green glow** on block detail panel border when block signals BIP110

#### Frontend — Blockchain Blocks (Cube View)

- **Green glowing border** on all 3 cube faces (front/left/top) for BIP110-signaling blocks
- **Orange glowing border** for blocks containing BIP110 violations
- **Combined state** (green border + orange interior gradient) when both signaling and violations
- **"BIP110" mini-badge** (green) on signaling blocks
- **Radioactive icon** (top-left) and **violation count badge** (top-right) on violation blocks
- Three-tier block fill gradient: empty → normal transactions → BIP110 violations (muted amber)
- Out-of-phase pulse animations: signaling pulse offset 180° from violation pulse

#### Frontend — Transaction List

- **"⚠️ BIP110 Violation" badge** in transaction headers (orange, pulsing)
- **Tooltip** listing specific rule violations on hover
- **Glowing orange border** and **left accent** on violation transaction boxes

#### Frontend — CSS/SCSS

- ~130 lines of BIP110 styles in `styles.scss` (badges, animations, tooltips, color variables)
- Component-scoped SCSS in `block.component.scss`, `blockchain-blocks.component.scss`, `transactions-list.component.scss`
- Keyframe animations: `bip110-pulse`, `bip110-signal-pulse` (offset phase), `bip110-badge-pulse`

#### Assets

- `radioactive.svg` icon for violation indicator on blockchain blocks

#### Documentation & Packaging

- Updated `README.md` with BIP110 fork description
- `CHANGELOG-BIP110.md` (this file)
- Updated Start9 wrapper: `manifest.yaml`, `README.md`, `instructions.md`

### Fixed

- **Prevout-less BIP110 detection** — Rules 4-7 were silently skipped when `vin.prevout` is `null` (Core RPC / `BACKEND: "none"` mode). Now infers taproot script path spends from witness structure using `witnessToP2TRScript()` with control block validation (min 33 bytes, `(len-33) % 32 === 0`, leaf version `& 0xfe >= 0xc0`).
- **`convertScriptSigAsm()` buffer overread** — Added bounds checks before `readUInt8`, `readUInt16LE`, `readUInt32LE` to prevent `RangeError` crashes on truncated/malformed scripts.
- **Core RPC block summary missing BIP110 flags** — The Core RPC path in `$getStrippedBlockTransactions()` now converts `IBitcoinApi.VerboseTransaction` to esplora format and runs full `classifyTransactions()` instead of hardcoding `flags: 0`.
- **`translateScriptPubKeyType`** changed from `private` to `public static` in `bitcoin-api.ts` (needed by Core RPC block summary conversion in `blocks.ts`).
- **Off-by-one bit position comments** — Corrected BIP110 flag bit position comments from 36-42 to 35-41 in `mempool.interfaces.ts`, `filters.utils.ts`, `bip110.service.ts`. No functional bug (code used named constants).
- **BIP110 comment accuracy** — Aligned inline comments with BIP-0110 specification text: added P2A to Rule 3 exemptions, OP_RETURN/BIP16 exceptions to Rules 1/2, `(even unexecuted)` qualifier to Rule 6, `executing` qualifier to Rule 7, `(128 script leaves)` to Rule 5.
- **Removed `.bak` file** and added `*.bak` to `.gitignore`.

### Known Gaps

These are low/very-low severity issues identified during code audit. They are documented in detail in `LIVING_MEMORY.md` under "Open Issues".

- **Rule 6 (OP_SUCCESS\*) — Detection is non-functional:** `containsOpSuccess()` regex `/\bOP_SUCCESS\d+\b/` never matches because `convertScriptSigAsm()` uses bitcoinjs-lib v6.1.3, which renders these opcodes under pre-tapscript names (`OP_RESERVED`, `OP_VER`, `OP_CAT`, etc.) or `"undefined"` (opcodes 187-254). **Severity: Low** — OP_SUCCESS transactions are "anyone-can-spend" and never appear in practice.
- **Rule 3 — Missing Tapleaf version check:** BIP-0110 says "undefined witness **(or Tapleaf)** versions". The code checks the witness program version but not the Tapleaf version byte in the Taproot control block. Spends using undefined Tapleaf versions (anything other than 0xc0/BIP342) would not be flagged. **Severity: Very Low** — undefined Tapleaf versions are non-standard.
- **Rule 4 (Annex) — Not detected without prevout data:** The annex check requires `vin.prevout?.scriptpubkey_type === 'v1_p2tr'` and is not re-evaluated after taproot is inferred from witness structure. Script-path annex spends are missed in Core RPC mode. Key-path annex spends are inherently undetectable without prevout. **Severity: Very Low** — the annex is currently unused.

### Notes

- Visualizations work **now** (before activation) for educational purposes — flagging transactions that **would** be invalid under BIP110
- Bitcoin Knots mempool policy already filters most BIP110 violations from the mempool
- Violations primarily appear in mined blocks from Bitcoin Core miners
- Summary version bumped to 2 to trigger re-classification of cached blocks with BIP110 flags
