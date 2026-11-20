/** Shared parts of the README scenes: the card header and the mount step. */
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

/** Width of the recorded card, in CSS pixels (record.mjs styles `.card`). */
export const WIDTH = 880;
/** Width the charts get inside the card's padding. */
export const CHART_WIDTH = WIDTH - 32;

export interface Scene {
  frames: number;
  fps?: number;
  /** Fixed card height in CSS pixels, for scenes whose parts differ in
   *  height (every frame of a GIF must be the same size). */
  height?: number;
  step(f: number): void;
  pointer?(f: number, width: number): { x: number; y: number } | null;
}

export function Header({
  title,
  sub,
  code,
  stats,
}: {
  title: string;
  sub: string;
  /** The pond call behind the frame, shown as it changes. */
  code?: string;
  stats: ReadonlyArray<readonly [label: string, value: string]>;
}) {
  return (
    <div className="head">
      <div>
        <div className="title">
          <span className="dot" />
          <span>
            <b>{title}</b>
            <span className="sub"> · {sub}</span>
          </span>
        </div>
        {code ? <code className="call">{code}</code> : null}
      </div>
      <div className="stats">
        {stats.map(([l, v]) => (
          <div className="stat" key={l}>
            <div className="v">{v}</div>
            <div className="l">{l}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Render `view(f)` into #root and hand the recorder a scene whose `step(f)`
 *  re-renders frame `f` synchronously. */
export function mount(
  view: (f: number) => ReactNode,
  scene: Omit<Scene, 'step'> & { step?: (f: number) => void },
) {
  const root = createRoot(document.getElementById('root')!);
  const style = scene.height
    ? { height: scene.height, overflow: 'hidden' as const }
    : undefined;
  const card = (f: number) => (
    <div className="card" style={style}>
      {view(f)}
    </div>
  );
  flushSync(() => root.render(card(0)));
  const full: Scene = {
    ...scene,
    step(f) {
      scene.step?.(f);
      flushSync(() => root.render(card(f)));
    },
  };
  (window as unknown as { scene: Scene }).scene = full;
}

export const fmtInt = (n: number) => n.toLocaleString('en-US');

/** Ease in and out over 0..1. */
export const ease = (t: number) =>
  t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
