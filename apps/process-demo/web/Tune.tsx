/**
 * Param controls for the selected node — the registry's fourth reader.
 *
 * `Registry`'s own docstring claims one declaration serves four readers:
 * param validation, the JSON Schema projection, unit propagation, and **a
 * UI picker**. Three were exercised by M2–M5. This is the fourth, and it
 * needs no new API: `/api/context` already carries `kind`, `min`, `max`
 * and `default` per param, straight out of `describe()`.
 *
 * It is also the workload that started [PND-PROCIDENT] — "a user dragging
 * a study's `period` through 20 positions left 20 permanently-cached
 * nodes and +457 MB". That was measured in a script; here you can drag it.
 *
 * **Tuning never calls the model.** Moving a slider patches
 * `nodes[slot].params` and re-runs, which is [PND-PROCSLOT]'s "refinement
 * becomes a patch" claim made literal — and only possible because a slot
 * survives the param edit that moves every derived id.
 *
 * Sliders are drawn on the param's `suggest` range, which the registry
 * carries precisely because this panel needed it. It replaced a log scale
 * that existed only to make a 2…5000 travel bearable, and it fixed a
 * control that was outright broken: `barsPerYear` declares no `max`, so
 * the slider fell back to 100 while the default sat at 105,120 — pinned
 * at the right edge, and any drag silently destroyed the annualisation.
 *
 * A param without `suggest` still falls back to the legal bounds. That
 * path is now unexercised by the demo vocabulary, which is the point.
 *
 * Still missing: **only numeric params exist in this vocabulary**, so
 * `choice` and `flag` are unexercised. The controls are written for them,
 * but nothing here proves they are right.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

export interface ParamDef {
  kind: 'integer' | 'number' | 'enum' | 'boolean';
  default: number | string | boolean;
  min?: number;
  max?: number;
  suggest?: [number, number];
  of?: string[];
  label?: string;
}

export interface OpDescriptor {
  name: string;
  params: Record<string, ParamDef>;
}

/**
 * The range to draw on: the useful one where declared, else the legal
 * one, else a guess.
 *
 * **Always widened to include the current value.** `suggest` is advisory,
 * so a plan may legitimately arrive with a `period` of 1000 against a
 * suggestion of 5–200 — and a slider that cannot represent the value it
 * is bound to does not clamp the display, it clamps the *param*, the
 * moment the value is read back out of it.
 */
function span(d: ParamDef, value: number): [number, number] {
  const [lo, hi] = d.suggest ?? [d.min ?? 0, d.max ?? 100];
  return [Math.min(lo, value), Math.max(hi, value)];
}

/** Integers step by whole values, and never by less than one. */
function step(d: ParamDef, [lo, hi]: [number, number]): number {
  const fine = (hi - lo) / 1000;
  return d.kind === 'integer' ? Math.max(1, Math.round(fine)) : fine;
}

export function Tune(props: {
  op: string;
  slot: string;
  /** The node's current params, defaults already applied by the caller. */
  params: Record<string, unknown>;
  defs: Record<string, ParamDef>;
  /** Resident nodes on the host — [PND-PROCIDENT]'s bill, live. */
  resident: number | undefined;
  onChange: (params: Record<string, unknown>) => void;
}) {
  const keys = useMemo(() => Object.keys(props.defs), [props.defs]);
  // Local state so a drag stays smooth; the debounce below decides when
  // the graph actually hears about it.
  const [draft, setDraft] = useState(props.params);
  useEffect(() => setDraft(props.params), [props.params]);

  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const push = (next: Record<string, unknown>) => {
    setDraft(next);
    clearTimeout(timer.current);
    // Short enough that a drag still thrashes the cache — which is the
    // thing worth watching — long enough not to queue a request per pixel.
    timer.current = setTimeout(() => props.onChange(next), 120);
  };

  if (keys.length === 0) {
    return (
      <p className="muted tune-empty">
        <code>{props.op}</code> takes no params.
      </p>
    );
  }

  return (
    <div className="tune">
      <div className="tune-head">
        <span className="tune-slot">{props.slot}</span>
        <code>{props.op}</code>
        {props.resident !== undefined && (
          <span className="tune-resident" title="Nodes resident on the host">
            {props.resident} node{props.resident === 1 ? '' : 's'} resident
          </span>
        )}
      </div>

      {keys.map((key) => {
        const d = props.defs[key]!;
        const value = draft[key] ?? d.default;

        if (d.kind === 'boolean') {
          return (
            <label key={key} className="tune-row">
              <span className="tune-label">{d.label ?? key}</span>
              <input
                type="checkbox"
                checked={value === true}
                onChange={(e) => push({ ...draft, [key]: e.target.checked })}
              />
            </label>
          );
        }

        if (d.kind === 'enum') {
          return (
            <label key={key} className="tune-row">
              <span className="tune-label">{d.label ?? key}</span>
              <select
                value={String(value)}
                onChange={(e) => push({ ...draft, [key]: e.target.value })}
              >
                {(d.of ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </label>
          );
        }

        const n = Number(value);
        const range = span(d, n);
        const beyond =
          d.suggest !== undefined && (n < d.suggest[0] || n > d.suggest[1]);
        return (
          <label key={key} className="tune-row">
            <span className="tune-label">
              {d.label ?? key}
              {beyond && (
                <span
                  className="tune-scale"
                  title={`Outside the usual ${d.suggest![0]}–${d.suggest![1]}`}
                >
                  wide
                </span>
              )}
            </span>
            <input
              type="range"
              min={range[0]}
              max={range[1]}
              step={step(d, range)}
              value={n}
              onChange={(e) =>
                push({ ...draft, [key]: Number(e.target.value) })
              }
            />
            <span className="tune-value">{n}</span>
          </label>
        );
      })}
    </div>
  );
}
