import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type OutputFormat = 'png' | 'jpeg' | 'webp';

export interface FormatLimit {
  maxDim: number;
  label: string;
}

export const FORMAT_LIMITS: Record<OutputFormat, FormatLimit> = {
  png: { maxDim: 2147483647, label: 'PNG' },
  jpeg: { maxDim: 65535, label: 'JPEG' },
  webp: { maxDim: 16383, label: 'WebP' },
};

export interface OutputDims {
  outWidth: number;
  outHeight: number;
  pixels: number;
  rawBytes: number;
  warnings: string[];
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(2)} ${units[i]}`;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m}m${r.toString().padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${(m % 60).toString().padStart(2, '0')}m`;
}

export function isPositiveInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0;
}

export function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.round(v)));
}

/**
 * 用 BigInt 计算输出尺寸，并检查安全阈值、格式单边上限、Number.MAX_SAFE_INTEGER。
 */
export function computeOutputDims(
  width: number,
  height: number,
  scale: number,
  format: OutputFormat,
  maxOutputPixels: number,
  force: boolean,
): OutputDims {
  const outW = BigInt(width) * BigInt(scale);
  const outH = BigInt(height) * BigInt(scale);
  const pixels = outW * outH;
  const rawBytes = pixels * 4n;

  if (rawBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `输出像素数据量（${rawBytes} 字节）超过安全范围（Number.MAX_SAFE_INTEGER），请减小 scale`,
    );
  }

  const limits = FORMAT_LIMITS[format];
  if (outW > BigInt(limits.maxDim) || outH > BigInt(limits.maxDim)) {
    throw new Error(
      `${limits.label} 单边最大支持 ${limits.maxDim}，但输出为 ${outW}x${outH}（宽或高超限）`,
    );
  }

  const warnings: string[] = [];
  const maxPixels = BigInt(maxOutputPixels);
  if (pixels > maxPixels) {
    if (!force) {
      throw new Error(
        `输出像素 ${pixels.toLocaleString('en-US')} 超过安全阈值 ` +
          `${maxPixels.toLocaleString('en-US')}；如需继续请添加 --force（会警告）`,
      );
    }
    warnings.push(
      `已通过 --force 跳过安全阈值：输出像素 ${pixels.toLocaleString('en-US')} 超过 ` +
        `${maxPixels.toLocaleString('en-US')}`,
    );
  }

  return {
    outWidth: Number(outW),
    outHeight: Number(outH),
    pixels: Number(pixels),
    rawBytes: Number(rawBytes),
    warnings,
  };
}

export async function assertInputFile(input: string): Promise<void> {
  let st;
  try {
    st = await fs.promises.stat(input);
  } catch {
    throw new Error(`输入文件不存在：${input}`);
  }
  if (!st.isFile()) {
    throw new Error(`输入路径不是文件：${input}`);
  }
}

export function assertOutputWritable(output: string, overwrite: boolean): void {
  const abs = path.resolve(output);
  const dir = path.dirname(abs);
  if (!fs.existsSync(dir)) {
    throw new Error(`输出目录不存在：${dir}`);
  }
  if (fs.existsSync(abs) && !overwrite) {
    throw new Error(`输出文件已存在：${abs}（添加 --overwrite 可覆盖）`);
  }
}

/**
 * 检查磁盘剩余空间（基于 fs.statfs，不可用时静默跳过）。
 */
export function checkDiskSpace(dir: string, needBytes: number, force: boolean, label = ''): void {
  let s;
  try {
    s = fs.statfsSync(dir);
  } catch {
    return; // 无法获取时跳过检查
  }
  const bavail = (s as { bavail?: number }).bavail;
  const bsize = (s as { bsize?: number }).bsize;
  if (typeof bavail !== 'number' || typeof bsize !== 'number' || bsize <= 0) return;

  const available = bavail * bsize;
  if (needBytes > available) {
    const msg =
      `磁盘剩余空间不足${label ? `（${label}）` : ''}：需要约 ${formatBytes(needBytes)}，` +
      `可用 ${formatBytes(available)}（目录 ${dir}）`;
    if (!force) throw new Error(msg);
    process.stderr.write(`警告：${msg}，仍继续（--force）\n`);
  }
}

/**
 * 检查可用内存是否能容纳给定字节量。
 */
export function checkAvailableMemory(needBytes: number, force: boolean, label = ''): string | null {
  const free = os.freemem();
  if (needBytes > free) {
    const msg =
      `可用内存不足${label ? `（${label}）` : ''}：需要 ${formatBytes(needBytes)}，` +
      `当前空闲 ${formatBytes(free)}`;
    if (!force) throw new Error(`${msg}；可用 --force 跳过（有风险）`);
    return `警告：${msg}，仍继续（--force）`;
  }
  return null;
}