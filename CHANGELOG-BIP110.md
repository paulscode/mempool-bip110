# BIP110 Mempool Fork - Changelog

All changes are relative to upstream mempool/mempool v3.2.1.
See `bip-0110.mediawiki` in the project root for the full BIP specification.

## 2026-08-07

Prepared the app for every context it can find itself in once mandatory signaling
(961632) and activation (<=965664) are reached. Until now the app had exactly one model
of the world -- "BIP-110 is a proposal" -- and every colour and string was hard-coded to
it. See `BIP110-OUTCOMES-PLAN.md` in the project root for the full design and the
rationale behind each decision (D1-D8).

### Added

- **Node enforcement detection** (`bip110-node-support.ts`). Probes `getdeploymentinfo`
  for the `reduced_data` deployment (falling back to any bip9 deployment on bit 4, then
  to `getblockchaininfo.softforks` on pre-v25 nodes, with a `BIP110.ENFORCING` config
  override). Verified against Knots 29.3.0: the deployment is reported under exactly
  that name, with `max_activation_height` and a per-block `signalling` string.
- **Pre-activation UTXO exemption.** The spec exempts inputs spending UTXOs created
  before the activation height, and rules 2-7 are all input-side -- so without this the
  app would paint valid post-activation blocks red. Confirmed blocks get prevout heights
  from `getblock` verbosity 3 (which also replaces witness-structure inference with real
  prevout script types); unconfirmed transactions resolve them lazily via `gettxout`
  (`bip110-mempool-exemption.ts`).
- **Chain verdict.** "Did BIP-110 succeed?" is not a question about the state machine --
  lock-in is guaranteed by 963648. The observable question is whether the chain this node
  follows obeys the rules, so the app now reports `compliant` / `divergent` / `unknown`
  and names the first diverging block.
- **Red block treatment** for blocks that are invalid *now*, distinct from the existing
  amber for hypothetical or historical violations, plus **gold milestone ribbons** that
  compose with the compliance colour rather than replacing it.
- **`BIP110.HEIGHTS` config block**, so the whole activation timeline can be exercised on
  regtest or against shifted mainnet heights before it happens for real.
- **`BIP110.STRICT_VERDICTS` kill switch.** When false, nothing is escalated to "invalid"
  and all wording stays conditional -- a rollback that needs no code deploy.

### Changed

- **Wording is now verdict-driven everywhere.** "would be invalid" becomes "is invalid"
  only where the rules actually apply to that block's height, with distinct phrasing for
  pending, historical, post-expiry and unverified cases.
- **Mandatory signaling is no longer a bare height range.** Per spec it ends once
  LOCKED_IN is reached, so an early threshold lock-in means it never applies -- treating
  it as a range would have painted valid non-signaling blocks red.
- **Deployment card is per-state**, including a mandatory-mode progress bar (the
  requirement is 2016 of 2016, not the 55% threshold the old bar drew).
- Per-period signaling now comes from the node's `signalling` string when available: one
  RPC instead of ~4000 header fetches per period, and authoritative rather than derived.

### Fixed

- **Reorg staleness.** The violation cache was keyed by height alone, so after a reorg a
  block inherited the previous occupant's violation count permanently. Cache format v3
  adds a block-hash tag per entry, making the check self-healing regardless of whether
  database indexing is enabled (the existing reorg handler is gated on it).
- **Blocks falsely recorded as clean.** Disk-cache seeding used `|| 0`, recording an
  unknown count as "scanned, zero violations" -- after activation, a block that should be
  red painted green.
- **Scanner hole at the chain tip.** The background scan started below the memory cache,
  leaving the newest -- and post-activation the only consensus-relevant -- blocks to the
  real-time path alone. It now starts at the tip and covers the enforced range before the
  informational history.
- **Unverifiable data could be escalated to red.** Counts computed without prevout heights
  (verbosity-2 fallback, or before the deployment context is known) are now marked
  degraded and surface as unverified amber. An enforcing node cannot have accepted an
  invalid block, so a detector hit that contradicts one is treated as a detector fault.

## 2026-06-07

Reconciled the implementation with an updated `bip-0110.mediawiki` and closed the
violation-detection and deployment-tracking gaps found in a full spec audit.

### Spec sync

- Updated `bip-0110.mediawiki` to the current upstream draft. Notable changes:
  - Rule 2 now defines **"script argument witness items"** and explicitly exempts
    witness scripts, Tapleaf scripts, control blocks, annexes, and Taproot
    key-path signatures from the 256-byte witness limit.
  - New terminal **EXPIRED** state: `ACTIVE → EXPIRED` once
    `height >= activation_height + active_duration` (previously the deployment
    stayed `ACTIVE` with rules conditionally unenforced).
  - Added a GetBlockTemplate section (GBT name `reduced_data`, `vbrequired` during
    mandatory signaling) and a more precise LOCKED_IN definition.

