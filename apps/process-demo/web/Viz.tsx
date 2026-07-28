/**
 * The `viz` tab — M3.
 *
 * The interesting line in this file is `TimeSeries.fromColumns`. The
 * server sends raw `Float64Array` buffers, and `fromColumns` **adopts**
 * them rather than copying, treating NaN as a gap. So a study's column
 * goes from the graph's `Outlet` to a stroked line without ever being
 * boxed, on either side of the wire.
 *
 * That settles the fork the demo plan named. `@pond-ts/charts` already
 * traverses columnar — the key axis is a zero-copy `subarray`, values
 * land in a `Float64Array`, and no per-row object is allocated on the
 * render path — so a layer's `series` + `column` signature was never the
 * problem. What was wrong was assembling the series on the **producer**
 * side: it cannot cross a wire, so `run({ assemble: false })` and the
 * consumer builds its own for free.
 *
 * Chart choice is by shape, per the demo plan:
 *
 * | what             | chart |
 * | ---------------- | ----- |
 * | multi-output op  | band  |
 * | single-output op | line  |
 * | nothing drawable | JSON  |
 *
 * The band case is the multi-output naming decision paying off: a
 * bollinger is **one** `outputs` entry carrying three columns, so the
 * renderer draws an envelope rather than three unrelated lines. Nothing
 * here inspects op names to work that out — it reads `outputs.length`.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { TimeSeries, type SeriesSchema } from 'pond-ts';
import {
  BandChart,
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
  defaultTheme,
  type ChartTheme,
} from '@pond-ts/charts';

export interface Frames {
  length: number;
  /** Identifies the keys, so a caller can report already holding them. */
  keyId: string;
  /** Absent when the server skipped it because we said we had it. */
  key?: string | undefined;
  columns: Record<string, string>;
  bytes: number;
}

export interface OutputInfo {
  column: string;
  unit: string | null;
}

/**
 * A fold over one column, as the response returns it.
 *
 * The payload differs per reduction, so the shape is open — `last` has
 * `value`/`at`, `extremes` has `min`/`max`, and so on. The card below
 * narrows on `reduce` rather than guessing from the keys present.
 */
export interface Fact {
  id: string;
  reduce: 'last' | 'extremes' | 'percentileRank' | 'shape';
  unit: string | null;
  [k: string]: unknown;
}

interface Point {
  value: number;
  at: string;
}

const isPoint = (v: unknown): v is Point =>
  typeof v === 'object' && v !== null && typeof (v as Point).value === 'number';

