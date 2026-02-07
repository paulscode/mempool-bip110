export interface Filter {
  key: string,
  label: string,
  flag: bigint,
  toggle?: string,
  group?: string,
  important?: boolean,
  tooltip?: boolean,
  txPage?: boolean,
}

export type FilterMode = 'and' | 'or';

export type GradientMode = 'fee' | 'age';

export interface ActiveFilter {
  mode: FilterMode,
  filters: string[],
  gradient: GradientMode,
}

// binary flags for transaction classification
export const TransactionFlags = {
  // features
  rbf:                                                         0b00000001n,
  no_rbf:                                                      0b00000010n,
  v1:                                                          0b00000100n,
  v2:                                                          0b00001000n,
  v3:                                                          0b00010000n,
  nonstandard:                                                 0b00100000n,
  // address types
  p2pk:                                               0b00000001_00000000n,
  p2ms:                                               0b00000010_00000000n,
  p2pkh:                                              0b00000100_00000000n,
  p2sh:                                               0b00001000_00000000n,
  p2wpkh:                                             0b00010000_00000000n,
  p2wsh:                                              0b00100000_00000000n,
  p2tr:                                               0b01000000_00000000n,
  // behavior
  cpfp_parent:                               0b00000001_00000000_00000000n,
  cpfp_child:                                0b00000010_00000000_00000000n,
  replacement:                               0b00000100_00000000_00000000n,
  acceleration:                              0b00001000_00000000_00000000n,
  // data
  op_return:                        0b00000001_00000000_00000000_00000000n,
  fake_pubkey:                      0b00000010_00000000_00000000_00000000n,
  inscription:                      0b00000100_00000000_00000000_00000000n,
  fake_scripthash:                  0b00001000_00000000_00000000_00000000n,
  // heuristics
  coinjoin:                0b00000001_00000000_00000000_00000000_00000000n,
  consolidation:           0b00000010_00000000_00000000_00000000_00000000n,
  batch_payout:            0b00000100_00000000_00000000_00000000_00000000n,
  // BIP110 'Reduced Data Temporary Softfork' violations (per bip-0110.mediawiki Specification)
  // Using bits 35-41 - within JS 53-bit safe integer range
  bip110_large_scriptpubkey:   0b00001000_00000000_00000000_00000000_00000000n, // bit 35 - Rule 1: scriptPubKey > 34 bytes (OP_RETURN up to 83)
  bip110_large_pushdata:       0b00010000_00000000_00000000_00000000_00000000n, // bit 36 - Rule 2: PUSHDATA*/witness > 256 bytes (except BIP16 redeemScript)
  bip110_undefined_witness:    0b00100000_00000000_00000000_00000000_00000000n, // bit 37 - Rule 3: Undefined witness version (not v0/v1/P2A)
  bip110_taproot_annex:        0b01000000_00000000_00000000_00000000_00000000n, // bit 38 - Rule 4: Taproot annex present
  bip110_large_control_block:  0b10000000_00000000_00000000_00000000_00000000n, // bit 39 - Rule 5: Control block > 257 bytes (128 script leaves)
  bip110_op_success:  0b00000001_00000000_00000000_00000000_00000000_00000000n, // bit 40 - Rule 6: OP_SUCCESS* in tapscript (even unexecuted)
  bip110_op_if_notif: 0b00000010_00000000_00000000_00000000_00000000_00000000n, // bit 41 - Rule 7: OP_IF/OP_NOTIF executing in tapscript
  // sighash (bits 42-46)
  sighash_all:        0b00000100_00000000_00000000_00000000_00000000_00000000n, // bit 42
  sighash_none:       0b00001000_00000000_00000000_00000000_00000000_00000000n, // bit 43
  sighash_single:     0b00010000_00000000_00000000_00000000_00000000_00000000n, // bit 44
  sighash_default:    0b00100000_00000000_00000000_00000000_00000000_00000000n, // bit 45
  sighash_acp:        0b01000000_00000000_00000000_00000000_00000000_00000000n, // bit 46
};

