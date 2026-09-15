/**
 * Minimal ZIP writer — dependency free.
 *
 * The software half of a build ships as a raw `.zip` the user downloads and
 * sets up themselves (`npm install && npm run dev`). Producing that archive
 * must not add a runtime dependency and must not shell out, so this module
 * writes the PKZIP container by hand:
 *
 *   [local file header + deflated data] × n
 *   [central directory header] × n
 *   [end of central directory record]
 *
 * Only what a modern unzip needs is emitted — deflate (method 8) via Node's
 * built-in `zlib`, CRC-32 computed here, UTF-8 filename flag set. No ZIP64:
 * the archives are a few dozen text files, orders of magnitude below the
 * 4 GiB / 65535-entry limits, and `createZip` refuses rather than writing a
 * container it cannot describe correctly.
 */

import { deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  /** Path inside the archive, POSIX separators, no leading slash. */
  path: string;
  content: string | Buffer;
  /** Unix mode bits (defaults to 0644, or 0755 when `executable`). */
  executable?: boolean;
}

/** ZIP stores time as MS-DOS date/time; anything before 1980 is unrepresentable. */
const DOS_EPOCH_YEAR = 1980;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(buffer: Buffer): number {
  let crc = 0xff_ff_ff_ff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] as number);
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(DOS_EPOCH_YEAR, date.getUTCFullYear());
  return {
    time:
      (date.getUTCHours() << 11) |
      (date.getUTCMinutes() << 5) |
      Math.floor(date.getUTCSeconds() / 2),
    date: ((year - DOS_EPOCH_YEAR) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

/** Reject paths that would escape the extraction directory or break readers. */
function normalisePath(rawPath: string): string {
  const path = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (path.length === 0) throw new Error('A zip entry needs a non-empty path.');
  if (path.split('/').includes('..')) throw new Error(`Unsafe zip entry path: ${rawPath}`);
  return path;
}

export interface CreateZipOptions {
  /** Timestamp stamped on every entry. Defaults to now. */
  modifiedAt?: Date;
}

export function createZip(entries: ZipEntry[], options: CreateZipOptions = {}): Buffer {
  if (entries.length > 0xff_ff) {
    throw new Error(`This zip writer supports at most 65535 entries (got ${entries.length}).`);
  }

  const stamp = dosDateTime(options.modifiedAt ?? new Date());
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  const seen = new Set<string>();
  let offset = 0;

  for (const entry of entries) {
    const path = normalisePath(entry.path);
    if (seen.has(path)) throw new Error(`Duplicate zip entry: ${path}`);
    seen.add(path);

    const nameBytes = Buffer.from(path, 'utf8');
    const raw = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, 'utf8');
    const deflated = deflateRawSync(raw, { level: 9 });
    // Deflate can grow tiny/incompressible payloads. Storing them verbatim
    // keeps the archive honest about its own size.
    const stored = deflated.length >= raw.length;
    const payload = stored ? raw : deflated;
    const method = stored ? 0 : 8;
    const checksum = crc32(raw);

    if (raw.length > 0xff_ff_ff_ff || payload.length > 0xff_ff_ff_ff) {
      throw new Error(`Zip entry ${path} exceeds the 4 GiB non-ZIP64 limit.`);
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04_03_4b_50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed: 2.0 (deflate)
    local.writeUInt16LE(0x08_00, 6); // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // no extra field
    locals.push(local, nameBytes, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02_01_4b_50, 0); // central directory signature
    central.writeUInt16LE(0x03_14, 4); // made by: UNIX, spec 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x08_00, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    // External attrs: high 16 bits are the UNIX mode.
    central.writeUInt32LE(((entry.executable ? 0o100_755 : 0o100_644) >>> 0) * 0x1_00_00, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + payload.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06_05_4b_50, 0); // end of central directory
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuffer, end]);
}