/** Enough precision to be useful, not so much that a card becomes a number dump. */
function show(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 0 : abs >= 1 ? 2 : 4;
  return value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/**
 * A fact names a **column**, which is a spec id plus an output suffix,
 * while `explain` is keyed by the spec id alone. Longest-prefix wins, so
 * a band's `…Upper` finds its parent and keeps the suffix as the label.
 */
function labelFor(
  id: string,
  explain: Record<string, string>,
): { label: string; suffix: string } {
  let best = '';
  for (const key of Object.keys(explain)) {
    if (id.startsWith(key) && key.length > best.length) best = key;
  }
  return best === ''
    ? { label: id, suffix: '' }
    : { label: explain[best]!, suffix: id.slice(best.length) };
}

function FactCard(props: { fact: Fact; explain: Record<string, string> }) {
  const { fact } = props;
  const { label, suffix } = labelFor(fact.id, props.explain);
  const unit = fact.unit === null ? '' : fact.unit;

  const body = (() => {
    if (fact.reduce === 'last') {
      if (typeof fact['value'] !== 'number')
        return <span className="muted">no value</span>;
      return (
        <>
          <div className="fact-value">
            {show(fact['value'])}
            {unit && <span className="fact-unit">{unit}</span>}
          </div>
          {typeof fact['at'] === 'string' && (
            <div className="fact-at">at {fact['at']}</div>
          )}
        </>
      );
    }
    if (fact.reduce === 'extremes') {
      const lo = fact['min'];
      const hi = fact['max'];
      if (!isPoint(lo) || !isPoint(hi))
        return <span className="muted">no range</span>;
      return (
        <div className="fact-pair">
          {[
            ['low', lo],
            ['high', hi],
          ].map(([name, p]) => (
            <div key={name as string}>
              <div className="fact-sub">{name as string}</div>
              <div className="fact-value">
                {show((p as Point).value)}
                {unit && <span className="fact-unit">{unit}</span>}
              </div>
              <div className="fact-at">at {(p as Point).at}</div>
            </div>
          ))}
        </div>
      );
    }
    if (fact.reduce === 'percentileRank') {
      if (typeof fact['value'] !== 'number')
        return <span className="muted">no rank</span>;
      const pct = fact['value'] * 100;
      return (
        <>
          <div className="fact-value">
            {pct.toFixed(0)}
            <span className="fact-unit">th pct</span>
          </div>
          {/* The bar is the reduction's own meaning, drawn rather than
              described — where the latest value sits in its own history. */}
          <div className="fact-bar">
            <span style={{ width: `${Math.max(1, Math.min(100, pct))}%` }} />
          </div>
          {typeof fact['note'] === 'string' && (
            <div className="fact-at">{fact['note']}</div>
          )}
        </>
      );
    }
    const points = typeof fact['points'] === 'number' ? fact['points'] : 0;
    return (
      <>
        <div className="fact-value">{points}</div>
        <div className="fact-at">sampled points</div>
      </>
    );
  })();

  return (
    <li className="fact">
      {/* One row, not an absolutely-positioned chip: a long label and a
          long reduction name (`percentileRank`) overlapped. */}
      <div className="fact-head">
        <span className="fact-name" title={fact.id}>
          {label}
          {suffix && <span className="fact-suffix">· {suffix}</span>}
        </span>
        <span className="fact-reduce">{fact.reduce}</span>
      </div>
      {body}
    </li>
  );
}

/** base64 → `Float64Array`, one pass, no per-number parse. */
function decode(b64: string): Float64Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Float64Array(bytes.buffer);
}

const PALETTE = ['#6fb3ff', '#f0b429', '#4fd1a5', '#c792ea', '#ff7a7a'];

/** Styling is a theme channel, not a per-layer prop — one theme per figure. */
function themeFor(color: string): ChartTheme {
  return {
    ...defaultTheme,
    background: '#10131a',
    line: { ...defaultTheme.line, default: { color, width: 1.25 } },
    band: { ...defaultTheme.band, default: { fill: color, opacity: 0.22 } },
  };
}

/**
 * One series carrying every drawn column.
 *
 * Built once for the whole response rather than per figure — the key
 * column is shared, and `fromColumns` adopts each value buffer zero-copy,
 * so this is effectively free.
 */
function useDrawn(frames: Frames | undefined) {
  return useMemo(() => {
    if (frames === undefined || frames.length === 0) return undefined;
    // `key` is absent only if the caller claimed to hold it and then
    // failed to re-attach it — a bug rather than a state to render.
    if (frames.key === undefined) return undefined;
    const names = Object.keys(frames.columns);
    if (names.length === 0) return undefined;
    const schema = [
      { name: 'time', kind: 'time' },
      ...names.map((name) => ({ name, kind: 'number' })),
    ] as unknown as SeriesSchema;
    const columns: Record<string, Float64Array> = { time: decode(frames.key) };
    for (const name of names) columns[name] = decode(frames.columns[name]!);
    const series = TimeSeries.fromColumns({ name: 'drawn', schema, columns });
    const keys = columns['time']!;
    return {
      series,
      range: [keys[0] ?? 0, keys[keys.length - 1] ?? 0] as [number, number],
    };
  }, [frames]);
}

