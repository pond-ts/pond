import {
  type StringColumn,
  stringColumnDictEncoded,
  stringColumnFallback,
  stringColumnFromArray,
  validityFromPredicate,
  DICT_ENCODE_MIN_LENGTH,
  DICT_ENCODE_RATIO,
} from '../../columnar/index.js';

/**
 * **Direct read of Arrow text columns** ([PND-ARROWTEXT]). `fromArrow` used to
 * call the vector's `toArray()`, which for a `Utf8` column walks every row
 * through apache-arrow's `get` and decodes each one with a `TextDecoder`
 * call: ~345 ms of a ~500 ms read for 1M rows. The ingest engine then built a
 * `Map` over those strings to dictionary-encode them.
 *
 * Here the column's buffers are read directly. Each row's bytes are hashed
 * and looked up in a table of byte runs already seen, so a string is decoded
 * once per distinct value, not once per row. A `Dictionary<Utf8>` column
 * decodes its dictionary once and maps the row indices through it.
 *
 * **The result is the old one, exactly.**
 *
 * - A row is missing when apache-arrow's `get` returns `null`: its validity
 *   bit (at `data.offset + row`) is clear, when the chunk has a bitmap and a
 *   non-zero null count; or, for `Utf8`, its offsets run past the buffer.
 * - Text is decoded with `new TextDecoder('utf-8')`, the decoder
 *   apache-arrow uses (so a leading byte-order mark is dropped, and invalid
 *   bytes become U+FFFD). An all-ASCII run gives the same string through
 *   `String.fromCharCode`. Two different byte runs can decode to the same
 *   string (two invalid sequences); they are merged by the decoded text.
 * - The dictionary is in first-appearance order and the dictionary-or-plain
 *   choice is `stringColumnFromArray`'s, so the column is built the same.
 * - A column with no rows, or with every row missing, comes back as an
 *   all-missing number column, as `classifyArray` decided before.
 *
 * Anything it does not recognise (no `type` / `data`, `LargeUtf8` or
 * `Utf8View`, 64-bit or out-of-range dictionary indices, a dictionary of
 * something other than strings) returns `undefined` and the caller reads the
 * column through `toArray()` as before.
 */

const TYPE_DICTIONARY = -1;
const TYPE_UTF8 = 5;

/** The slice of an Arrow `Data` chunk this reader uses. */
interface TextData {
  readonly offset?: number;
  readonly length?: number;
  readonly nullCount?: number;
  readonly nullBitmap?: Uint8Array | null;
  readonly valueOffsets?: unknown;
  readonly values?: unknown;
  readonly dictionary?: TextVector | null;
}

/** The slice of an Arrow `Vector` this reader uses. */
export interface TextVector {
  readonly length: number;
  readonly type?: {
    readonly typeId?: number;
    readonly dictionary?: { readonly typeId?: number };
  };
  readonly data?: ReadonlyArray<unknown>;
}

export type TextRead =
  | { kind: 'string'; column: StringColumn }
  | { kind: 'string'; values: Array<string | null> }
  | { kind: 'number'; values: Float64Array };

const decoder = new TextDecoder('utf-8');

/** Longest all-ASCII run passed to `String.fromCharCode` in one call. */
const CHAR_CODE_LIMIT = 4096;

function decode(bytes: Uint8Array, start: number, end: number, ascii: boolean) {
  if (ascii && end - start <= CHAR_CODE_LIMIT) {
    return String.fromCharCode.apply(
      null,
      bytes.subarray(start, end) as unknown as number[],
    );
  }
  return decoder.decode(bytes.subarray(start, end));
}

/** Validity bits of a chunk, or `undefined` when every row is valid. */
function validBits(data: TextData): Uint8Array | undefined {
  const bitmap = data.nullBitmap;
  if (!(bitmap instanceof Uint8Array) || bitmap.byteLength === 0) {
    return undefined;
  }
  return (data.nullCount ?? 0) > 0 ? bitmap : undefined;
}

/**
 * Distinct strings in first-appearance order. `ids[row]` is the string's
 * position, `-1` for a missing row.
 */