export function toFlags(filters: string[]): bigint {
  let flag = 0n;
  for (const filter of filters) {
    flag |= TransactionFlags[filter];
  }
  return flag;
}

export function toFilters(flags: bigint): Filter[] {
  const filters = [];
  for (const filter of Object.values(TransactionFilters).filter(f => f !== undefined)) {
    if (flags & filter.flag) {
      filters.push(filter);
    }
  }
  return filters;
}

export const TransactionFilters: { [key: string]: Filter } = {
    /* features */
    rbf: { key: 'rbf', label: 'RBF enabled', flag: TransactionFlags.rbf, toggle: 'rbf', important: true, tooltip: true, txPage: false, },
    no_rbf: { key: 'no_rbf', label: 'RBF disabled', flag: TransactionFlags.no_rbf, toggle: 'rbf', important: true, tooltip: true, txPage: false, },
    v1: { key: 'v1', label: 'Version 1', flag: TransactionFlags.v1, toggle: 'version', tooltip: true, txPage: false, },
    v2: { key: 'v2', label: 'Version 2', flag: TransactionFlags.v2, toggle: 'version', tooltip: true, txPage: false, },
    v3: { key: 'v3', label: 'Version 3', flag: TransactionFlags.v3, toggle: 'version', tooltip: true, txPage: false, },
    nonstandard: { key: 'nonstandard', label: 'Non-Standard', flag: TransactionFlags.nonstandard, important: true, tooltip: true, txPage: true, },
    /* address types */
    p2pk: { key: 'p2pk', label: 'P2PK', flag: TransactionFlags.p2pk, important: true, tooltip: true, txPage: true, },
    p2ms: { key: 'p2ms', label: 'Bare multisig', flag: TransactionFlags.p2ms, important: true, tooltip: true, txPage: true, },
    p2pkh: { key: 'p2pkh', label: 'P2PKH', flag: TransactionFlags.p2pkh, important: true, tooltip: false, },
    p2sh: { key: 'p2sh', label: 'P2SH', flag: TransactionFlags.p2sh, important: true, tooltip: false, },
    p2wpkh: { key: 'p2wpkh', label: 'P2WPKH', flag: TransactionFlags.p2wpkh, important: true, tooltip: false, },
    p2wsh: { key: 'p2wsh', label: 'P2WSH', flag: TransactionFlags.p2wsh, important: true, tooltip: false, },
    p2tr: { key: 'p2tr', label: 'Taproot', flag: TransactionFlags.p2tr, important: true, tooltip: false, },
    /* behavior */
    cpfp_parent: { key: 'cpfp_parent', label: 'Paid for by child', flag: TransactionFlags.cpfp_parent, important: true, tooltip: true, txPage: false, },
    cpfp_child: { key: 'cpfp_child', label: 'Pays for parent', flag: TransactionFlags.cpfp_child, important: true, tooltip: true, txPage: false, },
    replacement: { key: 'replacement', label: 'Replacement', flag: TransactionFlags.replacement, important: true, tooltip: true, txPage: false, },
    acceleration: window?.['__env']?.ACCELERATOR ? { key: 'acceleration', label: $localize`:@@b484583f0ce10f3341ab36750d05271d9d22c9a1:Accelerated`, flag: TransactionFlags.acceleration, important: false } : undefined,
    /* data */
    op_return: { key: 'op_return', label: 'OP_RETURN', flag: TransactionFlags.op_return, important: true, tooltip: true, txPage: true, },
    fake_pubkey: { key: 'fake_pubkey', label: 'Fake pubkey', flag: TransactionFlags.fake_pubkey, tooltip: true, txPage: true, },
    inscription: { key: 'inscription', label: 'Inscription', flag: TransactionFlags.inscription, important: true, tooltip: true, txPage: true, },
    fake_scripthash: { key: 'fake_scripthash', label: 'Fake scripthash', flag: TransactionFlags.fake_scripthash, tooltip: true, txPage: true,},
    /* heuristics */
    coinjoin: { key: 'coinjoin', label: $localize`Coinjoin`, flag: TransactionFlags.coinjoin, important: true, tooltip: true, txPage: true, },
    consolidation: { key: 'consolidation', label: $localize`Consolidation`, flag: TransactionFlags.consolidation, tooltip: true, txPage: true, },
    batch_payout: { key: 'batch_payout', label: $localize`Batch payment`, flag: TransactionFlags.batch_payout, tooltip: true, txPage: true, },
    /* sighash */
    sighash_all: { key: 'sighash_all', label: 'sighash_all', flag: TransactionFlags.sighash_all },
    sighash_none: { key: 'sighash_none', label: 'sighash_none', flag: TransactionFlags.sighash_none, tooltip: true },
    sighash_single: { key: 'sighash_single', label: 'sighash_single', flag: TransactionFlags.sighash_single, tooltip: true },
    sighash_default: { key: 'sighash_default', label: 'sighash_default', flag: TransactionFlags.sighash_default },
    sighash_acp: { key: 'sighash_acp', label: 'sighash_anyonecanpay', flag: TransactionFlags.sighash_acp, tooltip: true },
    /* BIP110 violations */
    bip110_large_scriptpubkey: { key: 'bip110_large_scriptpubkey', label: 'BIP110: Large scriptPubKey (>34 bytes)', flag: TransactionFlags.bip110_large_scriptpubkey, important: true, tooltip: true, txPage: true },
    bip110_large_pushdata: { key: 'bip110_large_pushdata', label: 'BIP110: Large push data (>256 bytes)', flag: TransactionFlags.bip110_large_pushdata, important: true, tooltip: true, txPage: true },
    bip110_undefined_witness: { key: 'bip110_undefined_witness', label: 'BIP110: Undefined witness version', flag: TransactionFlags.bip110_undefined_witness, important: true, tooltip: true, txPage: true },
    bip110_taproot_annex: { key: 'bip110_taproot_annex', label: 'BIP110: Taproot annex present', flag: TransactionFlags.bip110_taproot_annex, important: true, tooltip: true, txPage: true },
    bip110_large_control_block: { key: 'bip110_large_control_block', label: 'BIP110: Large control block (>257 bytes)', flag: TransactionFlags.bip110_large_control_block, important: true, tooltip: true, txPage: true },
    bip110_op_success: { key: 'bip110_op_success', label: 'BIP110: OP_SUCCESS opcode', flag: TransactionFlags.bip110_op_success, important: true, tooltip: true, txPage: true },
    bip110_op_if_notif: { key: 'bip110_op_if_notif', label: 'BIP110: OP_IF/OP_NOTIF in tapscript', flag: TransactionFlags.bip110_op_if_notif, important: true, tooltip: true, txPage: true },
};