/** `ChartContainer` needs a pixel width, so the panel has to be measured. */
function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const ro = new ResizeObserver(([entry]) => {
      setWidth(Math.max(0, Math.floor(entry!.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

export function Viz(props: {
  frames: Frames | undefined;
  outputs: Record<string, OutputInfo[]>;
  explain: Record<string, string>;
  /** A draw is in flight. */
  pending: boolean;
  /** There is no plan to draw from yet — the compose has not landed. */
  waiting: boolean;
  /**
   * A newer run is in flight, but the last render is still on screen and
   * stays there. Reported as a chip rather than by blanking the panel.
   */
  refreshing?: boolean | undefined;
  /** The last draw failed. Shown with a retry rather than swallowed. */
  error?: string | undefined;
  facts: readonly Fact[];
  onDraw: () => void;
}) {
  const drawn = useDrawn(props.frames);
  const [ref, width] = useWidth();
  const groups = Object.entries(props.outputs).filter(([, o]) => o.length > 0);
  // Anything already drawn keeps rendering; only a panel with nothing in
  // it yet gets a message instead of content.
  const blank = drawn === undefined;
  const idle =
    blank && !props.pending && !props.waiting && props.error === undefined;

  return (
    <div className="viz" ref={ref}>
      {blank && props.waiting && <p className="muted">Waiting for the plan…</p>}
      {blank && props.pending && <p className="muted">Drawing…</p>}
      {props.refreshing === true && (
        <p className="muted refreshing">updating…</p>
      )}
      {blank && props.error !== undefined && (
        <>
          <p className="notice bad">{props.error}</p>
          <button onClick={props.onDraw}>Try again</button>
        </>
      )}
      {idle && (
        <>
          <p className="muted">
            This response carries facts, not columns — a reduction never
            materializes one, which is the point of <code>select</code>. Ask for
            the columns and they will be fetched and drawn.
          </p>
          <button onClick={props.onDraw}>Fetch columns and draw</button>
        </>
      )}

      {/* Facts first: a reduction is the answer to the question, and the
          chart is the evidence behind it. */}
      {props.facts.length > 0 && (
        <ul className="facts">
          {props.facts.map((f, i) => (
            <FactCard
              key={`${f.id}:${f.reduce}:${i}`}
              fact={f}
              explain={props.explain}
            />
          ))}
        </ul>
      )}

      {drawn !== undefined &&
        width > 0 &&
        groups.map(([id, outs], g) => {
          const color = PALETTE[g % PALETTE.length]!;
          return (
            <figure key={id}>
              <figcaption>
                {props.explain[id] ?? id}
                {outs[0]?.unit && (
                  <span className="meta"> · {outs[0].unit}</span>
                )}
              </figcaption>
              <ChartContainer
                width={width}
                range={drawn.range}
                theme={themeFor(color)}
              >
                <ChartRow height={170}>
                  <YAxis id="y" width={62} />
                  <Layers>
                    {outs.length === 3 ? (
                      <>
                        <BandChart
                          axis="y"
                          series={drawn.series}
                          lower={outs[2]!.column}
                          upper={outs[0]!.column}
                        />
                        <LineChart
                          axis="y"
                          series={drawn.series}
                          column={outs[1]!.column}
                        />
                      </>
                    ) : (
                      outs.map((o) => (
                        <LineChart
                          key={o.column}
                          axis="y"
                          series={drawn.series}
                          column={o.column}
                        />
                      ))
                    )}
                  </Layers>
                </ChartRow>
              </ChartContainer>
            </figure>
          );
        })}

      {drawn !== undefined && props.frames && (
        <p className="muted">
          {drawn.series.length.toLocaleString()} points ·{' '}
          {(props.frames.bytes / 1024 / 1024).toFixed(2)} MB of buffers, adopted
          zero-copy by <code>TimeSeries.fromColumns</code>.
        </p>
      )}
    </div>
  );
}