class TextIds {
  readonly ids: Int32Array;
  readonly strings: string[] = [];
  readonly #byText = new Map<string, number>();
  // Byte runs seen so far, keyed by an FNV-1a hash (open addressing).
  #slots = new Int32Array(1024).fill(-1);
  #mask = 1023;
  #runBytes: Uint8Array[] = [];
  #runStart: number[] = [];
  #runEnd: number[] = [];
  #runHash: number[] = [];
  #runId: number[] = [];

  constructor(length: number) {
    this.ids = new Int32Array(length);
  }

  /** Id of a decoded string, adding it when new. */
  idOf(text: string): number {
    let id = this.#byText.get(text);
    if (id === undefined) {
      id = this.strings.length;
      this.strings.push(text);
      this.#byText.set(text, id);
    }
    return id;
  }

  /** Id of the text in `bytes[start, end)`, decoding it only when unseen. */
  idOfBytes(bytes: Uint8Array, start: number, end: number): number {
    let h = 0x811c9dc5;
    let high = 0;
    for (let k = start; k < end; k += 1) {
      const b = bytes[k]!;
      high |= b;
      h = Math.imul(h ^ b, 0x01000193);
    }
    const len = end - start;
    let slot = h & this.#mask;
    for (;;) {
      const run = this.#slots[slot]!;
      if (run < 0) break;
      if (this.#runHash[run] === h) {
        const rb = this.#runBytes[run]!;
        const rs = this.#runStart[run]!;
        if (this.#runEnd[run]! - rs === len) {
          let same = true;
          for (let k = 0; k < len; k += 1) {
            if (rb[rs + k] !== bytes[start + k]) {
              same = false;
              break;
            }
          }
          if (same) return this.#runId[run]!;
        }
      }
      slot = (slot + 1) & this.#mask;
    }
    const id = this.idOf(decode(bytes, start, end, high < 0x80));
    const run = this.#runId.length;
    this.#runBytes.push(bytes);
    this.#runStart.push(start);
    this.#runEnd.push(end);
    this.#runHash.push(h);
    this.#runId.push(id);
    this.#slots[slot] = run;
    if ((run + 1) * 2 > this.#mask + 1) this.#grow();
    return id;
  }

  #grow(): void {
    const size = (this.#mask + 1) * 2;
    const slots = new Int32Array(size).fill(-1);
    const mask = size - 1;
    for (let run = 0; run < this.#runHash.length; run += 1) {
      let slot = this.#runHash[run]! & mask;
      while (slots[slot]! >= 0) slot = (slot + 1) & mask;
      slots[slot] = run;
    }
    this.#slots = slots;
    this.#mask = mask;
  }
}

/**
 * Rows between checks of how many distinct values a `Utf8` column has. Once
 * at least half the rows seen are distinct, the column will be stored plain
 * (not dictionary-encoded) and the byte table only costs time, so the rest
 * is decoded row by row ({@link readUtf8Plain}).
 */
const CARDINALITY_CHECK = 65536;

/**
 * Fill `out.ids[at + from, at + to)` from rows `[from, to)` of one `Utf8`
 * chunk.
 */
function readUtf8Ids(
  data: TextData,
  offsets: Int32Array,
  bytes: Uint8Array,
  out: TextIds,
  at: number,
  from: number,
  to: number,
): void {
  const bits = validBits(data);
  const base = data.offset ?? 0;
  const ids = out.ids;
  for (let j = from; j < to; j += 1) {
    if (bits !== undefined) {
      const pos = base + j;
      if ((bits[pos >> 3]! & (1 << (pos & 7))) === 0) {
        ids[at + j] = -1;
        continue;
      }
    }
    if (j + 1 >= offsets.length) {
      ids[at + j] = -1;
      continue;
    }
    ids[at + j] = out.idOfBytes(bytes, offsets[j]!, offsets[j + 1]!);
  }
}

/**
 * Decode rows `[from, len)` of one `Utf8` chunk into `values[at + row]`.
 * When those rows' bytes are all ASCII (and the offsets rise from zero or
 * more), the run is decoded in one call and each row is a substring of it.
 */
function readUtf8Plain(
  data: TextData,
  offsets: Int32Array,
  bytes: Uint8Array,
  values: Array<string | null>,
  at: number,
  from: number,
): void {
  const len = data.length!;
  const bits = validBits(data);
  const base = data.offset ?? 0;
  let whole: string | undefined;
  let first = 0;
  if (offsets.length > len && offsets[from]! >= 0) {
    first = offsets[from]!;
    let ascii = true;
    for (let j = from; j < len && ascii; j += 1) {
      if (offsets[j + 1]! < offsets[j]!) ascii = false;
    }
    const last = offsets[len]!;
    if (ascii && last <= bytes.length) {
      let high = 0;
      for (let k = first; k < last; k += 1) high |= bytes[k]!;
      if (high < 0x80) whole = decoder.decode(bytes.subarray(first, last));
    }
  }
  for (let j = from; j < len; j += 1) {
    if (bits !== undefined) {
      const pos = base + j;
      if ((bits[pos >> 3]! & (1 << (pos & 7))) === 0) {
        values[at + j] = null;
        continue;
      }
    }
    if (j + 1 >= offsets.length) {
      values[at + j] = null;
      continue;
    }
    values[at + j] =
      whole !== undefined
        ? whole.slice(offsets[j]! - first, offsets[j + 1]! - first)
        : decoder.decode(bytes.subarray(offsets[j]!, offsets[j + 1]!));
  }
}

function isIndexArray(
  v: unknown,
): v is
  | Int8Array
  | Int16Array
  | Int32Array
  | Uint8Array
  | Uint16Array
  | Uint32Array {
  return (
    v instanceof Int32Array ||
    v instanceof Int8Array ||
    v instanceof Int16Array ||
    v instanceof Uint8Array ||
    v instanceof Uint16Array ||
    v instanceof Uint32Array
  );
}

/** Fill `out.ids[at, at + len)` from one `Dictionary<Utf8>` chunk. */
function readDictionaryChunk(
  data: TextData,
  out: TextIds,
  at: number,
): boolean {
  const len = data.length!;
  const indices = data.values;
  const dictionary = data.dictionary;
  if (!isIndexArray(indices) || indices.length < len || dictionary == null) {
    return false;
  }
  if (dictionary.type?.typeId !== TYPE_UTF8) return false;
  // The dictionary's own strings, decoded once (null = a null entry).
  const entries = readUtf8Strings(dictionary);
  if (entries === undefined) return false;
  const bits = validBits(data);
  const base = data.offset ?? 0;
  // Dictionary entry → id, filled on first use so ids stay in row order.
  const local = new Int32Array(entries.length).fill(-2);
  const ids = out.ids;
  for (let j = 0; j < len; j += 1) {
    if (bits !== undefined) {
      const pos = base + j;
      if ((bits[pos >> 3]! & (1 << (pos & 7))) === 0) {
        ids[at + j] = -1;
        continue;
      }
    }
    const k = indices[j]!;
    if (k < 0 || k >= entries.length) return false;
    let id = local[k]!;
    if (id === -2) {
      const text = entries[k];
      id = text === null ? -1 : out.idOf(text!);
      local[k] = id;
    }
    ids[at + j] = id;
  }
  return true;
}

/** A text vector's rows: as ids into distinct strings, or as strings. */
type TextRows =
  | { ids: Int32Array; strings: string[]; values?: undefined }
  | { values: Array<string | null> };

/** Every row of a `Utf8` vector as a string (`null` = missing). */
function readUtf8Strings(vector: TextVector): Array<string | null> | undefined {
  const rows = readRows(vector, false);
  if (rows === undefined) return undefined;
  if (rows.values !== undefined) return rows.values;
  const values = new Array<string | null>(rows.ids.length);
  for (let i = 0; i < values.length; i += 1) {
    const id = rows.ids[i]!;
    values[i] = id < 0 ? null : rows.strings[id]!;
  }
  return values;
}

function readRows(vector: TextVector, dict: boolean): TextRows | undefined {
  const chunks = vector.data;
  if (!Array.isArray(chunks)) return undefined;
  const n = vector.length;
  const out = new TextIds(n);
  let values: Array<string | null> | undefined;
  let at = 0;
  for (const chunk of chunks as ReadonlyArray<TextData | null | undefined>) {
    if (chunk == null) return undefined;
    const len = chunk.length;
    if (typeof len !== 'number' || at + len > n) return undefined;
    if (dict) {
      if (!readDictionaryChunk(chunk, out, at)) return undefined;
      at += len;
      continue;
    }
    const offsets = chunk.valueOffsets;
    const bytes = chunk.values;
    if (!(offsets instanceof Int32Array) || !(bytes instanceof Uint8Array)) {
      return undefined;
    }
    let j = 0;
    while (values === undefined && j < len) {
      const to = Math.min(len, j + CARDINALITY_CHECK);
      readUtf8Ids(chunk, offsets, bytes, out, at, j, to);
      j = to;
      const seen = at + j;
      if (seen >= CARDINALITY_CHECK && out.strings.length * 2 >= seen) {
        // Switch to strings: copy the rows read so far, decode the rest.
        values = new Array<string | null>(n);
        for (let i = 0; i < seen; i += 1) {
          const id = out.ids[i]!;
          values[i] = id < 0 ? null : out.strings[id]!;
        }
      }
    }
    if (values !== undefined && j < len) {
      readUtf8Plain(chunk, offsets, bytes, values, at, j);
    }
    at += len;
  }
  if (at !== n) return undefined;
  return values !== undefined
    ? { values }
    : { ids: out.ids, strings: out.strings };
}

/**
 * Read a `Utf8` or `Dictionary<Utf8>` value column straight from its
 * buffers, or `undefined` to fall back to `toArray()`. With `build`, the
 * `StringColumn` is built here; otherwise (rows will be sorted) the strings
 * are handed back as an array.
 */
export function readArrowText(
  vector: TextVector,
  build: boolean,
): TextRead | undefined {
  const type = vector.type;
  const id = type?.typeId;
  const dict = id === TYPE_DICTIONARY && type?.dictionary?.typeId === TYPE_UTF8;
  if (id !== TYPE_UTF8 && !dict) return undefined;
  const rows = readRows(vector, dict);
  if (rows === undefined) return undefined;
  if (rows.values !== undefined) {
    // Most rows distinct: hand the strings to `stringColumnFromArray`, the
    // old path's builder, which also makes the storage choice.
    const values = rows.values;
    let missing = 0;
    for (let i = 0; i < values.length; i += 1) {
      if (values[i] === null) missing += 1;
    }
    if (missing === values.length) {
      return { kind: 'number', values: new Float64Array(missing).fill(NaN) };
    }
    return build
      ? { kind: 'string', column: stringColumnFromArray(values) }
      : { kind: 'string', values };
  }
  const n = rows.ids.length;
  const ids = rows.ids;
  const strings = rows.strings;
  let missing = 0;
  for (let i = 0; i < n; i += 1) if (ids[i]! < 0) missing += 1;
  if (missing === n) {
    // No string seen: the old content check made this a number column.
    return { kind: 'number', values: new Float64Array(n).fill(NaN) };
  }
  if (!build) {
    const values = new Array<string | null>(n);
    for (let i = 0; i < n; i += 1) {
      const s = ids[i]!;
      values[i] = s < 0 ? null : strings[s]!;
    }
    return { kind: 'string', values };
  }
  const validity =
    missing === 0 ? undefined : validityFromPredicate(n, (i) => ids[i]! >= 0);
  if (n >= DICT_ENCODE_MIN_LENGTH && strings.length / n < DICT_ENCODE_RATIO) {
    if (missing > 0) for (let i = 0; i < n; i += 1) if (ids[i]! < 0) ids[i] = 0;
    return {
      kind: 'string',
      column: stringColumnDictEncoded(strings, ids, validity),
    };
  }
  const fallback = new Array<string | undefined>(n);
  for (let i = 0; i < n; i += 1) {
    const s = ids[i]!;
    fallback[i] = s < 0 ? undefined : strings[s]!;
  }
  return { kind: 'string', column: stringColumnFallback(fallback, validity) };
}
