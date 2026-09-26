import { describe, it, expect } from 'vitest';
import { run } from '../src/cli.js';
import sharp from 'sharp';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function makeInput(file: string, w: number, h: number): Promise<void> {
  const raw = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    raw[i * 4] = (i * 5) % 256;
    raw[i * 4 + 1] = (i * 7) % 256;
    raw[i * 4 + 2] = (i * 11) % 256;
    raw[i * 4 + 3] = 255;
  }
  await sharp(raw, { raw: { width: w, height: h, channels: 4 } }).png().toFile(file);
}

describe('CLI 基本流程', () => {
  it('-i -o -s 3 生成正确尺寸的输出', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-cli-'));
    const input = path.join(dir, 'in.png');
    const output = path.join(dir, 'out.png');
    await makeInput(input, 4, 3);

    const code = await run(['-i', input, '-o', output, '-s', '3', '--no-progress']);

    expect(code).toBe(0);
    expect(fs.existsSync(output)).toBe(true);
    const meta = await sharp(output).metadata();
    expect(meta.width).toBe(12);
    expect(meta.height).toBe(9);
    expect(meta.channels).toBe(4);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('缺省 scale 默认 2', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-cli-'));
    const input = path.join(dir, 'in.png');
    const output = path.join(dir, 'out.png');
    await makeInput(input, 2, 2);

    const code = await run(['-i', input, '-o', output, '--no-progress']);

    expect(code).toBe(0);
    const meta = await sharp(output).metadata();
    expect(meta.width).toBe(4);
    expect(meta.height).toBe(4);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('--engine sharp-nearest 也产出正确尺寸', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-cli-'));
    const input = path.join(dir, 'in.png');
    const output = path.join(dir, 'out.png');
    await makeInput(input, 3, 2);

    const code = await run(['-i', input, '-o', output, '-s', '2', '--engine', 'sharp-nearest', '--no-progress']);

    expect(code).toBe(0);
    const meta = await sharp(output).metadata();
    expect(meta.width).toBe(6);
    expect(meta.height).toBe(4);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('输出文件已存在且未 --overwrite 时返回非零', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-cli-'));
    const input = path.join(dir, 'in.png');
    const output = path.join(dir, 'out.png');
    await makeInput(input, 2, 2);
    fs.writeFileSync(output, 'existing');

    const code = await run(['-i', input, '-o', output, '--no-progress']);
    expect(code).toBe(1);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('scale 非法时返回非零', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-cli-'));
    const input = path.join(dir, 'in.png');
    const output = path.join(dir, 'out.png');
    await makeInput(input, 2, 2);

    const code = await run(['-i', input, '-o', output, '-s', 'abc', '--no-progress']);
    expect(code).toBe(1);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});