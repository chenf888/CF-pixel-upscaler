import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';

import { replicateRows } from './engines/manual.js';
import { sharpNearestToRaw, sharpNearestToFile } from './engines/sharpNearest.js';
import { ProgressReporter } from './progress.js';
import {
  decodeRaw,
  detectFormat,
  encodeRawFile,
  getImageSize,
  type OutputFormat,
} from './utils/image.js';
import { PngStreamEncoder } from './utils/png.js';
import {
  assertInputFile,
  assertOutputWritable,
  checkAvailableMemory,
  checkDiskSpace,
  clampInt,
  computeOutputDims,
  formatBytes,
  isPositiveInt,
  type OutputDims,
} from './utils/check.js';
import { cleanupTempFiles, createRawTempFile } from './utils/temp.js';

export type EngineName = 'manual' | 'sharp-nearest' | 'auto';

export interface UpscaleOptions {
  input: string;
  output?: string;
  scale?: number;
  workers?: number;
  chunkRows?: number;
  format?: string;
  quality?: number;
  maxOutputPixels?: number;
  force?: boolean;
  tempDir?: string;
  overwrite?: boolean;
  keepMetadata?: boolean;
  engine?: EngineName;
  compare?: boolean;
  progress?: boolean;
}

export interface Stats {
  engine: string;
  elapsedMs: number;
  throughputMpx: number;
  peakMemoryBytes: number;
  outputPixels: number;
}

export interface CompareResult {
  manual: Stats;
  sharp: Stats;
  identical: boolean;
  firstMismatch?: number;
}

export interface UpscaleResult {
  output: string;
  inputWidth: number;
  inputHeight: number;
  outWidth: number;
  outHeight: number;
  scale: number;
  format: OutputFormat;
  engineUsed: 'manual' | 'sharp-nearest';
  stats: Stats;
  compare?: CompareResult;
  tempRawPath?: string;
  warnings: string[];
}

interface Chunk {
  start: number;
  end: number;
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

function defaultOutputPath(input: string, scale: number): string {
  const dir = path.dirname(input);
  const parsed = path.parse(input);
  return path.join(dir, `${parsed.name}_x${scale}.png`);
}

function resolveWorkers(userWorkers: number | undefined): number {
  const max =
    typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  if (userWorkers && isPositiveInt(userWorkers)) return Math.max(1, Math.min(userWorkers, max));
  return Math.max(1, max);
}

function resolveChunkRows(
  userChunkRows: number | undefined,
  height: number,
  workers: number,
  scale: number,
  outWidth: number,
): number {
  if (userChunkRows && isPositiveInt(userChunkRows)) return Math.min(userChunkRows, height);
  const perInputRowOutputBytes = scale * outWidth * 4;
  const TARGET_CHUNK_BYTES = 16 * 1024 * 1024;
  const target = Math.max(1, Math.floor(TARGET_CHUNK_BYTES / perInputRowOutputBytes));
  // 保证至少 workers*4 个分块以便负载均衡（作为 chunkRows 的上界）。
  const forParallel = Math.max(1, Math.ceil(height / Math.max(1, workers * 4)));
  return Math.min(height, Math.max(1, Math.min(target, forParallel)));
}

function buildChunks(height: number, chunkRows: number): Chunk[] {
  const chunks: Chunk[] = [];
  for (let start = 0; start < height; start += chunkRows) {
    chunks.push({ start, end: Math.min(start + chunkRows, height) });
  }
  return chunks;
}

function peakRssSampler(): () => number {
  let peak = process.memoryUsage().rss;
  const iv = setInterval(() => {
    const r = process.memoryUsage().rss;
    if (r > peak) peak = r;
  }, 20);
  return () => {
    clearInterval(iv);
    const r = process.memoryUsage().rss;
    if (r > peak) peak = r;
    return peak;
  };
}

interface PoolState {
  sab: SharedArrayBuffer;
  /** 单线程/非线程化路径直接复用的源 buffer（解码所得），避免再复制进 SAB。 */
  source?: Uint8Array;
  width: number;
  height: number;
  scale: number;
  chunkRows: number;
  workers: number;
  threaded: boolean;
  onChunk: (index: number, buffer: Uint8Array) => Promise<void>;
  onProgress: (doneOutputRows: number) => void;
}

/**
 * 多核分块执行 manual 放大：
 * - 输入 raw 放入 SharedArrayBuffer（零拷贝共享给 worker）。
 * - 每个任务处理 [startSrcY, endSrcY) 输入行，生成对应输出行块。
 * - worker 返回带序号的输出缓冲（transferable，零拷贝）。
 * - 主线程按序号顺序回调 onChunk 写入，乱序完成的块先缓存，限制在途任务数。
 */
async function runPool(o: PoolState): Promise<void> {
  const chunks = buildChunks(o.height, o.chunkRows);
  const total = chunks.length;

  const pending = new Map<number, Uint8Array>();
  let nextToWrite = 0;
  let received = 0;
  let hadError: Error | null = null;

  const onResult = async (index: number, buffer: Uint8Array) => {
    pending.set(index, buffer);
    while (pending.has(nextToWrite)) {
      const buf = pending.get(nextToWrite)!;
      pending.delete(nextToWrite);
      await o.onChunk(nextToWrite, buf);
      nextToWrite++;
    }
    received++;
    o.onProgress(Math.min(nextToWrite * o.chunkRows * o.scale, o.height * o.scale));
  };

  if (!o.threaded) {
    // 小图/单线程：主线程直接计算，避免 worker 启动开销。
    const src = o.source ?? new Uint8Array(o.sab);
    for (let i = 0; i < total; i++) {
      if (hadError) break;
      const { start, end } = chunks[i];
      const out = replicateRows(src, o.width, o.scale, start, end);
      await onResult(i, out);
    }
    if (hadError) throw hadError;
    return;
  }

  const workerUrl = new URL('./worker.js', import.meta.url);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let nextToSend = 0;

    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      workers.forEach((w) => void w.terminate());
      if (err) reject(err);
      else resolve();
    };