### Added

- **Recent signaling blocks modal.** The signaling progress label on the
  deployment card (e.g. "6/1194 (0.5%) · need 1109/2016") is now a clickable link
  that opens a styled modal listing the most recent BIP-110 signaling blocks
  (up to 25) in the current retarget period — each row shows a green block badge,
  the height, and relative time, and navigates to that block's page on click. The
  backend surfaces these via `recentSignalingBlocks` on the deployment info,
  derived from the block headers already fetched for the signaling count
  (heights + timestamps), so it adds no extra fetching.

### Changed

- **Rule 2 — Script argument witness items (correctness):** the 256-byte witness
  limit now applies only to *script argument witness items*, per the clarified
  spec. Witness scripts, Tapleaf scripts, control blocks, annexes, and Taproot
  key-path signatures are no longer flagged by the item-size check. This removes
  false positives on large P2WSH witness scripts, large Tapleaf scripts
  (ordinals/inscriptions), and valid 257-byte control blocks. Implemented in
  `checkBIP110WitnessRules()` via an exempt-index set keyed on the spend type
  (`prevout` when available, witness-structure inference otherwise).
- **Rule 2 — Internal OP_PUSHDATA\* payloads:** the *contents* of exempt executing
  scripts (BIP16 redeemScripts, witness scripts, Tapleaf scripts) are still
  subject to Rule 2. New `scriptHasLargePush()` byte-walker scans these for
  payloads exceeding 256 bytes; wired into `checkBIP110WitnessRules()` and
  `checkBIP110ScriptSigRules()` (the redeemScript is no longer skipped entirely).
- **Deployment — EXPIRED state:** added `'expired'` to `Bip110State` and the
  `ACTIVE → EXPIRED` transition in `computeState()`; `rulesExpired` is now
  `state === 'expired'`. Mirrored in the frontend (`Bip110State`,
  `bip110-deployment.component.html` switch cases, `&.expired` badge style).
- **Deployment — full-period signaling count:** signaling is now counted over the
  entire 2016-block retarget period from the database
  (`BlocksRepository.$countSignalingBlocks()`), cached and refreshed
  asynchronously so the synchronous `getDeploymentInfo()` is unaffected. Falls
  back to the in-memory block cache when indexing is disabled. Previously the
  count used only the ~32-block in-memory cache, so `signalingPercent` was
  understated and threshold-based `LOCKED_IN` was effectively unreachable.
- **Deployment — restart-safe lock-in:** new one-time `$scanForLockIn()` scans
  completed retarget periods (gated to blocks at/after `starttime` via
  `BlocksRepository.$getFirstBlockHeightAtOrAfterTimestamp()`) to recover a
  threshold-based lock-in that occurred before the process started. `computeState()`
  now derives the mandatory backstop in a local variable instead of mutating
  `lockedInHeight`, so the scan remains the source of truth for the real (earlier)
  lock-in height.

### Fixed

- **Rule 6 (OP_SUCCESS\*) — was non-functional.** The old `containsOpSuccess()`
  regex `/\bOP_SUCCESS\d+\b/` could never match, because both `inner_witnessscript_asm`
  and `convertScriptSigAsm()` render these code points under legacy names
  (`OP_RESERVED`, `OP_VER`, `OP_CAT`, …) — never `OP_SUCCESSx`. Replaced with
  `scanTapscriptForViolations()`, a byte-level, push-aware walker that checks raw
  Tapscript bytes against the actual OP_SUCCESS opcode set (80, 98, 126-129,
  131-134, 137-138, 141-142, 149-153, 187-254) and OP_IF/OP_NOTIF. Verified that a
  `0x50`/`0x4d` data byte inside a push is not mistaken for an opcode/length prefix.
- **Rule 3 — undefined Tapleaf versions now detected.** For Taproot script-path
  spends, the control block's leaf version (`firstByte & 0xfe`) is checked; any
  value other than `0xc0` (BIP342) is flagged as an undefined witness/Tapleaf
  version.
- **Rule 4 — annex now detected on inferred script-path spends.** The annex check
  fires when `prevout` is `v1_p2tr` *or* a Taproot script path is inferred from the
  witness, covering the Core RPC (`prevout`-less) path for script-path spends.
