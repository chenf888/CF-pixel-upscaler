import cliProgress from 'cli-progress';
import { formatDuration, formatBytes } from './utils/check.js';

const { SingleBar, Presets } = cliProgress;

interface BarLike {
  start(total: number, value: number, payload?: Record<string, unknown>): void;
  update(value: number, payload?: Record<string, unknown>): void;
  stop(): void;
}

/**
 * 实时进度条：显示百分比、进度条、已处理输出行/总输出行、速度(MP/s)、ETA、worker 数与当前内存。
 * 非 TTY 环境下自动禁用，避免在 CI/测试里刷屏。
 */
export class ProgressReporter {
  private bar: BarLike | undefined;
  private readonly total: number;
  private readonly outWidth: number;
  private readonly workers: number;
  private readonly enabled: boolean;
  private readonly startTime: number;
  private lastUpdate: number;

  constructor(totalOutputRows: number, outWidth: number, workers: number, enabled = true) {
    this.total = totalOutputRows;
    this.outWidth = outWidth;
    this.workers = workers;
    this.enabled = enabled && Boolean(process.stderr.isTTY);
    this.startTime = Date.now();
    this.lastUpdate = 0;
  }

  start(): void {
    if (!this.enabled) return;
    this.bar = new SingleBar(
      {
        format:
          '放大进度 [{bar}] {percentage}% | {value}/{total} 行 | {speed} MP/s | ETA {eta} | {workers} workers | 内存 {mem}',
        barCompleteChar: '\u2588',
        barIncompleteChar: '\u2591',
        hideCursor: true,
        clearOnComplete: true,
        stopOnComplete: true,
        fps: 10,
      },
      Presets.shades_classic,
    ) as unknown as BarLike;
    this.bar.start(this.total, 0, {
      speed: '0.00',
      eta: formatDuration(0),
      workers: this.workers,
      mem: formatBytes(process.memoryUsage().rss),
    });
  }

  update(doneOutputRows: number): void {
    if (!this.enabled || !this.bar) return;
    const now = Date.now();
    // 每 100ms 更新一次，或完成时强制更新，避免刷屏阻塞主线程。
    const isDone = doneOutputRows >= this.total;
    if (now - this.lastUpdate < 100 && !isDone) return;
    this.lastUpdate = now;

    const value = Math.max(0, Math.min(doneOutputRows, this.total));
    const elapsed = Math.max((now - this.startTime) / 1000, 0.001);
    const pixels = value * this.outWidth;
    const speedMps = pixels / 1e6 / elapsed;
    const rowsPerSec = value / elapsed;
    const remain = this.total - value;
    const eta = rowsPerSec > 0 ? remain / rowsPerSec : 0;

    this.bar.update(value, {
      speed: speedMps.toFixed(2),
      eta: formatDuration(eta),
      workers: this.workers,
      mem: formatBytes(process.memoryUsage().rss),
    });
  }

  stop(): void {
    if (this.bar) {
      this.bar.stop();
      this.bar = undefined;
    }
  }
}