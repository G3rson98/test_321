/** Utilidades compartidas por los launchers: archivo de control y seguimiento del log del ejecutor. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { SHARD_FILES } from '../../config.js';
import { writeFileAtomic } from '../../util/fs.js';

export async function writeControlFile(secretsDir: string, stop: 'cancel' | 'shutdown' | 'revoke'): Promise<void> {
  try {
    await writeFileAtomic(path.join(secretsDir, SHARD_FILES.control), JSON.stringify({ stop, at: new Date().toISOString() }));
  } catch {
    // directorio ya eliminado
  }
}

/** Sigue un archivo de log (el ejecutor lo escribe ya sanitizado) y entrega líneas completas. */
export class LogTailer {
  private offset = 0;
  private buf = '';
  private timer: NodeJS.Timeout | null = null;
  private readonly listeners: Array<(line: string) => void> = [];

  constructor(
    private readonly file: string,
    private readonly intervalMs = 1000,
  ) {}

  onLine(l: (line: string) => void): void {
    this.listeners.push(l);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
  }

  async poll(): Promise<void> {
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(this.file, 'r');
      const { size } = await handle.stat();
      if (size <= this.offset) return;
      const len = Math.min(size - this.offset, 1024 * 1024);
      const chunk = Buffer.alloc(len);
      await handle.read(chunk, 0, len, this.offset);
      this.offset += len;
      this.buf += chunk.toString('utf8');
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        for (const l of this.listeners) l(line);
      }
    } catch {
      // aún no existe
    } finally {
      await handle?.close();
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.poll();
  }
}

export function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve('timeout');
      },
    );
  });
}