- **Rule 2 — false-positive internal-push detection.** `scriptHasLargePush()`
  flagged an `OP_PUSHDATA2/4` by its *declared* length without confirming the
  payload bytes were actually present. When the prevout-less scanner treats a
  spend's last witness item as a "witness script" (correct for P2WSH, but the item
  is a pubkey for P2WPKH / a signature for key-path), a stray `0x4d`/`0x4e` byte in
  that pubkey/signature was read as a large push, inflating block violation counts
  (e.g. block 952707 went from 0 true violations to 124). The walker now requires a
  push's declared data to fit within the script before counting it — matching the
  old ASM-based behavior. Real `>256` pushes (data present) are still flagged.
- **Deployment signaling count stuck at 0 / not updating during indexing.** The
  count was read only from the indexed `blocks` table (slow full-block indexer)
  and only refreshed on a new block, so right after a fresh install it sat at 0
  for a long time. The current period's signaling is now filled directly from
  block **headers** (just the 4-byte version — fetched newest-first with bounded
  concurrency), so it populates in seconds independent of full-block indexing, and
  a 30s background timer re-polls so it climbs live. The count is published as
  `max(header map, in-memory recent blocks, indexed DB)`, so it is never a stale 0
  and converges to the exact full-period value quickly.

- **Frontend duplicated the old detection logic.** The transaction details page
  (and tracker / raw views) compute flags client-side via a copy of `getBIP110Flags`
  in `frontend/src/app/shared/transaction.utils.ts`, which still had the *original*
  rules — so a tx could show a BIP110 violation on its details page that the
  (fixed) block-level count did not (e.g. a P2WSH multisig with a 626-byte witness
  script flagged as "large push data"). The frontend copy was brought in line with
  the backend: Rule 2 script-argument exemptions + internal-push scanning (with the
  declared-length guard), Rule 3 Tapleaf versions, Rule 4 inferred annex, Rule 6
  byte-level OP_SUCCESS scan, and the BIP16 redeemScript exemption.

### Known Gaps

The three gaps listed under 2026-02-06 (Rule 6 dead code, Rule 3 Tapleaf version,
Rule 4 inferred-annex) are **resolved** above. Remaining limitations:

- **`prevout`-dependent rules in Core RPC mode:** Rule 3 (undefined *witness*
  version, read from the spent output's scriptPubKey) and a key-path annex (Rule 4)
  cannot be detected when `vin.prevout` is `null`. The main Esplora path is
  unaffected. **Severity: Very Low** — these spend types are non-standard/unused.
- **Rule 7 "executing" is over-approximated:** any OP_IF/OP_NOTIF in a Tapscript is
  flagged, since static analysis cannot determine which branch executes. This is
  the conservative direction and matches the spam-detection intent.
- **Activation-height exemption not applied:** the spec exempts inputs spending
  UTXOs created before activation. The tool intentionally flags all would-be
  violations regardless (the fork is not yet active, and the goal is to surface
  data-storage transactions). **By design.**

## 2026-02-06

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

These are low/very-low severity issues identified during code audit.

- **Rule 6 (OP_SUCCESS\*) — Detection is non-functional:** `containsOpSuccess()` regex `/\bOP_SUCCESS\d+\b/` never matches because `convertScriptSigAsm()` uses bitcoinjs-lib v6.1.3, which renders these opcodes under pre-tapscript names (`OP_RESERVED`, `OP_VER`, `OP_CAT`, etc.) or `"undefined"` (opcodes 187-254). **Severity: Low** — OP_SUCCESS transactions are "anyone-can-spend" and never appear in practice.
- **Rule 3 — Missing Tapleaf version check:** BIP-0110 says "undefined witness **(or Tapleaf)** versions". The code checks the witness program version but not the Tapleaf version byte in the Taproot control block. Spends using undefined Tapleaf versions (anything other than 0xc0/BIP342) would not be flagged. **Severity: Very Low** — undefined Tapleaf versions are non-standard.
- **Rule 4 (Annex) — Not detected without prevout data:** The annex check requires `vin.prevout?.scriptpubkey_type === 'v1_p2tr'` and is not re-evaluated after taproot is inferred from witness structure. Script-path annex spends are missed in Core RPC mode. Key-path annex spends are inherently undetectable without prevout. **Severity: Very Low** — the annex is currently unused.

### Notes

- Visualizations work **now** (before activation) for educational purposes — flagging transactions that **would** be invalid under BIP110
- Bitcoin Knots mempool policy already filters most BIP110 violations from the mempool
- Violations primarily appear in mined blocks from Bitcoin Core miners
- Summary version bumped to 2 to trigger re-classification of cached blocks with BIP110 flags