    const dispatch = (w: Worker) => {
      if (hadError || nextToSend >= total) return;
      const idx = nextToSend++;
      const { start, end } = chunks[idx];
      w.postMessage({ sab: o.sab, srcWidth: o.width, scale: o.scale, startSrcY: start, endSrcY: end, index: idx });
    };

    const workers: Worker[] = [];
    for (let i = 0; i < o.workers; i++) {
      const w = new Worker(workerUrl);
      w.on('message', (msg: { index: number; buffer?: Uint8Array; error?: string }) => {
        if (msg.error) {
          hadError = new Error(`worker 崩溃：${msg.error}`);
          settle(hadError);
          return;
        }
        onResult(msg.index, msg.buffer!)
          .then(() => {
            if (received === total) settle();
            else dispatch(w);
          })
          .catch((e) => {
            hadError = e as Error;
            settle(hadError);
          });
      });
      w.on('error', (e) => {
        hadError = new Error(`worker 线程错误：${e.message}`);
        settle(hadError);
      });
      workers.push(w);
    }

    for (const w of workers) dispatch(w);
  });
}

interface ManualRunResult {
  stats: Stats;
  tempRawPath: string;
}

interface ManualRunOptions {
  data: Buffer;
  width: number;
  height: number;
  scale: number;
  outWidth: number;
  outHeight: number;
  pixels: number;
  workers: number;
  chunkRows: number;
  output: string;
  format: OutputFormat;
  quality: number;
  tempDir?: string;
  reporter: ProgressReporter;
  /** true 时视为大概率超大输出：PNG 走流式编码，不落地临时 raw（内存/磁盘安全）。 */
  streamPng?: boolean;
}

