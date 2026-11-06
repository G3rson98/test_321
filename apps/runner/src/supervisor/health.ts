/** Salud del supervisor: actualiza el mtime de `KATALYST_HEALTH_FILE` cada ≤ 15 s (docs/infraestructura.md §5). */
import { touch } from '../util/fs.js';

export function startHealthTicker(file: string | undefined, intervalMs: number): () => void {
  if (!file) return () => undefined;
  const tick = () => void touch(file).catch(() => undefined);
  tick();
  const t = setInterval(tick, Math.min(intervalMs, 15_000));
  t.unref();
  return () => clearInterval(t);
}
