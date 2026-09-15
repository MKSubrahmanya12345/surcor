/**
 * Intel HEX format parser.
 *
 * Extracted and generalized from external/velxio/test/test_circuit/src/avr/intelHex.js
 * for use in the headless AVR simulation harness.
 *
 * Only the FLASH region is materialised: AVR toolchains append data records
 * for EEPROM (extended address 0x81xxxx), fuses/lock bits (0x82xxxx) and
 * signatures. Indexing those raw addresses into a byte array allocated a
 * multi-megabyte sparse buffer (and copied nothing useful into the 32 KiB
 * program image), so records outside the flash window are ignored.
 */

/** Default ATmega328P flash window: 32 KiB, byte-addressed. */
export const DEFAULT_FLASH_BYTES = 0x8000;

/** Parse Intel HEX text into a program Uint8Array (byte-addressed flash). */
export function parseIntelHex(text: string, flashBytes: number = DEFAULT_FLASH_BYTES): Uint8Array {
  const bytes = new Uint8Array(flashBytes);
  /** Extended base address in bytes (type 4: value << 16, type 2: value << 4). */
  let extBase = 0;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith(':')) continue;

    const byteCount = parseInt(line.slice(1, 3), 16);
    const addr = parseInt(line.slice(3, 7), 16);
    const type = parseInt(line.slice(7, 9), 16);
    if (!Number.isFinite(byteCount) || !Number.isFinite(addr) || !Number.isFinite(type)) continue;

    if (type === 0) {
      // Data record
      const fullAddr = extBase + addr;
      for (let i = 0; i < byteCount; i++) {
        const target = fullAddr + i;
        if (target >= flashBytes) break; // EEPROM/fuse/signature regions — not flash
        const b = parseInt(line.slice(9 + i * 2, 11 + i * 2), 16);
        if (Number.isFinite(b)) bytes[target] = b;
      }
    } else if (type === 1) {
      // End-of-file record
      break;
    } else if (type === 2) {
      // Extended segment address record (physical base = value << 4)
      const segment = parseInt(line.slice(9, 13), 16);
      extBase = Number.isFinite(segment) ? segment << 4 : 0;
    } else if (type === 4) {
      // Extended linear address record (physical base = value << 16)
      const upper = parseInt(line.slice(9, 13), 16);
      extBase = Number.isFinite(upper) ? upper * 0x10000 : 0;
    }
  }

  return bytes;
}

/** Convert byte array into avr8js 16-bit word array (little-endian). */
export function bytesToProgramWords(bytes: Uint8Array, wordCount = DEFAULT_FLASH_BYTES / 2): Uint16Array {
  const prog = new Uint16Array(wordCount);
  const limit = Math.min(bytes.length, wordCount * 2);
  for (let i = 0; i < limit; i += 2) {
    prog[i >> 1] = (bytes[i] || 0) | ((bytes[i + 1] || 0) << 8);
  }
  return prog;
}
