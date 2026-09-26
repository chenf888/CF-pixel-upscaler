import { parentPort } from 'node:worker_threads';
import { replicateRows } from './engines/manual.js';

interface WorkerMessage {
  sab: SharedArrayBuffer;
  srcWidth: number;
  scale: number;
  startSrcY: number;
  endSrcY: number;
  index: number;
}

interface WorkerResult {
  index: number;
  buffer?: Uint8Array;
  error?: string;
  rss?: number;
}

const port = parentPort;
if (!port) {
  throw new Error('worker 模块只能在 Worker 线程中运行');
}

port.on('message', (msg: WorkerMessage) => {
  try {
    // 直接引用共享内存，不拷贝输入 raw。
    const src = new Uint8Array(msg.sab);
    const out = replicateRows(src, msg.srcWidth, msg.scale, msg.startSrcY, msg.endSrcY);
    const result: WorkerResult = {
      index: msg.index,
      buffer: out,
      rss: process.memoryUsage().rss,
    };
    // 转移输出缓冲的所有权，避免跨线程拷贝。
    // out 是全新分配的 Uint8Array，其 buffer 必为普通 ArrayBuffer（可转移）。
    port.postMessage(result, [out.buffer as ArrayBuffer]);
  } catch (e) {
    const result: WorkerResult = { index: msg.index, error: (e as Error).message };
    port.postMessage(result);
  }
});