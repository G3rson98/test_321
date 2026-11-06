/**
 * Terminación del árbol de procesos (ESP §13.3: "termina su árbol de procesos antes de 30 s").
 * Playwright lanza Chromium como líder de su propio grupo de procesos (`detached`), por lo que matar solo el
 * grupo del ejecutor no basta: se toma una instantánea de descendientes (por ppid) ANTES de señalizar, porque los
 * huérfanos se re-parentan a init y perderían el vínculo. Linux: /proc; otros: `ps`.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface ProcInfo {
  pid: number;
  ppid: number;
}

async function listProcesses(): Promise<ProcInfo[]> {
  if (process.platform === 'linux') {
    const out: ProcInfo[] = [];
    for (const name of await fs.readdir('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = await fs.readFile(`/proc/${name}/stat`, 'utf8');
        // pid (comm) state ppid ...  — comm puede contener espacios/paréntesis.
        const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        out.push({ pid: Number(name), ppid: Number(rest[1]) });
      } catch {
        // proceso terminado durante la lectura
      }
    }
    return out;
  }
  const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid='], { maxBuffer: 8 * 1024 * 1024 });
  return stdout
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 2 && /^\d+$/.test(p[0]!) && /^\d+$/.test(p[1]!))
    .map((p) => ({ pid: Number(p[0]), ppid: Number(p[1]) }));
}

/** Descendientes (sin incluir `rootPid`). */
export async function listDescendants(rootPid: number): Promise<number[]> {
  let procs: ProcInfo[];
  try {
    procs = await listProcesses();
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const p of procs) {
    const list = children.get(p.ppid) ?? [];
    list.push(p.pid);
    children.set(p.ppid, list);
  }
  const out: number[] = [];
  const stack = [...(children.get(rootPid) ?? [])];
  while (stack.length) {
    const pid = stack.pop()!;
    if (out.includes(pid)) continue;
    out.push(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return out;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function signalQuiet(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // ya terminó
  }
}

export interface KillTreeOptions {
  /** Señal inicial (cortesía) y espera antes de SIGKILL. */
  signal?: NodeJS.Signals;
  graceMs: number;
  /** El proceso raíz es líder de grupo (spawn `detached`): señalizar también el grupo. */
  processGroup?: boolean;
  /** Enviar la señal inicial también a cada descendiente (default true). Con `false` solo al raíz/grupo. */
  signalDescendants?: boolean;
  /** Resuelve cuando el proceso raíz terminó (para no esperar la gracia completa). */
  exited?: Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Señaliza `rootPid`, su grupo y todos sus descendientes; tras `graceMs`, SIGKILL a todo lo que siga vivo
 * (instantánea inicial + descendientes actuales). Devuelve los PID que debieron forzarse.
 */
export async function killTree(rootPid: number, opts: KillTreeOptions): Promise<number[]> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const snapshot = await listDescendants(rootPid);
  const initial = opts.signal ?? 'SIGTERM';
  if (opts.processGroup) signalQuiet(-rootPid, initial);
  signalQuiet(rootPid, initial);
  if (opts.signalDescendants !== false) for (const pid of snapshot) signalQuiet(pid, initial);

  if (opts.graceMs > 0) {
    const deadline = Date.now() + opts.graceMs;
    const allDead = (): boolean => !isAlive(rootPid) && snapshot.every((p) => !isAlive(p));
    const rootExited = opts.exited ? opts.exited.then(() => true) : null;
    while (Date.now() < deadline && !allDead()) {
      await Promise.race([sleep(Math.min(100, Math.max(1, deadline - Date.now()))), ...(rootExited ? [rootExited] : [])]);
      if (rootExited && !isAlive(rootPid) && snapshot.every((p) => !isAlive(p))) break;
    }
  }
  const current = isAlive(rootPid) ? await listDescendants(rootPid) : [];
  const forced = [...new Set([rootPid, ...snapshot, ...current])].filter((p) => isAlive(p));
  if (opts.processGroup) signalQuiet(-rootPid, 'SIGKILL');
  for (const pid of forced) signalQuiet(pid, 'SIGKILL');
  return forced;
}

/** Línea de comando de un proceso (para no matar PIDs reutilizados por procesos ajenos). */
export async function commandOf(pid: number): Promise<string | null> {
  try {
    if (process.platform === 'linux') {
      return (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).replace(/\0/g, ' ').trim();
    }
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command=']);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