async function runManual(o: ManualRunOptions): Promise<ManualRunResult> {
  const { width, height, data } = o;
  const threaded = o.workers > 1;

  // 流式 PNG 路径：边放大边压缩写入最终文件，不产生 16GB 级别临时 raw。
  // 仅当目标为 PNG、且不处于 compare（compare 需要 raw 做逐字节比对）时启用。
  const streamPng = o.streamPng === true && o.format === 'png' && !threaded;

  const tempRawPath = streamPng
    ? ''
    : await createRawTempFile(o.tempDir);

  // 仅线程化路径才需要把输入 raw 放入共享内存（避免 worker 重复拷贝）；
  // 单线程直接复用解码 buffer，省去一次大内存复制。
  let sab: SharedArrayBuffer | null = null;
  if (threaded) {
    sab = new SharedArrayBuffer(data.byteLength);
    new Uint8Array(sab).set(data);
  }

  const sampler = peakRssSampler();
  const t0 = performance.now();
  o.reporter.start();

  // 输出通道：流式 PNG 编码器 或 临时 raw 文件句柄。
  const pngEncoder = streamPng
    ? new PngStreamEncoder(o.outWidth, o.outHeight, o.output)
    : null;
  let fh: fs.promises.FileHandle | null = null;
  let writeOffset = 0;
  if (!streamPng) {
    fh = await fs.promises.open(tempRawPath, 'w');
  }

  try {
    await runPool({
      width,
      height,
      scale: o.scale,
      chunkRows: o.chunkRows,
      workers: o.workers,
      threaded,
      source: threaded ? undefined : data,
      // TS 下 sab 仅在 threaded 为真时满足非空（见 runPool 使用处）。
      sab: sab ?? ({} as SharedArrayBuffer),
      onChunk: async (_index, buffer) => {
        if (pngEncoder) {
          await pngEncoder.writeRows(buffer);
          o.reporter.update(pngEncoder.rowsWritten);
          return;
        }
        if (fh) {
          let off = 0;
          while (off < buffer.byteLength) {
            const { bytesWritten } = await fh.write(buffer, off, buffer.byteLength - off, writeOffset + off);
            if (bytesWritten <= 0) throw new Error('写入临时 raw 文件失败（磁盘可能已满）');
            off += bytesWritten;
          }
          writeOffset += buffer.byteLength;
        }
      },
      onProgress: (doneOutputRows) => o.reporter.update(doneOutputRows),
    });
  } finally {
    if (fh) await fh.close();
  }

  if (pngEncoder) {
    await pngEncoder.finish();
  } else {
    // 编码为最终格式
    await encodeRawFile({
      rawPath: tempRawPath,
      width: o.outWidth,
      height: o.outHeight,
      output: o.output,
      format: o.format,
      quality: o.quality,
    });
  }

  const elapsedMs = performance.now() - t0;
  const peak = sampler();
  o.reporter.update(o.outHeight);
  o.reporter.stop();

  const stats: Stats = {
    engine: 'manual',
    elapsedMs,
    throughputMpx: o.pixels / 1e6 / (elapsedMs / 1000),
    peakMemoryBytes: peak,
    outputPixels: o.pixels,
  };

  return { stats, tempRawPath };
}

