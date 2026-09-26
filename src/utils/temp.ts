import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const created: string[] = [];

/**
 * 在指定（或系统）临时目录创建一个 .raw 临时文件并登记，便于退出/失败时统一清理。
 */
export async function createRawTempFile(tempDir?: string): Promise<string> {
  const base = path.resolve(tempDir ?? os.tmpdir());
  if (!fs.existsSync(base)) {
    throw new Error(`临时目录不存在：${base}`);
  }
  const file = path.join(
    base,
    `cf-upscaler-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.raw`,
  );
  // 先创建并确保可写
  const fh = await fs.promises.open(file, 'wx');
  await fh.close();
  created.push(file);
  return file;
}

/** 注册一个需要清理的临时文件路径（供外部自行创建的场景）。 */
export function registerTempFile(file: string): void {
  created.push(path.resolve(file));
}

/** 清理所有已登记的临时文件。失败静默忽略。 */
export function cleanupTempFiles(): void {
  for (const f of created.splice(0)) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
}