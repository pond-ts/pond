import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { YAxis } from './YAxis.js';
import { defaultTheme } from './theme.js';
import { useChartTheme } from './useChartTheme.js';

const N = 80;
const BASE = Date.UTC(2026, 0, 1, 12, 0, 0);
const STEP = 60_000;
const RANGE: readonly [number, number] = [BASE, BASE + (N - 1) * STEP];

function sine() {
  const rows: Array<[number, number]> = [];
  for (let i = 0; i < N; i += 1)
    rows.push([BASE + i * STEP, 50 + 30 * Math.sin(i / 7)]);
  return new TimeSeries({
    name: 'demo',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows,
  });
}

// The design-system tokens, keyed by a `data-theme` on the root — the cascade a
// real app already has. The chart reads these via `useChartTheme`, so flipping
// the attribute re-themes the canvas with no `mode` prop threaded through.
const TOKENS = `
  :root {
    --demo-bg: #ffffff;
    --demo-accent: #2563eb;
    --demo-axis: #64748b;
    --demo-grid: #e2e8f0;
  }
  :root[data-theme='dark'] {
    --demo-bg: #0f172a;
    --demo-accent: #93c5fd;
    --demo-axis: #94a3b8;
    --demo-grid: #1e293b;
  }
`;

/**
 * `useChartTheme` binds the canvas `ChartTheme` to CSS custom properties and
 * re-resolves on the root's `data-theme` toggle — so the chart follows
 * dark/light with the rest of the page. Click the button: only the
 * `data-theme` attribute changes; the hook re-reads the tokens and hands
 * `ChartContainer` a fresh theme, which repaints.
 */
function CssVarThemedChart() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = TOKENS;
    document.head.appendChild(style);
    return () => {
      style.remove();
      document.documentElement.removeAttribute('data-theme');
    };
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute(
      'data-theme',
      dark ? 'dark' : 'light',
    );
  }, [dark]);

  const theme = useChartTheme(defaultTheme, (v) => ({
    background: v('--demo-bg'),
    line: { default: { color: v('--demo-accent') } },
    axis: { label: v('--demo-axis'), grid: v('--demo-grid') },
    cursor: v('--demo-axis'),
  }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <button
        type="button"
        onClick={() => setDark((d) => !d)}
        style={{
          alignSelf: 'flex-start',
          font: '13px system-ui, sans-serif',
          padding: '6px 12px',
          borderRadius: 6,
          border: '1px solid #cbd5e1',
          background: '#f8fafc',
          cursor: 'pointer',
        }}
      >
        Toggle theme (now: {dark ? 'dark' : 'light'})
      </button>
      <ChartContainer range={RANGE} width={520} theme={theme}>
        <ChartRow height={220}>
          <YAxis id="v" label="v" />
          <Layers>
            <LineChart series={sine()} column="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    </div>
  );
}

const meta = {
  title: 'Theming',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const CssVars: Story = {
  render: () => <CssVarThemedChart />,
};
