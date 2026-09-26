import { describe, it, expect } from 'vitest';
import { replicateFull } from '../src/engines/manual.js';
import { sharpNearestToRaw } from '../src/engines/sharpNearest.js';

function makeOpaque(width: number, height: number): Buffer {
  const raw = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    raw[i * 4] = (i * 29) % 256;
    raw[i * 4 + 1] = (i * 61) % 256;
    raw[i * 4 + 2] = (i * 97) % 256;
    raw[i * 4 + 3] = 255;
  }
  return raw;
}

describe('sharp-nearest 引擎', () => {
  it('整数倍放大（不透明像素）结果与 manual 逐字节一致', async () => {
    const width = 17;
    const height = 13;
    const scale = 3;
    const raw = makeOpaque(width, height);

    const manual = replicateFull(raw, width, height, scale);
    const sharpData = await sharpNearestToRaw(raw, width, height, scale);

    expect(sharpData.length).toBe(manual.length);
    expect(sharpData.equals(Buffer.from(manual))).toBe(true);
  });

  it('不同整数倍（scale=1,2,4）不透明像素结果与 manual 一致', async () => {
    const width = 9;
    const height = 5;
    const raw = makeOpaque(width, height);

    for (const scale of [1, 2, 4]) {
      const manual = replicateFull(raw, width, height, scale);
      const sharpData = await sharpNearestToRaw(raw, width, height, scale);
      expect(sharpData.equals(Buffer.from(manual))).toBe(true);
    }
  });

  it('半透明像素：sharp 因 alpha 预乘可能与 manual 存在字节级差异（记录行为）', async () => {
    const width = 8;
    const height = 8;
    const scale = 2;
    const raw = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      raw[i * 4] = (i * 13) % 256;
      raw[i * 4 + 1] = (i * 17) % 256;
      raw[i * 4 + 2] = (i * 19) % 256;
      raw[i * 4 + 3] = 128;
    }

    const manual = replicateFull(raw, width, height, scale);
    const sharpData = await sharpNearestToRaw(raw, width, height, scale);

    // 半透明场景块状结构仍一致（尺寸相同），但不做严格逐字节相等等价断言。
    expect(sharpData.length).toBe(manual.length);
  });
});