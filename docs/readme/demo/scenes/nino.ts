/**
 * The Niño 3.4 record as a pond series: daily mean sea-surface temperature
 * over the box whose temperature defines El Niño and La Niña, 1982-01-01 to
 * 2026-08-03 (NOAA OISST v2.1, public domain; provenance in
 * website/src/examples/lib/nino34-samples.ts). The fixture drops 29 February
 * so every year has 365 slots; here each slot gets its real calendar date.
 */
import { TimeSeries } from 'pond-ts';
import {
  NINO34_FIRST_YEAR,
  NINO34_SST_DELTA_CENTI,
  NINO34_YEAR_LENGTHS,
} from '../../../../website/src/examples/lib/nino34-samples';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'sst', kind: 'number' },
] as const;

export function ninoDaily() {
  const time: number[] = [];
  const sst: number[] = [];
  let centi = 0;
  let k = 0;
  NINO34_YEAR_LENGTHS.forEach((days, y) => {
    const year = NINO34_FIRST_YEAR + y;
    let t = Date.UTC(year, 0, 1);
    for (let d = 0; d < days; d++) {
      if (new Date(t).getUTCMonth() === 1 && new Date(t).getUTCDate() === 29) {
        t += 86_400_000;
      }
      centi += NINO34_SST_DELTA_CENTI[k++]!;
      time.push(t);
      sst.push(centi / 100);
      t += 86_400_000;
    }
  });
  return TimeSeries.fromColumns({
    name: 'nino34',
    schema,
    columns: { time, sst },
  });
}
