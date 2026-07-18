import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
} from '@pond-ts/charts';
import { TimeSeries } from 'pond-ts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import {
  ConceptControls,
  Slider,
  ToggleChips,
} from '@site/src/components/ConceptViz';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
] as const;

function hexToRgb(h: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(h.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(a: string, b: string, t: number): string {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  if (!A || !B) return b;
  const c = A.map((x, i) => Math.round(x + (B[i] - x) * t));
  return `#${c.map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

function useMeasuredWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () =>
      setWidth(Math.round(el.getBoundingClientRect().width));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

// Real daily sunspot counts, 600 days from 2023-10-10. A genuine noisy source —
// the ~27-day solar-rotation modulation plus day-to-day scatter is exactly what
// separates the three smoothers. Source: SILSO, World Data Center for the
// production, preservation and dissemination of the international sunspot
// number, Royal Observatory of Belgium (public domain).
const SUNSPOTS = [
  132, 145, 137, 113, 111, 104, 97, 74, 66, 57, 67, 68, 55, 34, 39, 33, 54, 58,
  49, 58, 73, 107, 115, 122, 121, 92, 91, 77, 78, 113, 99, 94, 81, 82, 73, 60,
  33, 30, 26, 32, 68, 96, 153, 160, 186, 167, 177, 171, 158, 150, 161, 148, 123,
  100, 104, 113, 107, 134, 125, 113, 127, 123, 92, 96, 110, 117, 114, 124, 112,
  138, 150, 149, 152, 148, 138, 117, 113, 110, 76, 95, 83, 65, 52, 55, 68, 59,
  100, 119, 148, 172, 162, 158, 178, 186, 182, 181, 161, 140, 134, 147, 130,
  143, 134, 155, 166, 148, 124, 92, 83, 64, 68, 74, 74, 100, 117, 122, 124, 135,
  158, 159, 148, 161, 127, 151, 162, 156, 136, 141, 150, 139, 113, 100, 73, 54,
  49, 56, 104, 108, 115, 132, 120, 130, 126, 117, 96, 102, 109, 110, 100, 96,
  102, 96, 77, 74, 83, 81, 68, 52, 62, 73, 120, 132, 123, 159, 163, 154, 161,
  163, 138, 113, 98, 79, 51, 63, 31, 36, 37, 49, 78, 80, 83, 78, 56, 56, 91, 87,
  121, 150, 171, 185, 211, 224, 242, 232, 233, 266, 268, 251, 211, 142, 138,
  117, 99, 86, 119, 144, 160, 186, 185, 205, 192, 171, 181, 172, 173, 199, 244,
  203, 208, 213, 203, 180, 181, 155, 177, 165, 143, 142, 112, 130, 144, 164,
  169, 159, 156, 178, 205, 213, 213, 181, 158, 163, 173, 154, 124, 106, 124,
  151, 158, 148, 151, 140, 133, 151, 165, 150, 159, 163, 153, 146, 179, 174,
  179, 219, 212, 198, 197, 178, 138, 138, 128, 121, 111, 143, 183, 172, 162,
  176, 211, 242, 286, 284, 290, 274, 228, 219, 172, 173, 173, 180, 198, 210,
  202, 213, 231, 270, 259, 241, 231, 231, 214, 240, 275, 285, 264, 250, 245,
  230, 209, 178, 157, 199, 198, 202, 225, 217, 210, 213, 214, 223, 204, 220,
  182, 189, 153, 158, 181, 170, 182, 171, 169, 170, 177, 168, 156, 152, 141,
  147, 132, 109, 107, 95, 132, 132, 102, 105, 117, 122, 129, 123, 134, 129, 136,
  154, 154, 149, 169, 213, 211, 207, 210, 182, 170, 163, 140, 142, 141, 136,
  125, 137, 136, 109, 119, 143, 138, 132, 134, 162, 117, 120, 135, 180, 217,
  241, 244, 221, 205, 209, 223, 211, 207, 191, 207, 207, 210, 189, 164, 160,
  151, 117, 111, 91, 71, 73, 96, 115, 124, 123, 118, 146, 152, 172, 171, 159,
  205, 172, 163, 124, 124, 133, 122, 123, 120, 105, 133, 140, 115, 135, 108,
  106, 112, 99, 103, 99, 90, 113, 128, 149, 164, 183, 224, 223, 241, 255, 257,
  254, 233, 218, 183, 201, 184, 199, 213, 196, 171, 136, 119, 162, 128, 109,
  111, 90, 78, 79, 128, 151, 144, 148, 180, 169, 151, 174, 137, 119, 107, 54,
  75, 82, 106, 146, 158, 189, 188, 176, 164, 186, 161, 134, 127, 109, 94, 104,
  117, 161, 172, 206, 204, 174, 133, 140, 166, 178, 187, 164, 166, 124, 130,
  117, 116, 147, 123, 154, 143, 129, 106, 91, 101, 108, 144, 157, 172, 182, 179,
  207, 204, 194, 165, 162, 149, 176, 129, 79, 77, 46, 84, 78, 91, 124, 142, 159,
  149, 165, 192, 188, 179, 161, 147, 140, 139, 131, 122, 106, 87, 75, 90, 109,
  117, 116, 133, 141, 186, 164, 201, 198, 173, 132, 121, 110, 88, 63, 42, 58,
  76, 94, 89, 75, 81, 73, 71, 66, 60, 58, 47, 41, 59, 51, 55, 65, 74, 91, 98,
  117, 99, 97, 111, 104, 108, 100, 117, 115,
];
const DAY_MS = 86_400_000;
const BASE = Date.UTC(2023, 9, 10);
const HEIGHT = 240;

const source = TimeSeries.fromJSON({
  name: 'sunspots',
  schema,
  rows: SUNSPOTS.map((v, i) => [BASE + i * DAY_MS, v]),
});
const RANGE = source.timeRange()!;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

type Method = 'ema' | 'ma' | 'loess';

/**
 * The `smooth` comparison figure. One real, noisy source (daily sunspot counts,
 * drawn as a faint grey line) with the three smoothers — real `source.smooth(...)`:
 * **EMA** (reactive, lags), a centered **moving average** (stable, rounds the
 * peaks), and **LOESS** (follows the shape) — toggled on top. One strength
 * slider drives the pond option behind all three (alpha / window / span).
 */
export default function CoreSmoothing() {
  const base = useSiteChartTheme();
  const teal = base.line?.default?.color ?? '#0e8f86';
  const blue = base.line?.secondary?.color ?? '#3d6fd9';
  const purple = base.line?.context?.color ?? '#8354cc';
  const grey = base.axis?.label ?? '#8899aa';

  const theme = useMemo(() => {
    const faintGrey = mix(base.background ?? '#ffffff', grey, 0.6);
    return {
      ...base,
      line: {
        ...base.line,
        source: { color: faintGrey, width: 1.2 },
        ema: { color: blue, width: 2 },
        ma: { color: purple, width: 2 },
        loess: { color: teal, width: 2 },
      },
    };
  }, [base, blue, purple, teal, grey]);

  const [boxRef, width] = useMeasuredWidth<HTMLDivElement>();
  const [strength, setStrength] = useState(45); // 0-100
  const [on, setOn] = useState<Method[]>(['ema', 'ma', 'loess']);
  const toggle = (m: Method) =>
    setOn((cur) =>
      cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m],
    );

  const smoothed = useMemo(() => {
    const s = strength / 100;
    // One effective window (in days) drives all three, so at any slider position
    // they smooth at a *comparable* scale — the differences you see are method
    // character, not bandwidth: EMA lags (span-equivalent alpha = 2/(W+1)), the
    // centered moving average rounds symmetric peaks, and LOESS (span = W/N)
    // follows local curvature through them.
    const w = Math.round(lerp(4, 48, s));
    const alpha = 2 / (w + 1);
    const window = `${w}d`;
    const span = Math.min(1, Math.max(0.02, w / SUNSPOTS.length));
    return source
      .smooth('value', 'ema', { alpha, output: 'ema' })
      .smooth('value', 'movingAverage', {
        window,
        alignment: 'centered',
        output: 'ma',
      })
      .smooth('value', 'loess', { span, output: 'loess' });
  }, [strength]);

  const CHIPS = [
    { value: 'ema' as const, label: 'EMA', color: blue },
    { value: 'ma' as const, label: 'moving avg', color: purple },
    { value: 'loess' as const, label: 'LOESS', color: teal },
  ];

  return (
    <>
      <div ref={boxRef} style={{ width: '100%' }}>
        {width > 0 ? (
          <ChartContainer range={RANGE} width={width} theme={theme}>
            <ChartRow height={HEIGHT}>
              <YAxis
                id="v"
                side="left"
                label="sunspots"
                min={0}
                max={300}
                width={40}
                format={() => ''}
              />
              <Layers>
                <LineChart
                  series={source}
                  column="value"
                  axis="v"
                  as="source"
                />
                {on.includes('ema') ? (
                  <LineChart series={smoothed} column="ema" axis="v" as="ema" />
                ) : null}
                {on.includes('ma') ? (
                  <LineChart series={smoothed} column="ma" axis="v" as="ma" />
                ) : null}
                {on.includes('loess') ? (
                  <LineChart
                    series={smoothed}
                    column="loess"
                    axis="v"
                    as="loess"
                  />
                ) : null}
              </Layers>
            </ChartRow>
          </ChartContainer>
        ) : (
          <div style={{ height: HEIGHT }} />
        )}
      </div>
      <ConceptControls>
        <ToggleChips
          label="compare"
          options={CHIPS}
          selected={on}
          onToggle={toggle}
        />
        <Slider
          label="smoothing"
          min={1}
          max={95}
          step={1}
          value={strength}
          onChange={setStrength}
          display={`${strength}%`}
        />
      </ConceptControls>
    </>
  );
}
