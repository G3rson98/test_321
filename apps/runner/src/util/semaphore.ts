/**
 * Semáforo de concurrencia global de navegadores (RNF-OPT-05, ARQ §4: `global_browser_concurrency=1`).
 * Un permiso = un contenedor/proceso ejecutor con un único worker de Playwright (nunca N contenedores × N workers).
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('capacidad inválida');
    this.available = capacity;
  }

  get inUse(): number {
    return this.capacity - this.available;
  }

  tryAcquire(): boolean {
    if (this.available > 0) {
      this.available -= 1;
      return true;
    }
    return false;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (this.tryAcquire()) return;
    await new Promise<void>((resolve, reject) => {
      const grant = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = (): void => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error('adquisición abortada'));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(grant);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.available = Math.min(this.capacity, this.available + 1);
  }
}
