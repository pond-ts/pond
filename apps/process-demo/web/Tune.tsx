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
 * Two things the registry does not carry, both visible the moment you
 * drag one:
 *
 * - **`min`/`max` are validation bounds, not display bounds.** `period`
 *   is legal to 5000 and interesting below ~300, so a linear slider
 *   spends 94% of its travel in a range nobody wants. A log scale is a
 *   workaround; a `suggest` range would be the fix.
 * - **Only numeric params exist in this vocabulary**, so `choice` and
 *   `flag` are unexercised here. The controls are written for them, but
 *   nothing in the demo proves they are right.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

export interface ParamDef {
  kind: 'integer' | 'number' | 'enum' | 'boolean';
  default: number | string | boolean;
  min?: number;
  max?: number;
  of?: string[];
  label?: string;
}

export interface OpDescriptor {
  name: string;
  params: Record<string, ParamDef>;
}

/** A linear slider over a 2…5000 range is unusable; a log one is not. */
const isWide = (d: ParamDef): boolean =>
  d.min !== undefined &&
  d.max !== undefined &&
  d.max / Math.max(d.min, 1) > 100;

function toSlider(value: number, d: ParamDef): number {
  const min = d.min ?? 0;
  const max = d.max ?? 100;
  if (!isWide(d)) return value;
  const lo = Math.log(Math.max(min, 1));
  const hi = Math.log(max);
  return ((Math.log(Math.max(value, 1)) - lo) / (hi - lo)) * 1000;
}

function fromSlider(pos: number, d: ParamDef): number {
  const min = d.min ?? 0;
  const max = d.max ?? 100;
  if (!isWide(d)) return d.kind === 'integer' ? Math.round(pos) : pos;
  const lo = Math.log(Math.max(min, 1));
  const hi = Math.log(max);
  const raw = Math.exp(lo + (pos / 1000) * (hi - lo));
  return d.kind === 'integer' ? Math.round(raw) : Math.round(raw * 100) / 100;
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
        const wide = isWide(d);
        return (
          <label key={key} className="tune-row">
            <span className="tune-label">
              {d.label ?? key}
              {wide && <span className="tune-scale">log</span>}
            </span>
            <input
              type="range"
              min={wide ? 0 : (d.min ?? 0)}
              max={wide ? 1000 : (d.max ?? 100)}
              step={wide ? 1 : d.kind === 'integer' ? 1 : 0.01}
              value={toSlider(n, d)}
              onChange={(e) =>
                push({ ...draft, [key]: fromSlider(Number(e.target.value), d) })
              }
            />
            <span className="tune-value">{n}</span>
          </label>
        );
      })}
    </div>
  );
}
