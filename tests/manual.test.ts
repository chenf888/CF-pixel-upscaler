import { describe, it, expect } from 'vitest';
import { replicateFull, replicateRows } from '../src/engines/manual.js';

function makeImage(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      data[p] = (x * 37 + y * 5) % 251 + 1;
      data[p + 1] = (y * 13 + x * 3) % 251 + 1;
      data[p + 2] = (x * 7 + y * 29) % 251 + 1;
      data[p + 3] = (x + y) % 2 === 0 ? 255 : 128;
    }
  }
  return data;
}

function px(data: Uint8Array, width: number, x: number, y: number): number[] {
  const p = (y * width + x) * 4;
  return [data[p], data[p + 1], data[p + 2], data[p + 3]];
}

describe('manual 像素复制引擎', () => {
  it('2x2 scale=2 → 4x4，每个原始像素变成 2x2 相同块', () => {
    const src = new Uint8Array([
      1, 2, 3, 255, 4, 5, 6, 255,
      7, 8, 9, 255, 10, 11, 12, 255,
    ]);
    const out = replicateFull(src, 2, 2, 2);
    expect(out.length).toBe(4 * 4 * 4);

    // 像素 (0,0) → 2x2 块
    expect(px(out, 4, 0, 0)).toEqual([1, 2, 3, 255]);
    expect(px(out, 4, 1, 0)).toEqual([1, 2, 3, 255]);
    expect(px(out, 4, 0, 1)).toEqual([1, 2, 3, 255]);
    expect(px(out, 4, 1, 1)).toEqual([1, 2, 3, 255]);

    // 像素 (1,0) → 2x2 块
    expect(px(out, 4, 2, 0)).toEqual([4, 5, 6, 255]);
    expect(px(out, 4, 3, 1)).toEqual([4, 5, 6, 255]);

    // 像素 (0,1) → 2x2 块
    expect(px(out, 4, 0, 2)).toEqual([7, 8, 9, 255]);
    expect(px(out, 4, 1, 3)).toEqual([7, 8, 9, 255]);

    // 像素 (1,1) → 2x2 块
    expect(px(out, 4, 2, 2)).toEqual([10, 11, 12, 255]);
    expect(px(out, 4, 3, 3)).toEqual([10, 11, 12, 255]);
  });

  it('100x200 scale=2 → 输出 200x400 的字节量', () => {
    const src = makeImage(100, 200);
    const out = replicateFull(src, 100, 200, 2);
    expect(out.length).toBe(200 * 400 * 4);
  });

  it('分块处理与整图处理结果一致', () => {
    const src = makeImage(32, 64);
    const whole = replicateFull(src, 32, 64, 3);
    const upper = replicateRows(src, 32, 3, 0, 20);
    const lower = replicateRows(src, 32, 3, 20, 64);
    const merged = new Uint8Array(whole.length);
    merged.set(upper, 0);
    merged.set(lower, upper.length);
    expect(merged).toEqual(whole);
  });

  it('scale=3 的 1x1 图每个像素重复为 3x3 块', () => {
    const src = new Uint8Array([10, 20, 30, 255]);
    const out = replicateFull(src, 1, 1, 3);
    expect(out.length).toBe(3 * 3 * 4);
    for (let i = 0; i < 9; i++) {
      expect([out[i * 4], out[i * 4 + 1], out[i * 4 + 2], out[i * 4 + 3]]).toEqual([10, 20, 30, 255]);
    }
  });

  it('scale=1 时原样输出', () => {
    const src = makeImage(8, 8);
    const out = replicateFull(src, 8, 8, 1);
    expect(out).toEqual(src);
  });
});