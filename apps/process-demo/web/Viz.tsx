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
import { colorsForNodes, PALETTE } from './palette.js';
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
  /** The caller's name, when this output was one it asked for. */
  name?: string;
}

/**
 * A fold over one column, as the response returns it.
 *
 * The payload differs per reduction, so the shape is open — `last` has
 * `value`/`at`, `extremes` has `min`/`max`, and so on. The card below
 * narrows on `op` rather than guessing from the keys present.
 */
export interface Fact {
  id: string;
  /** The caller's own name for this output — what a card is keyed by. */
  name?: string;
  /** The fold that produced it — a registry name now, not an enum. */
  op: string;
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
/** The node a fact's column belongs to — longest matching id wins. */
function ownerOf(id: string, ids: Iterable<string>): string | undefined {
  let best: string | undefined;
  for (const key of ids) {
    if (
      id.startsWith(key) &&
      (best === undefined || key.length > best.length)
    ) {
      best = key;
    }
  }
  return best;
}

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

export function FactCard(props: {
  fact: Fact;
  explain: Record<string, string>;
  color?: string | undefined;
}) {
  const { fact } = props;
  const { label, suffix } = labelFor(fact.id, props.explain);
  const unit = fact.unit === null ? '' : fact.unit;

  const body = (() => {
    if (fact.op === 'last') {
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
    if (fact.op === 'extremes') {
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
    if (fact.op === 'percentileRank') {
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
    <li
      className="fact"
      // The node's colour, so a card and the curve it came from read as
      // the same thing without either being labelled.
      style={
        props.color === undefined ? undefined : { borderLeftColor: props.color }
      }
    >
      {/* The **name** leads. It is what the caller asked for, and the only
          thing distinguishing two outputs that read the same node the same
          way — which rendered as two identical cards until it was shown.
          The lineage is where the number came from, so it goes underneath. */}
      <div className="fact-head">
        <span className="fact-name" title={fact.id}>
          {fact.name ?? label}
        </span>
        <span className="fact-reduce">{fact.op}</span>
      </div>
      {body}
      {fact.name !== undefined && (
        <div className="fact-lineage" title={fact.id}>
          {label}
          {suffix && <span className="fact-suffix">· {suffix}</span>}
        </div>
      )}
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

/**
 * `ChartContainer` needs a pixel width, so the panel has to be measured.
 *
 * Measured **synchronously on mount** and then observed for changes.
 * Waiting for the observer's first callback made the whole panel render
 * nothing until a resize arrived — the props were all correct and the
 * width gate silently held everything back, which is indistinguishable
 * from a data bug and took far too long to tell apart from one. The
 * element's width is available the moment it is in the DOM; there is no
 * reason to ask an observer for it.
 */
function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = (w: number) => setWidth(Math.max(0, Math.floor(w)));
    measure(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([entry]) =>
      measure(entry!.contentRect.width),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** One node's chart. The band case reads `outs.length`, never an op name. */
function Figure(props: {
  id: string;
  outs: OutputInfo[];
  drawn: NonNullable<ReturnType<typeof useDrawn>>;
  width: number;
  color: string;
  caption: React.ReactNode;
  /**
   * Controlled view. Passing the same tuple to every figure and wiring
   * the callback back is what makes one pan move them all — the
   * container is explicit that uncontrolled mode holds its own view and
   * ignores later `range` props, so sharing requires controlling.
   */
  range?: readonly [number, number] | undefined;
  onRangeChange?: ((range: [number, number]) => void) | undefined;
}) {
  const { outs, drawn } = props;
  return (
    <figure>
      <figcaption>{props.caption}</figcaption>
      <ChartContainer
        width={props.width}
        range={props.range ?? drawn.range}
        theme={themeFor(props.color)}
        {...(props.onRangeChange !== undefined && {
          panZoom: 'panZoom' as const,
          onTimeRangeChange: props.onRangeChange,
        })}
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
}

/** A node's timing, as the workbook needs it. */
export interface NodeTiming {
  id: string;
  slot?: string;
  pulled: boolean;
  cached: boolean;
  ms: number;
  /** Upstream ids, or source column names — what fed this step. */
  inputs: readonly string[];
}

export function Viz(props: {
  frames: Frames | undefined;
  outputs: Record<string, OutputInfo[]>;
  explain: Record<string, string>;
  /**
   * Which question the panel is answering.
   *
   * `output` is what the prompt asked for and nothing else — the named
   * results. `workbook` shows the work: every node the plan resolved, in
   * dependency order, with the outputs at the bottom. Both read the same
   * response; only the filtering differs.
   */
  view: 'output' | 'workbook';
  /** Every resolved node, in dependency order. */
  nodes: readonly NodeTiming[];
  /** Output names the request asked for, as opposed to ones drawing added. */
  asked: readonly string[];
  /** The request's node definitions, keyed by slot — for the param chips. */
  defs: Record<string, { op: string; params?: Record<string, unknown> }>;
  /** Op metadata by name, for input roles. */
  ops: Record<string, { inputs: readonly { role: string; unit?: string }[] }>;
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
  // One colour map for the whole panel, derived the same way the pipeline
  // derives its own — so a box and its curve match without either being
  // told about the other.
  const colors = useMemo(() => colorsForNodes(props.nodes), [props.nodes]);
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

      {drawn !== undefined && width > 0 && props.view === 'output' && (
        <Output
          drawn={drawn}
          width={width}
          groups={groups}
          asked={props.asked}
          facts={props.facts}
          explain={props.explain}
          colors={colors}
        />
      )}

      {drawn !== undefined && width > 0 && props.view === 'workbook' && (
        <Workbook
          drawn={drawn}
          width={width}
          outputs={props.outputs}
          nodes={props.nodes}
          facts={props.facts}
          explain={props.explain}
          colors={colors}
          defs={props.defs}
          ops={props.ops}
        />
      )}

      {/* Facts still show before anything is drawn, so a facts-only
          response is not an empty panel. */}
      {drawn === undefined && props.facts.length > 0 && (
        <ul className="facts">
          {props.facts.map((f, i) => (
            <FactCard key={`${f.id}:${i}`} fact={f} explain={props.explain} />
          ))}
        </ul>
      )}

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

/**
 * What the prompt asked for, and nothing else.
 *
 * The request names its outputs; this shows those and stops. A node the
 * plan needed on the way — a `roc` under a `variance` under an
 * `annualise` — is real work and belongs in the workbook, not in the
 * answer. Filtering on `name` is what separates the two, which is the
 * reason outputs carry one.
 */
function Output(props: {
  drawn: NonNullable<ReturnType<typeof useDrawn>>;
  width: number;
  groups: [string, OutputInfo[]][];
  asked: readonly string[];
  facts: readonly Fact[];
  explain: Record<string, string>;
  colors: Map<string, string>;
}) {
  // An empty `asked` means the request named nothing — an older nested
  // plan, say — so everything is shown rather than nothing.
  const wanted = new Set(props.asked);
  const keep = (name: string | undefined) =>
    wanted.size === 0 || (name !== undefined && wanted.has(name));
  const named = props.groups.filter(([, outs]) =>
    outs.some((o) => keep(o.name)),
  );
  const shown = props.facts.filter((f) => keep(f.name));

  if (shown.length === 0 && named.length === 0) {
    return (
      <p className="muted">
        Nothing was named as an output. The workbook has the whole plan.
      </p>
    );
  }
  return (
    <>
      {shown.length > 0 && (
        <ul className="facts">
          {shown.map((f, i) => (
            <FactCard
              key={`${f.id}:${i}`}
              fact={f}
              explain={props.explain}
              color={props.colors.get(ownerOf(f.id, props.colors.keys()) ?? '')}
            />
          ))}
        </ul>
      )}
      {named.map(([id, outs]) => (
        <Figure
          key={id}
          id={id}
          outs={outs}
          drawn={props.drawn}
          width={props.width}
          color={props.colors.get(id) ?? PALETTE[0]!}
          caption={
            <>
              {outs[0]?.name ?? props.explain[id] ?? id}
              {outs[0]?.unit && <span className="meta"> · {outs[0].unit}</span>}
            </>
          }
        />
      ))}
    </>
  );
}

/**
 * The work, top to bottom, with the answers at the bottom.
 *
 * `nodes` arrives in dependency order — inputs before the things that
 * consume them — so walking it in order *is* the derivation, and no
 * ordering has to be reconstructed here. Each step carries the lineage
 * the library derived and the warm/cold badge, so the reader can see
 * both what was computed and what was already known.
 */
/** One node's inputs and params, as chips beside the step. */
function Wiring(props: {
  inputs: readonly string[];
  slotOf: Map<string, string>;
  colors: Map<string, string>;
  params: Record<string, unknown> | undefined;
  /** The op's declared inputs, in order — roles and any demanded unit. */
  roles: readonly { role: string; unit?: string }[];
}) {
  const chips = [
    ...props.inputs.map((ref, i) => {
      // `role: what-feeds-it`, which needs the op's declared inputs
      // rather than a count of them — the reason `OpDescriptor.inputs`
      // is now the `InputDef[]`. A two-input op reads correctly here
      // only because of that.
      const def = props.roles[i];
      const from = props.slotOf.get(ref) ?? ref;
      return {
        kind: 'in' as const,
        label: def === undefined ? from : `${def.role}: ${from}`,
        // A demanded unit is the other half: it is why a plan gets
        // rejected, and it was dropped by the old shape too.
        want: def?.unit,
        color: props.colors.get(ref),
      };
    }),
    ...Object.entries(props.params ?? {}).map(([k, v]) => ({
      kind: 'param' as const,
      label: `${k}: ${String(v)}`,
      want: undefined,
      color: undefined,
    })),
  ];
  if (chips.length === 0) return null;
  return (
    <div className="chips">
      {chips.map((c, i) => (
        <span
          key={`${c.kind}:${c.label}:${i}`}
          className={`chip ${c.kind}`}
          style={c.color === undefined ? undefined : { borderColor: c.color }}
        >
          {c.kind === 'in' && (
            <i
              className="chip-dot"
              style={{ background: c.color ?? 'var(--muted)' }}
            />
          )}
          {c.label}
          {c.want !== undefined && <em className="chip-want">{c.want}</em>}
        </span>
      ))}
    </div>
  );
}

/**
 * The work, top to bottom, with the answers at the bottom.
 *
 * `nodes` arrives in dependency order — inputs before the things that
 * consume them — so walking it in order *is* the derivation, and no
 * ordering has to be reconstructed here. Each step carries the lineage
 * the library derived, what fed it, and the warm/cold badge.
 *
 * Every chart is **controlled by one shared range**, so panning or
 * zooming any of them moves all of them: comparing a study against the
 * thing it was computed from is the whole reason to stack them.
 */
function Workbook(props: {
  drawn: NonNullable<ReturnType<typeof useDrawn>>;
  width: number;
  outputs: Record<string, OutputInfo[]>;
  nodes: readonly NodeTiming[];
  facts: readonly Fact[];
  explain: Record<string, string>;
  colors: Map<string, string>;
  /** The request's node definitions, for params. Keyed by slot. */
  defs: Record<string, { op: string; params?: Record<string, unknown> }>;
  /** Op metadata by name, for input roles. */
  ops: Record<string, { inputs: readonly { role: string; unit?: string }[] }>;
}) {
  const [view, setView] = useState<[number, number] | undefined>();
  // A new response resets the shared view; otherwise a pan survives data
  // it no longer describes.
  useEffect(() => setView(undefined), [props.drawn.range]);

  // Which single column of a multi-output node to isolate, if any.
  const [only, setOnly] = useState<Record<string, string>>({});

  const slotOf = useMemo(
    () => new Map(props.nodes.map((n) => [n.id, n.slot ?? n.id])),
    [props.nodes],
  );
  const known = useMemo(
    () => new Set(props.nodes.map((n) => n.id)),
    [props.nodes],
  );
  // Source columns are not nodes — nothing computed them — but the
  // derivation starts there, so the workbook names them. They carry no
  // chart: a raw column cannot be selected as an output, since `on`
  // takes a spec or an id and a source column is neither.
  const sources = useMemo(() => {
    const out = new Set<string>();
    for (const n of props.nodes) {
      for (const ref of n.inputs) if (!known.has(ref)) out.add(ref);
    }
    return [...out];
  }, [props.nodes, known]);

  return (
    <div className="workbook">
      <ol className="steps">
        {sources.map((name) => (
          <li key={name} className="step source">
            <div className="step-head">
              <span className="step-n">·</span>
              <span className="step-label">{name}</span>
              <span className="step-badge">source column</span>
            </div>
          </li>
        ))}

        {props.nodes.map((n, i) => {
          const all = props.outputs[n.id] ?? [];
          const isolated = only[n.id];
          const outs =
            isolated === undefined
              ? all
              : all.filter((o) => o.column === isolated);
          const state = !n.pulled ? 'idle' : n.cached ? 'cached' : 'computed';
          const color = props.colors.get(n.id) ?? PALETTE[0]!;
          const slot = n.slot ?? n.id;
          return (
            <li
              key={n.id}
              className={`step ${state}`}
              style={{ borderLeftColor: color }}
            >
              <div className="step-head">
                <span className="step-n" style={{ borderColor: color, color }}>
                  {i + 1}
                </span>
                {n.slot !== undefined && (
                  <span className="step-slot">{n.slot}</span>
                )}
                <span className="step-label" title={n.id}>
                  {props.explain[n.id] ?? n.id}
                </span>
                <span className="step-badge">
                  {!n.pulled
                    ? 'not requested'
                    : `${n.cached ? 'cached' : 'computed'} · ${n.ms} ms`}
                </span>
              </div>

              <Wiring
                inputs={n.inputs}
                slotOf={slotOf}
                colors={props.colors}
                params={props.defs[slot]?.params}
                roles={props.ops[props.defs[slot]?.op ?? '']?.inputs ?? []}
              />

              {/* A multi-output op draws as one band by default; the chips
                  page through its columns. Nothing here reads an op name —
                  it is `all.length` that decides there is anything to page. */}
              {all.length > 1 && (
                <div className="chips columns">
                  <button
                    className={isolated === undefined ? 'chip on' : 'chip'}
                    onClick={() =>
                      setOnly(({ [n.id]: _drop, ...rest }) => rest)
                    }
                  >
                    all
                  </button>
                  {all.map((o) => (
                    <button
                      key={o.column}
                      className={isolated === o.column ? 'chip on' : 'chip'}
                      onClick={() =>
                        setOnly((prev) => ({ ...prev, [n.id]: o.column }))
                      }
                    >
                      {o.column.slice(n.id.length) || o.column}
                    </button>
                  ))}
                </div>
              )}

              {outs.length > 0 ? (
                <Figure
                  id={n.id}
                  outs={outs}
                  drawn={props.drawn}
                  width={props.width - 26}
                  color={color}
                  range={view ?? props.drawn.range}
                  onRangeChange={setView}
                  caption={
                    outs[0]?.unit ? (
                      <span className="meta">{outs[0].unit}</span>
                    ) : null
                  }
                />
              ) : (
                <p className="muted step-note">
                  No column drawn for this step.
                </p>
              )}
            </li>
          );
        })}
      </ol>

      <div className="workbook-out">
        <h3>Outputs</h3>
        {props.facts.length === 0 ? (
          <p className="muted">This request asked for columns, not facts.</p>
        ) : (
          <ul className="facts">
            {props.facts.map((f, i) => (
              <FactCard
                key={`${f.id}:${i}`}
                fact={f}
                explain={props.explain}
                color={props.colors.get(
                  ownerOf(f.id, props.colors.keys()) ?? '',
                )}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
