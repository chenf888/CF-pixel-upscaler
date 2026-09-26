import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { upscale } from '../src/index.js';

async function makePng(file: string, w: number, h: number): Promise<void> {
  const raw = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    raw[i * 4] = i % 256;
    raw[i * 4 + 1] = (i * 2) % 256;
    raw[i * 4 + 2] = (i * 3) % 256;
    raw[i * 4 + 3] = 255;
  }
  await sharp(raw, { raw: { width: w, height: h, channels: 4 } }).png().toFile(file);
}

describe('compare 模式', () => {
  it('对比 manual 与 sharp-nearest 耗时/吞吐/内存峰值并判定像素一致', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-compare-'));
    const input = path.join(dir, 'in.png');
    const output = path.join(dir, 'out.png');
    await makePng(input, 8, 6);

    const result = await upscale({
      input,
      output,
      scale: 2,
      compare: true,
      progress: false,
      format: 'png',
    });

    expect(result.engineUsed).toBe('manual');
    expect(result.outWidth).toBe(16);
    expect(result.outHeight).toBe(12);
    expect(result.compare).toBeDefined();
    expect(result.compare!.identical).toBe(true);
    expect(result.compare!.manual.engine).toBe('manual');
    expect(result.compare!.sharp.engine).toBe('sharp-nearest');
    expect(result.compare!.manual.throughputMpx).toBeGreaterThan(0);
    expect(result.compare!.sharp.throughputMpx).toBeGreaterThan(0);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});