import type { Meta, StoryObj } from '@storybook/react-vite';
import { Canvas } from './Canvas.js';

/**
 * Stories for the low-level {@link Canvas} primitive. These double as the
 * fixtures the Playwright behavior + visual-regression specs (`e2e/`) render
 * against, so the draws are deterministic.
 */
const meta = {
  title: 'Primitives/Canvas',
  component: Canvas,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof Canvas>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A fixed diagonal stroke inside a border — the canonical visual baseline. */
export const Diagonal: Story = {
  args: {
    width: 240,
    height: 120,
    draw: (ctx, w, h) => {
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 2;
      ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
      ctx.beginPath();
      ctx.moveTo(0, h);
      ctx.lineTo(w, 0);
      ctx.stroke();
    },
  },
};

/** A filled wedge — a second deterministic fixture for the visual layer. */
export const Wedge: Story = {
  args: {
    width: 240,
    height: 120,
    draw: (ctx, w, h) => {
      ctx.fillStyle = '#10b981';
      ctx.beginPath();
      ctx.moveTo(0, h);
      ctx.lineTo(w, h);
      ctx.lineTo(w, 0);
      ctx.closePath();
      ctx.fill();
    },
  },
};
