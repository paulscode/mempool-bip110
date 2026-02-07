import { Injectable } from '@angular/core';

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
   * Get human-readable list of BIP110 violations from flags (static version)
   */
  static getViolationLabels(flags: number | bigint | undefined): string[] {
    if (flags === undefined || flags === null) return [];
    const bigFlags = Bip110Service.toBigInt(flags);
    const violations: string[] = [];

    if (bigFlags & Bip110Service.FLAGS.LARGE_SCRIPTPUBKEY) {
      violations.push('⚠️ Rule 1: Large scriptPubKey (>34 bytes)');
    }
    if (bigFlags & Bip110Service.FLAGS.LARGE_PUSHDATA) {
      violations.push('⚠️ Rule 2: Large PUSHDATA/witness element (>256 bytes)');
    }
    if (bigFlags & Bip110Service.FLAGS.UNDEFINED_WITNESS) {
      violations.push('⚠️ Rule 3: Spending undefined witness version (not v0/v1/P2A)');
    }
    if (bigFlags & Bip110Service.FLAGS.TAPROOT_ANNEX) {
      violations.push('⚠️ Rule 4: Taproot annex present');
    }
    if (bigFlags & Bip110Service.FLAGS.LARGE_CONTROL_BLOCK) {
      violations.push('⚠️ Rule 5: Large control block (>257 bytes)');
    }
    if (bigFlags & Bip110Service.FLAGS.OP_SUCCESS) {
      violations.push('⚠️ Rule 6: OP_SUCCESS* in tapscript');
    }
    if (bigFlags & Bip110Service.FLAGS.OP_IF_NOTIF) {
      violations.push('⚠️ Rule 7: OP_IF/OP_NOTIF executing in tapscript');
    }

    return violations;
  }

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
}
