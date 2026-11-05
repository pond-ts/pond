/**
 * FIT files may save a message's time in its one-byte header (a "compressed
 * timestamp": 5 bits of seconds on from the last full timestamp) instead of
 * a 4-byte timestamp field. `fit-file-parser` doesn't decode those headers:
 * it reads the message with the wrong layout, which corrupts it and every
 * message after it.
 *
 * {@link expandCompressedTimestamps} rewrites such a file into the same
 * messages with full timestamps, which the parser reads correctly. Files
 * without compressed headers (most of them) are returned unchanged.
 */

interface Def {
  /** The definition message's bytes, as found. */
  bytes: Uint8Array;
  little: boolean;
  /** Normal (non-developer) fields: number and size. */
  fields: { num: number; size: number }[];
  /** Payload size of a normal data message. */
  size: number;
  /** Bytes of the normal fields (developer fields follow them). */
  normalSize: number;
  /** Offset of the timestamp field (253) in the payload, or -1. */
  tsOffset: number;
  /** The definition with a timestamp field added, for compressed
   *  messages whose definition has none (made when first needed). */
  withTs?: Uint8Array;
}

const TIMESTAMP = 253;

/** FIT's CRC-16. */
function crc16(bytes: Uint8Array, from: number, to: number): number {
  const table = [
    0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001,
    0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
  ];
  let crc = 0;
  for (let i = from; i < to; i++) {
    const byte = bytes[i]!;
    let tmp = table[crc & 0xf]!;
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ table[byte & 0xf]!;
    tmp = table[crc & 0xf]!;
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ table[(byte >> 4) & 0xf]!;
  }
  return crc;
}

class Out {
  #parts: Uint8Array[] = [];
  length = 0;
  push(b: Uint8Array): void {
    this.#parts.push(b);
    this.length += b.length;
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const p of this.#parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

function uint32(v: number, little: boolean): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0, little);
  return b;
}

/** The definition `d` with a 4-byte timestamp field after its normal
 *  fields, for local message type `local`. */
function addTimestamp(d: Def, local: number): Uint8Array {
  const b = d.bytes;
  const n = b[5]!;
  const normalEnd = 6 + 3 * n;
  const out = new Uint8Array(b.length + 3);
  out.set(b.subarray(0, normalEnd));
  out[0] = (b[0]! & 0x20) | 0x40 | local;
  out[5] = n + 1;
  out.set([TIMESTAMP, 4, 0x86], normalEnd);
  out.set(b.subarray(normalEnd), normalEnd + 3);
  return out;
}

/**
 * The FIT file with every compressed-timestamp message written out as a
 * normal message with a full timestamp; `bytes` itself when it has none.
 * Throws on a file whose messages don't fit its stated length.
 */
export function expandCompressedTimestamps(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 12) return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerSize = bytes[0]!;
  const end = headerSize + view.getUint32(4, true);
  if (end > bytes.length) return bytes; // the parser reports a cut file
  const broken = () => new Error('FIT file is damaged');

  const defs = new Map<number, Def>();
  const body = new Out();
  /** What the parser currently holds for each local type. */
  const emitted = new Map<number, Uint8Array>();
  let ts = 0;
  let found = false;
  let pos = headerSize;

  const emitDef = (local: number, def: Uint8Array) => {
    if (emitted.get(local) !== def) {
      body.push(def);
      emitted.set(local, def);
    }
  };

  while (pos < end) {
    const h = bytes[pos]!;
    if (h & 0x80) {
      found = true;
      const local = (h >> 5) & 3;
      const d = defs.get(local);
      if (!d) throw broken();
      // a compressed message leaves the timestamp's bytes out
      const size = d.size - (d.tsOffset >= 0 ? 4 : 0);
      if (pos + 1 + size > end) throw broken();
      const off = h & 0x1f;
      let t = (ts & ~0x1f) + off;
      if (off < (ts & 0x1f)) t += 0x20;
      ts = t;
      const payload = bytes.subarray(pos + 1, pos + 1 + size);
      const stamp = uint32(t, d.little);
      if (d.tsOffset >= 0) {
        emitDef(local, d.bytes);
        body.push(Uint8Array.of(local));
        body.push(payload.subarray(0, d.tsOffset));
        body.push(stamp);
        body.push(payload.subarray(d.tsOffset));
      } else {
        d.withTs ??= addTimestamp(d, local);
        emitDef(local, d.withTs);
        body.push(Uint8Array.of(local));
        body.push(payload.subarray(0, d.normalSize));
        body.push(stamp);
        body.push(payload.subarray(d.normalSize));
      }
      pos += 1 + size;
      continue;
    }
    const local = h & 0x0f;
    if (h & 0x40) {
      if (pos + 6 > end) throw broken();
      const little = bytes[pos + 2] === 0;
      const n = bytes[pos + 5]!;
      let p = pos + 6;
      if (p + 3 * n > end) throw broken();
      const fields: Def['fields'] = [];
      let size = 0;
      let tsOffset = -1;
      for (let i = 0; i < n; i++, p += 3) {
        const num = bytes[p]!;
        const fsize = bytes[p + 1]!;
        if (num === TIMESTAMP && fsize === 4) tsOffset = size;
        fields.push({ num, size: fsize });
        size += fsize;
      }
      const normalSize = size;
      if (h & 0x20) {
        const dev = bytes[p++]!;
        if (p + 3 * dev > end) throw broken();
        for (let i = 0; i < dev; i++, p += 3) size += bytes[p + 1]!;
      }
      const def: Def = {
        bytes: bytes.subarray(pos, p),
        little,
        fields,
        size,
        normalSize,
        tsOffset,
      };
      defs.set(local, def);
      body.push(def.bytes);
      emitted.set(local, def.bytes);
      pos = p;
      continue;
    }
    const d = defs.get(local);
    if (!d || pos + 1 + d.size > end) throw broken();
    emitDef(local, d.bytes);
    if (d.tsOffset >= 0) {
      const own = view.getUint32(pos + 1 + d.tsOffset, d.little);
      if (own !== 0xffffffff) ts = own;
    }
    body.push(bytes.subarray(pos, pos + 1 + d.size));
    pos += 1 + d.size;
  }
  if (!found) return bytes;

  const data = body.bytes();
  // anything after this file's CRC (a chained FIT file) is kept as it was
  const rest = bytes.subarray(Math.min(end + 2, bytes.length));
  const out = new Uint8Array(headerSize + data.length + 2 + rest.length);
  out.set(bytes.subarray(0, headerSize));
  const outView = new DataView(out.buffer);
  outView.setUint32(4, data.length, true);
  if (headerSize >= 14 && view.getUint16(12, true) !== 0)
    outView.setUint16(12, crc16(out, 0, 12), true);
  out.set(data, headerSize);
  outView.setUint16(
    headerSize + data.length,
    crc16(out, 0, headerSize + data.length),
    true,
  );
  out.set(rest, headerSize + data.length + 2);
  return out;
}
