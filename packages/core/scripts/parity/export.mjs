// An Arrow IPC file written by pond-ts the way its docs say to (see
// `toArrow` in src/batch/operators/to-arrow.ts): every field, the time key
// included, as Float64 from pond's own buffers. pond-rs reads it in
// crates/pond-rs/tests/core_parity.rs and must get the `noisy` input back
// exactly, so Rust is checked against real pond-ts output, not just files
// pond-rs or Python wrote.
import { Float64, Table, makeData, makeVector, tableToIPC } from 'apache-arrow';
import { noisySeries } from './cases.mjs';

export const EXPORT_FILE = 'parity-export.arrow';

/** The IPC bytes; `pond` is the pond-ts module (built or source). */
export function buildArrowExport(pond) {
  const { fields } = noisySeries(pond).toArrow();
  const columns = {};
  for (const f of fields) {
    if (f.type !== 'float64' && f.type !== 'timestamp') throw new Error(f.type);
    columns[f.name] = makeVector(
      makeData({
        type: new Float64(),
        length: f.length,
        nullCount: f.nullCount,
        nullBitmap: f.nullBitmap,
        data: f.values,
      }),
    );
  }
  return tableToIPC(new Table(columns), 'file');
}