export const FilterGroups: { label: string, filters: Filter[]}[] = [
  { label: $localize`:@@885666551418fd59011ceb09d5c481095940193b:Features`, filters: ['rbf', 'no_rbf', 'v1', 'v2', 'v3', 'nonstandard'] },
  { label: $localize`Address Types`, filters: ['p2pk', 'p2ms', 'p2pkh', 'p2sh', 'p2wpkh', 'p2wsh', 'p2tr'] },
  { label: $localize`Behavior`, filters: ['cpfp_parent', 'cpfp_child', 'replacement', 'acceleration'] },
  { label: $localize`Data`, filters: ['op_return', 'fake_pubkey', 'fake_scripthash', 'inscription'] },
  { label: $localize`Heuristics`, filters: ['coinjoin', 'consolidation', 'batch_payout'] },
  { label: $localize`Sighash Flags`, filters: ['sighash_all', 'sighash_none', 'sighash_single', 'sighash_default', 'sighash_acp'] },
  { label: $localize`BIP110 Violations`, filters: ['bip110_large_scriptpubkey', 'bip110_large_pushdata', 'bip110_undefined_witness', 'bip110_taproot_annex', 'bip110_large_control_block', 'bip110_op_success', 'bip110_op_if_notif'] },
].map(group => ({ label: group.label, filters: group.filters.map(filter => TransactionFilters[filter] || null).filter(f => f != null) }));