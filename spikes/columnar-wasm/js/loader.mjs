/**
 * Isomorphic WASM loader — same file runs in Node and the browser.
 *
 * The only environment-specific line is how the `.wasm` bytes arrive:
 * `fs.readFile` under Node, `fetch` in the browser. Everything past
 * that is plain `WebAssembly` API, which is identical on both.
 *
 * Two things here are load-bearing beyond "instantiate a module", and
 * both are consequences of the hand-rolled ABI rather than accidents:
 *
 * 1. **SIMD is a module-level property, not a runtime branch.** wasm has
 *    no `cpuid`. A module containing `v128` instructions fails
 *    *validation* on an engine without SIMD — so feature detection means
 *    probing with a tiny throwaway module and then choosing which of two
 *    binaries to fetch. That's the `hasSimd()` dance below.
 *
 * 2. **Typed-array views detach when memory grows.** Every
 *    `new Float64Array(memory.buffer, ptr, n)` is invalidated by any
 *    `memory.grow` — including one triggered by an allocation deep
 *    inside a later WASM call. Caching views across calls is the
 *    classic way to get silent `ArrayBuffer is detached` errors in
 *    production, so `Mem` re-derives its views whenever it notices the
 *    buffer identity changed.
 */

/**
 * Minimal SIMD-capable module — `(module (func (result v128)
 * (i8x16.splat (i32.const 0))))`. Validation fails on a non-SIMD
 * engine, which is the whole detection mechanism.
 */
const SIMD_PROBE = new Uint8Array([
  0x00,
  0x61,
  0x73,
  0x6d,
  0x01,
  0x00,
  0x00,
  0x00, // magic + version 1
  0x01,
  0x05,
  0x01,
  0x60,
  0x00,
  0x01,
  0x7b, //       type[0] = () -> v128
  0x03,
  0x02,
  0x01,
  0x00, //                          func[0] : type[0]
  0x0a,
  0x08,
  0x01,
  0x06, //                          code section, 1 body, 6 bytes
  0x00, //                                              0 local decls
  0x41,
  0x00, //                                        i32.const 0
  0xfd,
  0x0f, //                                        i8x16.splat  ← the v128 op
  0x0b, //                                              end
]);

let simdSupport;
/** True when the engine validates a module containing v128 opcodes. */
export function hasSimd() {
  if (simdSupport === undefined) {
    try {
      simdSupport = WebAssembly.validate(SIMD_PROBE);
    } catch {
      simdSupport = false;
    }
  }
  return simdSupport;
}

async function readWasm(url) {
  if (typeof window === 'undefined' && typeof process !== 'undefined') {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    return readFile(url instanceof URL ? fileURLToPath(url) : url);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ${url}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Cached views over the instance's linear memory. Re-derived on
 * `memory.grow` (detected by buffer identity, which is the only signal
 * the WebAssembly API gives us).
 */
class Mem {
  #memory;
  #buffer = null;
  f64;
  i32;
  u8;

  constructor(memory) {
    this.#memory = memory;
    this.#refresh();
  }

  #refresh() {
    const b = this.#memory.buffer;
    this.#buffer = b;
    this.f64 = new Float64Array(b);
    this.i32 = new Int32Array(b);
    this.u8 = new Uint8Array(b);
  }

  /** Call before any pointer dereference that follows a WASM call. */
  sync() {
    if (this.#memory.buffer !== this.#buffer) this.#refresh();
    return this;
  }

  get bytes() {
    return this.#memory.buffer.byteLength;
  }
}

/**
 * Instantiates the substrate module.
 *
 * @param {object}  [opts]
 * @param {URL|string} [opts.url]   explicit .wasm URL (skips SIMD selection)
 * @param {boolean} [opts.simd]     force the SIMD/scalar build
 * @param {(v:number,i:number)=>void} [opts.hostEmit]
 *        satisfies the `env.host_emit` import used by `col_scan_host`.
 *        Defaulted to a no-op so callers that never scan don't have to
 *        care that the import exists.
 */
export async function loadSubstrate(opts = {}) {
  const useSimd = opts.simd ?? hasSimd();
  const url =
    opts.url ??
    new URL(
      useSimd ? '../pkg/pond_columnar.simd.wasm' : '../pkg/pond_columnar.wasm',
      import.meta.url,
    );

  const bytes = await readWasm(url);
  const t0 = performance.now();
  const { instance, module } = await WebAssembly.instantiate(bytes, {
    env: {
      host_emit: opts.hostEmit ?? (() => {}),
    },
  });
  const instantiateMs = performance.now() - t0;

  const exports = instance.exports;
  const mem = new Mem(exports.memory);

  return {
    exports,
    module,
    mem,
    simd: useSimd,
    byteLength: bytes.length,
    instantiateMs,
  };
}

/**
 * Re-instantiates an already-compiled module. Splitting compile from
 * instantiate is how a real integration would amortise startup (compile
 * once, instantiate per worker), so the bench measures them separately.
 */
export async function instantiateAgain(module, hostEmit) {
  const t0 = performance.now();
  const instance = await WebAssembly.instantiate(module, {
    env: { host_emit: hostEmit ?? (() => {}) },
  });
  return { instance, ms: performance.now() - t0 };
}
