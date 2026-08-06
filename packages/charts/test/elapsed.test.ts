import { describe, expect, it } from 'vitest';
import { scaleLinear } from 'd3-scale';
import {
  durationShape,
  durationStep,
  formatDuration,
  niceStep,
  originTicks,
  scaleElapsed,
} from '../src/elapsed.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('durationStep — the clock ladder', () => {
  it('picks round durations, not 1-2-5 on milliseconds', () => {
    // 10 minutes across ~2 ticks wants a 5-minute step; the 1-2-5 ladder would
    // have offered 200s (=3:20), which is not a duration anyone reads.
    expect(durationStep(10 * MINUTE, 2)).toBe(5 * MINUTE);
    expect(durationStep(45 * SECOND, 5)).toBe(10 * SECOND);
    expect(durationStep(90 * SECOND, 6)).toBe(15 * SECOND);
    expect(durationStep(8 * HOUR, 4)).toBe(2 * HOUR);
    expect(durationStep(20 * HOUR, 3)).toBe(12 * HOUR);
  });

  it('never overshoots the requested tick count', () => {
    for (const span of [1, 1000, 90 * SECOND, 3 * HOUR, 5 * DAY, 400 * DAY]) {
      for (const count of [2, 5, 9, 20]) {
        const step = durationStep(span, count);
        expect(step).toBeGreaterThan(0);
        expect(span / step).toBeLessThanOrEqual(count);
      }
    }
  });

  it('falls back to 1-2-5 whole days past the ladder', () => {
    expect(durationStep(10 * DAY, 5)).toBe(2 * DAY);
    expect(durationStep(100 * DAY, 5)).toBe(20 * DAY);
  });

  it('survives a degenerate span', () => {
    expect(durationStep(0, 5)).toBe(1);
    expect(durationStep(NaN, 5)).toBe(1);
    expect(niceStep(0)).toBe(1);
  });
});

describe('originTicks — the anchored walk', () => {
  it('places ticks at origin + k·step, not on absolute boundaries', () => {
    // A run starting at 10:33:17 ticks five minutes in, not at 10:35.
    const start = Date.UTC(2026, 0, 1, 10, 33, 17);
    const ticks = originTicks([start, start + 10 * MINUTE], start, 5 * MINUTE);
    expect(ticks).toEqual([start, start + 5 * MINUTE, start + 10 * MINUTE]);
  });

  it('walks negative where the domain reaches back before the origin', () => {
    expect(originTicks([0, 100], 50, 25)).toEqual([0, 25, 50, 75, 100]);
  });

  it('keeps a tick sitting exactly on a domain edge', () => {
    // The `00:00` tick is the common case and must not be lost to float drift.
    const t0 = 1_700_000_000_123;
    expect(originTicks([t0, t0 + 3 * MINUTE], t0, MINUTE)[0]).toBe(t0);
  });

  it('returns nothing for a degenerate domain or step', () => {
    expect(originTicks([0, 100], 0, 0)).toEqual([]);
    expect(originTicks([NaN, 100], 0, 10)).toEqual([]);
    expect(originTicks([0, 5], 0, 10)).toEqual([0]);
  });
});

describe('formatDuration — the label shapes', () => {
  it('reads a minute-grain axis as HH:MM — the headline case', () => {
    // What replaces `10:35 10:40 10:45` on a ten-minute view.
    const shape = durationShape(5 * MINUTE, 10 * MINUTE);
    expect(formatDuration(0, shape)).toBe('00:00');
    expect(formatDuration(5 * MINUTE, shape)).toBe('00:05');
    expect(formatDuration(10 * MINUTE, shape)).toBe('00:10');
  });

  it('drops to MM:SS only when the axis is fine enough to show seconds', () => {
    const shape = durationShape(5 * SECOND, 30 * SECOND);
    expect(shape.hours).toBe(false);
    expect(formatDuration(15 * SECOND, shape)).toBe('00:15');
    expect(formatDuration(75 * SECOND, shape)).toBe('01:15');
  });

  it('shows seconds under a second-grain step on an hour-long axis', () => {
    const shape = durationShape(30 * SECOND, 2 * HOUR);
    expect(formatDuration(HOUR + 90 * SECOND, shape)).toBe('01:01:30');
  });

  it('adds millis under a sub-second step', () => {
    const shape = durationShape(200, 2 * SECOND);
    expect(formatDuration(1250, shape)).toBe('00:01.250');
  });

  it('promotes a day part only once there is one', () => {
    const shape = durationShape(6 * HOUR, 2 * DAY);
    expect(formatDuration(6 * HOUR, shape)).toBe('06:00');
    expect(formatDuration(30 * HOUR, shape)).toBe('1d 06:00');
    expect(formatDuration(2 * DAY, shape)).toBe('2d 00:00');
  });

  it('reads whole days at a day-or-coarser step', () => {
    const shape = durationShape(2 * DAY, 10 * DAY);
    expect(formatDuration(3 * DAY + 5 * HOUR, shape)).toBe('3d');
  });

  it('accumulates hours past 24 when the shape carries no day part', () => {
    // An off-axis readout must not silently wrap to `06:00`.
    const shape = durationShape(15 * MINUTE, 3 * HOUR);
    expect(formatDuration(30 * HOUR, shape)).toBe('30:00');
  });

  it('signs offsets before the origin (the T-minus case)', () => {
    const shape = durationShape(5 * MINUTE, 10 * MINUTE);
    expect(formatDuration(-5 * MINUTE, shape)).toBe('-00:05');
    expect(formatDuration(-0, shape)).toBe('00:00');
  });

  it('truncates like a clock rather than rounding up', () => {
    const shape = durationShape(SECOND, 60 * SECOND);
    expect(formatDuration(59_700, shape)).toBe('00:59');
  });

  it('renders nothing for a non-finite value', () => {
    expect(formatDuration(NaN, durationShape(SECOND, SECOND))).toBe('');
  });
});

