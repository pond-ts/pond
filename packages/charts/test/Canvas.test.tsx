import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Canvas } from '../src/Canvas.js';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

describe('<Canvas>', () => {
  it('draws in CSS-pixel space and transforms by DPR', () => {
    const stub = stubCanvasContext();
    try {
      const drawn: Array<[number, number]> = [];
      render(
        <Canvas
          width={200}
          height={100}
          dpr={2}
          draw={(ctx, w, h) => {
            drawn.push([w, h]);
            ctx.fillRect(0, 0, w, h);
          }}
        />,
      );
      // The draw callback receives CSS pixels, not device pixels.
      expect(drawn).toEqual([[200, 100]]);
      // Transform is set to the DPR so CSS-space drawing renders at device res.
      const setT = stub.calls.find((c) => c.name === 'setTransform');
      expect(setT?.args).toEqual([2, 0, 0, 2, 0, 0]);
      // The clear happens in CSS space (post-transform).
      const clear = stub.calls.find((c) => c.name === 'clearRect');
      expect(clear?.args).toEqual([0, 0, 200, 100]);
    } finally {
      stub.restore();
    }
  });

  it('sizes the backing buffer to width*dpr × height*dpr and the CSS box to width × height', () => {
    const stub = stubCanvasContext();
    try {
      const { container } = render(
        <Canvas width={150} height={50} dpr={2} draw={() => {}} />,
      );
      const canvas = container.querySelector('canvas');
      expect(canvas).not.toBeNull();
      expect(canvas!.width).toBe(300); // 150 * 2
      expect(canvas!.height).toBe(100); // 50 * 2
      expect(canvas!.style.width).toBe('150px');
      expect(canvas!.style.height).toBe('50px');
    } finally {
      stub.restore();
    }
  });

  it('orders transform → clear → save → draw → restore so the draw is never wiped and its state never leaks', () => {
    const stub = stubCanvasContext();
    try {
      render(
        <Canvas
          width={10}
          height={10}
          dpr={1}
          draw={(ctx) => {
            ctx.beginPath();
          }}
        />,
      );
      const order = stub.calls
        .filter((c) => c.type === 'call')
        .map((c) => c.name);
      expect(order).toEqual([
        'setTransform',
        'clearRect',
        'save',
        'beginPath',
        'restore',
      ]);
    } finally {
      stub.restore();
    }
  });

  it('leaves the backing buffer alone when it redraws at the same size', () => {
    const stub = stubCanvasContext();
    const widthSet = vi.spyOn(HTMLCanvasElement.prototype, 'width', 'set');
    const heightSet = vi.spyOn(HTMLCanvasElement.prototype, 'height', 'set');
    try {
      let draws = 0;
      const { container, rerender } = render(
        <Canvas width={150} height={50} dpr={2} draw={() => draws++} />,
      );
      widthSet.mockClear();
      heightSet.mockClear();
      // A fresh closure, as a streaming chart hands over on every data update.
      rerender(<Canvas width={150} height={50} dpr={2} draw={() => draws++} />);
      expect(draws).toBe(2);
      expect(widthSet).not.toHaveBeenCalled();
      expect(heightSet).not.toHaveBeenCalled();
      const canvas = container.querySelector('canvas')!;
      expect(canvas.width).toBe(300);
      expect(canvas.height).toBe(100);
    } finally {
      widthSet.mockRestore();
      heightSet.mockRestore();
      stub.restore();
    }
  });

  it('resizes only the dimension whose device-pixel size changed', () => {
    const stub = stubCanvasContext();
    const widthSet = vi.spyOn(HTMLCanvasElement.prototype, 'width', 'set');
    const heightSet = vi.spyOn(HTMLCanvasElement.prototype, 'height', 'set');
    try {
      const draw = () => {};
      const { container, rerender } = render(
        <Canvas width={150} height={50} dpr={2} draw={draw} />,
      );
      widthSet.mockClear();
      heightSet.mockClear();
      rerender(<Canvas width={200} height={50} dpr={2} draw={draw} />);
      expect(widthSet).toHaveBeenCalledTimes(1);
      expect(heightSet).not.toHaveBeenCalled();
      const canvas = container.querySelector('canvas')!;
      expect(canvas.width).toBe(400);
      expect(canvas.height).toBe(100);
      expect(canvas.style.width).toBe('200px');
    } finally {
      widthSet.mockRestore();
      heightSet.mockRestore();
      stub.restore();
    }
  });
});
