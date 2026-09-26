#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { upscale, type UpscaleOptions, type EngineName } from './index.js';
import { cleanupTempFiles } from './utils/temp.js';
import { formatBytes } from './utils/check.js';

export interface CliOptions {
  input: string;
  output: string;
  scale: string;
  workers?: string;
  chunkRows: string;
  format?: string;
  quality: string;
  maxOutputPixels: string;
  force?: boolean;
  tempDir?: string;
  overwrite?: boolean;
  keepMetadata?: boolean;
  engine: string;
  compare?: boolean;
  progress?: boolean;
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name('pixel-upscaler')
    .description('整数倍像素复制放大 CLI（最近邻/像素复制），多核并行、内存安全')
    .version('1.0.0')
    .requiredOption('-i, --input <file>', '输入图片路径')
    .requiredOption('-o, --output <file>', '输出图片路径')
    .option('-s, --scale <n>', '放大倍数（正整数，默认 2）', '2')
    .option('-w, --workers <n>', 'worker 数量（默认 CPU 逻辑核心数）')
    .option('--chunk-rows <n>', '每个任务处理的输入行数（0 表示自动）', '0')
    .option('--format <f>', '输出格式：png | jpeg | webp（默认按输出扩展名）')
    .option('--quality <n>', 'JPEG/WebP 质量（1-100，默认 90）', '90')
    .option('--max-output-pixels <n>', '输出像素安全阈值（默认 1000000000）', '1000000000')
    .option('--force', '允许超过安全阈值 / 覆盖内存磁盘限制（会警告）')
    .option('--temp-dir <dir>', '临时目录（默认系统临时目录）')
    .option('--overwrite', '允许覆盖已存在的输出文件')
    .option('--keep-metadata', '尽量保留 EXIF/ICC（仅 sharp-nearest 引擎支持）')
    .option('--engine <e>', 'manual | sharp-nearest | auto（默认 manual）', 'manual')
    .option('--compare', '启用 manual 与 sharp-nearest 的性能对比')
    .option('--no-progress', '禁用进度条');
  return program;
}

export async function run(argv: string[] = process.argv.slice(2)): Promise<number> {
  const program = createProgram();
  program.exitOverride();
  program.configureOutput({
    writeErr: (str) => process.stderr.write(str),
    writeOut: (str) => process.stdout.write(str),
  });

  try {
    program.parse(['node', 'pixel-upscaler', ...argv], { from: 'user' });
  } catch (e) {
    const err = e as CommanderError;
    if (err && typeof err.exitCode === 'number') {
      return err.exitCode;
    }
    throw e;
  }

  const o = program.opts<CliOptions>();

  const scale = Number(o.scale);
  const quality = Number(o.quality);
  const maxOutputPixels = Number(o.maxOutputPixels);

  const options: UpscaleOptions = {
    input: o.input,
    output: o.output,
    scale,
    workers: o.workers ? Number(o.workers) : undefined,
    chunkRows: o.chunkRows && o.chunkRows !== '0' ? Number(o.chunkRows) : undefined,
    format: o.format,
    quality,
    maxOutputPixels,
    force: o.force,
    tempDir: o.tempDir,
    overwrite: o.overwrite,
    keepMetadata: o.keepMetadata,
    engine: o.engine as EngineName,
    compare: o.compare,
    progress: o.progress,
  };

  try {
    const t0 = Date.now();
    const result = await upscale(options);
    const totalMs = Date.now() - t0;

    for (const w of result.warnings) {
      process.stderr.write(`警告：${w}\n`);
    }

    console.log(`✔ 已输出：${result.output}`);
    console.log(
      `  尺寸：${result.inputWidth}x${result.inputHeight} → ${result.outWidth}x${result.outHeight}（scale=${result.scale}）`,
    );
    console.log(`  格式：${result.format}，引擎：${result.engineUsed}`);
    console.log(
      `  放大耗时：${(result.stats.elapsedMs / 1000).toFixed(3)}s，吞吐：${result.stats.throughputMpx.toFixed(2)} MP/s，峰值内存：${formatBytes(result.stats.peakMemoryBytes)}`,
    );
    console.log(`  总耗时（含解码/编码）：${(totalMs / 1000).toFixed(3)}s`);

    if (o.engine === 'auto') {
      console.log(`  ℹ  auto 模式实际使用引擎：${result.engineUsed}`);
    }

    if (result.compare) {
      console.log('\n== 性能对比（manual vs sharp-nearest）==');
      console.log(
        `  manual        ：${(result.compare.manual.elapsedMs / 1000).toFixed(3)}s，` +
          `${result.compare.manual.throughputMpx.toFixed(2)} MP/s，峰值 ${formatBytes(result.compare.manual.peakMemoryBytes)}`,
      );
      console.log(
        `  sharp-nearest ：${(result.compare.sharp.elapsedMs / 1000).toFixed(3)}s，` +
          `${result.compare.sharp.throughputMpx.toFixed(2)} MP/s，峰值 ${formatBytes(result.compare.sharp.peakMemoryBytes)}`,
      );
      console.log(
        `  像素结果一致：${result.compare.identical ? '✔ 一致' : `✘ 不一致（首个差异下标 ${result.compare.firstMismatch}）`}`,
      );
    }
    return 0;
  } catch (e) {
    process.stderr.write(`✘ 错误：${(e as Error).message}\n`);
    return 1;
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  process.on('exit', cleanupTempFiles);
  process.on('SIGINT', () => {
    // SIGINT：清理临时文件后退出（退出码 130）。
    cleanupTempFiles();
    process.exit(130);
  });
  run().then((code) => {
    process.exitCode = code;
  });
}