describe('scaleElapsed — the wrapper', () => {
  const t0 = Date.UTC(2026, 0, 1, 10, 33, 17);
  const base = () =>
    scaleLinear()
      .domain([t0, t0 + 10 * MINUTE])
      .range([0, 300]);

  it('passes the pixel mapping straight through', () => {
    const s = base();
    const e = scaleElapsed(s, { origin: t0, kind: 'time' });
    expect(e(t0)).toBe(s(t0));
    expect(e(t0 + 5 * MINUTE)).toBe(s(t0 + 5 * MINUTE));
    expect(e.invert(150)).toBe(+s.invert(150));
    expect(e.domain()).toEqual([t0, t0 + 10 * MINUTE]);
    expect(e.range()).toEqual([0, 300]);
    expect(e.origin).toBe(t0);
  });

  it('ticks in absolute units but labels in durations', () => {
    const e = scaleElapsed(base(), { origin: t0, kind: 'time' });
    const ticks = e.ticks(2);
    expect(ticks).toEqual([t0, t0 + 5 * MINUTE, t0 + 10 * MINUTE]);
    const fmt = e.tickFormat(2);
    expect(ticks.map(fmt)).toEqual(['00:00', '00:05', '00:10']);
  });

  it('reads the wall clock under an explicit time specifier', () => {
    // A d3 time specifier can only describe an instant, so it labels the
    // absolute time — the wall-clock-strip lever.
    const e = scaleElapsed(base(), {
      origin: t0,
      kind: 'time',
      absolute: (count, specifier) => {
        expect(specifier).toBe('%H:%M');
        return () => 'wall';
      },
    });
    expect(e.tickFormat(2, '%H:%M')(t0)).toBe('wall');
  });

  it('gives the cursor readout a finer grain than the ticks, same shape', () => {
    const e = scaleElapsed(base(), { origin: t0, kind: 'time' });
    // Ticks read `00:05`; the pill under the pointer reads `00:05:12` — seconds
    // added to the ticks' own shape, never a different shape (`05:12`).
    expect(e.tickFormat(2)(t0 + 5 * MINUTE + 12 * SECOND)).toBe('00:05');
    expect(e.readoutFormat(2)(t0 + 5 * MINUTE + 12 * SECOND)).toBe('00:05:12');
  });

  it('anchors a value axis at the origin and labels the offset', () => {
    const s = scaleLinear().domain([1200, 5300]).range([0, 400]);
    const e = scaleElapsed(s, { origin: 1200, kind: 'value' });
    expect(e.ticks(5)).toEqual([1200, 2200, 3200, 4200, 5200]);
    const fmt = e.tickFormat(5);
    expect(e.ticks(5).map(fmt)).toEqual([
      '0',
      '1,000',
      '2,000',
      '3,000',
      '4,000',
    ]);
  });

  it('leaves a value axis its tick labels for the readout — no finer grain', () => {
    // "One grain finer" is a clock idea; an offset has no sub-unit to add, so
    // the readout channel must be the tick formatter rather than a duration.
    const s = scaleLinear().domain([1200, 5300]).range([0, 400]);
    const e = scaleElapsed(s, { origin: 1200, kind: 'value' });
    expect(e.readoutFormat(5)(3200)).toBe(e.tickFormat(5)(3200));
    expect(e.readoutFormat(5)(3200)).toBe('2,000');
  });

  it('applies a value-axis specifier to the offset, not the absolute value', () => {
    const s = scaleLinear().domain([1200, 5300]).range([0, 400]);
    const e = scaleElapsed(s, { origin: 1200, kind: 'value' });
    expect(e.tickFormat(5, '.1f')(2200)).toBe('1000.0');
  });
});
