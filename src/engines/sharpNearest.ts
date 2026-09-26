import sharp from 'sharp';

/**
 * sharp-nearest 引擎：使用 sharp 的最近邻 resize。
 * 作为可选快速路径，也是 manual 引擎的性能对比基准。
 */

/**
 * 输入已解码的 RGBA raw Buffer，输出同样为 raw Buffer，
 * 便于与 manual 结果做逐字节像素对比。
 */
export async function sharpNearestToRaw(
  src: Buffer,
  width: number,
  height: number,
  scale: number,
): Promise<Buffer> {
  const outWidth = width * scale;
  const outHeight = height * scale;
  const { data } = await sharp(src, {
    raw: { width, height, channels: 4 },
  })
    .resize(outWidth, outHeight, { kernel: 'nearest', fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data;
}

export interface SharpNearestFileOptions {
  input: string;
  output: string;
  scale: number;
  format: 'png' | 'jpeg' | 'webp';
  quality?: number;
  keepMetadata?: boolean;
}

/**
 * sharp-nearest 引擎的文件路径：直接由 sharp 读取原文件并 resize。
 * manual 引擎是纯像素复制，不保留元数据；--keep-metadata 的能力在此处生效。
 */
export async function sharpNearestToFile(opts: SharpNearestFileOptions): Promise<void> {
  const INPUT_PIXEL_LIMIT = 0; // 不限制输入像素，由上层 maxOutputPixels/内存检查把关
  const meta = await sharp(opts.input, { limitInputPixels: INPUT_PIXEL_LIMIT }).metadata();
  const outWidth = (meta.width ?? 0) * opts.scale;
  const outHeight = (meta.height ?? 0) * opts.scale;

  let p = sharp(opts.input, { limitInputPixels: INPUT_PIXEL_LIMIT }).resize(outWidth, outHeight, {
    kernel: 'nearest',
    fit: 'fill',
  });

  if (opts.keepMetadata) {
    p = p.withMetadata();
  }

  switch (opts.format) {
    case 'png':
      await p.png().toFile(opts.output);
      break;
    case 'webp':
      await p.webp({ quality: opts.quality ?? 90 }).toFile(opts.output);
      break;
    case 'jpeg':
      // JPEG 不支持 alpha，合成到白底。
      await p
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .jpeg({ quality: opts.quality ?? 90 })
        .toFile(opts.output);
      break;
  }
}