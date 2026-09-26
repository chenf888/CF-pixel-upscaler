/**
 * manual 引擎：手写“单个像素复制”的整数倍放大核心。
 * 显式实现像素复制，不依赖 sharp.resize 完成核心放大。
 */

export const CHANNELS = 4; // RGBA

/**
 * 对输入的 RGBA 像素执行整数倍像素复制，返回放大后的新缓冲。
 * 输入：src 为完整图像的 RGBA 连续数据（长度 = width * height * 4）。
 * 仅处理 [startSrcY, endSrcY) 范围内的输入行，输出对应放大后的行。
 *
 * 算法（显式实现）：
 *   for srcY in [startSrcY, endSrcY):
 *     先做水平放大：outRow[x*scale + k] = srcRow[x]（每个像素重复 scale 次）
 *     再做垂直放大：将 outRow 重复 scale 次写入输出
 *   （等价于 out[outY][outX] = src[floor(outY/scale)][floor(outX/scale)]）
 */
export function replicateRows(
  src: Uint8Array,
  srcWidth: number,
  scale: number,
  startSrcY: number,
  endSrcY: number,
): Uint8Array {
  const outWidth = srcWidth * scale;
  const srcRowBytes = srcWidth * CHANNELS;
  const outRowBytes = outWidth * CHANNELS;
  const srcRows = endSrcY - startSrcY;
  const outRows = srcRows * scale;

  const out = new Uint8Array(outRows * outRowBytes);
  if (outRows === 0) return out;

  // 复用单条放大后的行缓冲，避免每个输入行重复分配。
  const expandedRow = new Uint8Array(outRowBytes);

  for (let sy = startSrcY; sy < endSrcY; sy++) {
    const srcBase = sy * srcRowBytes;

    // 水平方向：每个输入像素重复 scale 次，构造一条放大后的输出行。
    for (let x = 0; x < srcWidth; x++) {
      const sp = srcBase + x * CHANNELS;
      const r = src[sp];
      const g = src[sp + 1];
      const b = src[sp + 2];
      const a = src[sp + 3];
      const op = x * scale * CHANNELS;
      for (let k = 0; k < scale; k++) {
        const p = op + k * CHANNELS;
        expandedRow[p] = r;
        expandedRow[p + 1] = g;
        expandedRow[p + 2] = b;
        expandedRow[p + 3] = a;
      }
    }

    // 垂直方向：将这条输出行重复 scale 次。
    const outBase = (sy - startSrcY) * scale * outRowBytes;
    for (let k = 0; k < scale; k++) {
      out.set(expandedRow, outBase + k * outRowBytes);
    }
  }

  return out;
}

/** 便捷函数：一次性放大整张图（测试与小图路径使用）。 */
export function replicateFull(
  src: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  scale: number,
): Uint8Array {
  return replicateRows(src, srcWidth, scale, 0, srcHeight);
}