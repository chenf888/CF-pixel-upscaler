import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { encodeRawFileToPng } from './png.js';

export type OutputFormat = 'png' | 'jpeg' | 'webp';

export interface DecodedRaw {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

/** 根据 --format 或输出扩展名推断最终格式，默认 png。 */
export function detectFormat(output: string, explicit?: string): OutputFormat {
  if (explicit) {
    const f = explicit.toLowerCase();
    if (f === 'png') return 'png';
    if (f === 'jpeg' || f === 'jpg') return 'jpeg';
    if (f === 'webp') return 'webp';
    throw new Error(`不支持的输出格式：${explicit}（可选 png | jpeg | webp）`);
  }
  const ext = path.extname(output).toLowerCase();
  if (ext === '.png') return 'png';
  if (ext === '.jpg' || ext === '.jpeg') return 'jpeg';
  if (ext === '.webp') return 'webp';
  return 'png';
}

// sharp 默认输入有 2.68 亿像素内建限制；本工具自行通过 maxOutputPixels/内存磁盘检查把关，
// 因此设置为 0（不限制），允许处理任意超大整数倍放大。
const INPUT_PIXEL_LIMIT = 0;

export interface ImageSize {
  width: number;
  height: number;
}

/** 轻量读取图片尺寸与基本元信息，不载入像素数据（适用于超大图）。 */
export async function getImageSize(input: string): Promise<ImageSize> {
  try {
    const m = await sharp(input, { limitInputPixels: INPUT_PIXEL_LIMIT }).metadata();
    if (!m.width || !m.height) throw new Error('无法读取图片尺寸');
    return { width: m.width, height: m.height };
  } catch (e) {
    throw new Error(`读取图片信息失败：${input}（文件可能不是有效图片）—— ${(e as Error).message}`);
  }
}

/** 用 sharp 解码为 raw RGBA。默认不采信任何色彩管理，直接复制像素。 */
export async function decodeRaw(input: string): Promise<DecodedRaw> {
  try {
    const { data, info } = await sharp(input, { limitInputPixels: INPUT_PIXEL_LIMIT })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, channels: info.channels };
  } catch (e) {
    throw new Error(`解码图片失败：${input}（文件可能不是有效图片）—— ${(e as Error).message}`);
  }
}

export interface EncodeOptions {
  rawPath: string;
  width: number;
  height: number;
  output: string;
  format: OutputFormat;
  quality: number;
}

/**
 * 将 raw RGBA 临时文件编码为最终图片。
 * - PNG：流式编码，内存占用与输出尺寸无关。
 * - JPEG/WebP：sharp 的 API 要求完整 raw Buffer，该阶段会把 raw 载入内存（已在调用前做内存检查）。
 */
export async function encodeRawFile(opts: EncodeOptions): Promise<void> {
  if (opts.format === 'png') {
    await encodeRawFileToPng(opts.rawPath, opts.width, opts.height, opts.output);
    return;
  }

  const raw = await fs.promises.readFile(opts.rawPath);

  if (opts.format === 'jpeg') {
    // JPEG 不支持 alpha：合成到白底。
    await sharp(raw, { raw: { width: opts.width, height: opts.height, channels: 4 } })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: opts.quality })
      .toFile(opts.output);
    return;
  }

  if (opts.format === 'webp') {
    await sharp(raw, { raw: { width: opts.width, height: opts.height, channels: 4 } })
      .webp({ quality: opts.quality })
      .toFile(opts.output);
    return;
  }
}