async function runCompare(
  src: Buffer,
  width: number,
  height: number,
  scale: number,
  pixels: number,
  manualStats: Stats,
  manualRawPath: string,
): Promise<CompareResult> {
  const sampler = peakRssSampler();
  const t0 = performance.now();
  const sharpData = await sharpNearestToRaw(src, width, height, scale);
  const elapsedMs = performance.now() - t0;
  const peak = sampler();

  const manualRaw = await fs.promises.readFile(manualRawPath);
  const identical = manualRaw.length === sharpData.length && manualRaw.equals(sharpData);

  let firstMismatch: number | undefined;
  if (!identical) {
    const len = Math.min(manualRaw.length, sharpData.length);
    for (let i = 0; i < len; i++) {
      if (manualRaw[i] !== sharpData[i]) {
        firstMismatch = i;
        break;
      }
    }
    if (firstMismatch === undefined) firstMismatch = len;
  }

  return {
    manual: manualStats,
    sharp: {
      engine: 'sharp-nearest',
      elapsedMs,
      throughputMpx: pixels / 1e6 / (elapsedMs / 1000),
      peakMemoryBytes: peak,
      outputPixels: pixels,
    },
    identical,
    firstMismatch,
  };
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function upscale(options: UpscaleOptions): Promise<UpscaleResult> {
  const warnings: string[] = [];

  const scale = options.scale ?? 2;
  if (!isPositiveInt(scale)) {
    throw new Error(`--scale 必须是正整数，收到：${options.scale}`);
  }

  if (options.engine && !['manual', 'sharp-nearest', 'auto'].includes(options.engine)) {
    throw new Error(`未知引擎：${options.engine}（可选 manual | sharp-nearest | auto）`);
  }

  const input = path.resolve(options.input);
  await assertInputFile(input);

  const output = options.output ? path.resolve(options.output) : defaultOutputPath(input, scale);
  assertOutputWritable(output, options.overwrite ?? false);

  const format = detectFormat(output, options.format);
  const quality = clampInt(options.quality ?? 90, 1, 100);
  const maxOutputPixels = options.maxOutputPixels ?? 1e9;
  const force = options.force ?? false;

  // 1) 轻量获取尺寸（不载入像素），并做尺寸与安全检查
  const { width, height } = await getImageSize(input);
  if (!isPositiveInt(width) || !isPositiveInt(height)) {
    throw new Error(`图片尺寸非法：${width}x${height}`);
  }
  let dims: OutputDims;
  try {
    dims = computeOutputDims(width, height, scale, format, maxOutputPixels, force);
  } catch (e) {
    throw e;
  }
  warnings.push(...dims.warnings);
  const { outWidth, outHeight } = dims;

  // 2) 决定实际引擎（先决定引擎再决定是否需要整图解码）
  const requestedEngine = options.engine ?? 'manual';
  let engineUsed: 'manual' | 'sharp-nearest';
  if (requestedEngine === 'auto') {
    engineUsed = dims.pixels <= 4_000_000 ? 'sharp-nearest' : 'manual';
  } else {
    engineUsed = requestedEngine === 'sharp-nearest' ? 'sharp-nearest' : 'manual';
  }

  const requestedWorkers = options.workers;
  let workers = resolveWorkers(requestedWorkers);
  const chunkRows = resolveChunkRows(options.chunkRows, height, workers, scale, outWidth);
  const chunkCount = Math.ceil(height / chunkRows);
  // 小图（且用户未显式指定 --workers）自动降级为单线程，避免 worker 启动开销。
  if (!requestedWorkers && dims.pixels < 1_000_000) {
    workers = 1;
  }
  // worker 数不超过分块数，避免空转线程。
  workers = Math.max(1, Math.min(workers, chunkCount));

  // 磁盘空间
  checkDiskSpace(options.tempDir ?? os.tmpdir(), Math.min(dims.rawBytes * 1.2, Number.MAX_SAFE_INTEGER), force, '临时 raw');
  checkDiskSpace(path.dirname(output), dims.rawBytes + 1024, force, '最终产物');

  // 仅 manual 引擎需要把输入整图解码进内存；sharp-nearest 由 sharp 流式处理。
  let decoded: { data: Buffer } | null = null;
  if (engineUsed === 'manual') {
    decoded = await decodeRaw(input);
    const memWarn1 = checkAvailableMemory(decoded.data.byteLength, force, '输入解码 raw');
    if (memWarn1) warnings.push(memWarn1);
  }
  if (format !== 'png') {
    const memWarn2 = checkAvailableMemory(dims.rawBytes, force, `${format.toUpperCase()} 编码`);
    if (memWarn2) warnings.push(memWarn2);
  }

  const reporter = new ProgressReporter(outHeight, outWidth, workers, options.progress ?? true);

  let stats: Stats;
  let tempRawPath: string | undefined;
  let compare: CompareResult | undefined;

  if (engineUsed === 'sharp-nearest') {
    const sampler = peakRssSampler();
    const t0 = performance.now();
    reporter.start();
    await sharpNearestToFile({
      input,
      output,
      scale,
      format,
      quality,
      keepMetadata: options.keepMetadata,
    });
    const elapsedMs = performance.now() - t0;
    const peak = sampler();
    reporter.update(outHeight);
    reporter.stop();
    stats = {
      engine: 'sharp-nearest',
      elapsedMs,
      throughputMpx: dims.pixels / 1e6 / (elapsedMs / 1000),
      peakMemoryBytes: peak,
      outputPixels: dims.pixels,
    };
  } else {
    // manual 分支上方已保证 decoded 非空。
    const manual = await runManual({
      data: (decoded as { data: Buffer }).data,
      width,
      height,
      scale,
      outWidth,
      outHeight,
      pixels: dims.pixels,
      workers,
      chunkRows,
      output,
      format,
      quality,
      tempDir: options.tempDir,
      reporter,
      // 仅非 compare 的 PNG 才走流式编码，避免 16GB 级别临时 raw。
      streamPng: force && !options.compare,
    });
    stats = manual.stats;
    tempRawPath = manual.tempRawPath;

    if (options.compare) {
      compare = await runCompare(
        (decoded as { data: Buffer }).data,
        width,
        height,
        scale,
        dims.pixels,
        stats,
        tempRawPath,
      );
    }
  }

  const result: UpscaleResult = {
    output,
    inputWidth: width,
    inputHeight: height,
    outWidth,
    outHeight,
    scale,
    format,
    engineUsed,
    stats,
    compare,
    tempRawPath,
    warnings,
  };

  // 清理临时 raw 文件
  cleanupTempFiles();

  return result;
}