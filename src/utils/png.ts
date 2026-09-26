import { createDeflate } from 'node:zlib';
import { createWriteStream, promises as fsp } from 'node:fs';
import { once } from 'node:events';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// CRC32 查找表
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function makeIHDR(width: number, height: number): Buffer {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(width, 0);
  d.writeUInt32BE(height, 4);
  d[8] = 8; // bit depth
  d[9] = 6; // color type: truecolor with alpha (RGBA)
  d[10] = 0; // compression
  d[11] = 0; // filter method
  d[12] = 0; // interlace
  return pngChunk('IHDR', d);
}

const IDAT_MAX = 65536;

/**
 * 流式 PNG 编码器（color type 6, bit depth 8, filter type 0）。
 * 允许把“放大输出块”逐行直接喂入压缩流，全程不落地临时 raw 文件、
 * 不把完整输出载入内存；最终磁盘上只有压缩后的小 PNG。
 */
export class PngStreamEncoder {
  private readonly width: number;
  private readonly output: ReturnType<typeof createWriteStream>;
  private readonly deflate: ReturnType<typeof createDeflate>;
  private readonly rowBytes: number;
  private writtenRows = 0;
  private readonly height: number;

  constructor(width: number, height: number, outPath: string) {
    this.width = width;
    this.height = height;
    this.rowBytes = width * 4;
    this.output = createWriteStream(outPath);
    this.output.write(PNG_SIGNATURE);
    this.output.write(makeIHDR(width, height));

    this.deflate = createDeflate({ level: 6 });
    // 背压：输出流排队满则暂停 deflate，避免 IDAT 累积撑爆内存。
    this.deflate.on('data', (data: Buffer) => {
      let ok = true;
      for (let i = 0; i < data.length && ok; i += IDAT_MAX) {
        ok = this.output.write(
          pngChunk('IDAT', data.subarray(i, Math.min(i + IDAT_MAX, data.length))),
        );
      }
      if (!ok) this.deflate.pause();
    });
    this.output.on('drain', () => this.deflate.resume());
  }

  get rowsWritten(): number {
    return this.writtenRows;
  }

  /** 追加一段已放大好的输出行（RGBA，宽度必须等于输出宽度，行数任意）。 */
  async writeRows(data: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset + this.rowBytes <= data.length) {
      const row = Buffer.alloc(1 + this.rowBytes);
      row[0] = 0; // filter type 0 (None)
      Buffer.from(data.subarray(offset, offset + this.rowBytes)).copy(row, 1);
      if (!this.deflate.write(row)) {
        await once(this.deflate, 'drain');
      }
      this.writtenRows++;
      offset += this.rowBytes;
    }
    if (offset !== data.length) {
      throw new Error('PngStreamEncoder: 输出块未对齐到整行');
    }
  }

  async finish(): Promise<void> {
    if (this.writtenRows !== this.height) {
      throw new Error(
        `PngStreamEncoder: 行数不匹配，已写 ${this.writtenRows} / 期望 ${this.height}`,
      );
    }
    this.deflate.end();
    await once(this.deflate, 'end');
    this.output.end(pngChunk('IEND', Buffer.alloc(0)));
    await once(this.output, 'finish');
  }
}

/**
 * 将 raw RGBA 文件按“行”流式编码为 PNG（用于 jpeg/webp 之外、已有 raw 文件的场景）。
 */
export async function encodeRawFileToPng(
  rawPath: string,
  width: number,
  height: number,
  outPath: string,
): Promise<void> {
  const encoder = new PngStreamEncoder(width, height, outPath);
  const input = await fsp.open(rawPath, 'r');
  try {
    const rowBytes = width * 4;
    const row = Buffer.alloc(1 + rowBytes);
    row[0] = 0; // filter type 0 (None)
    for (let y = 0; y < height; y++) {
      let off = 1;
      const target = 1 + rowBytes;
      const fileOff = y * rowBytes;
      while (off < target) {
        const { bytesRead } = await input.read(row, off, target - off, fileOff + (off - 1));
        if (bytesRead === 0) break;
        off += bytesRead;
      }
      await encoder.writeRows(row.subarray(1, 1 + rowBytes));
    }
  } finally {
    await input.close();
  }
  await encoder.finish();
}