/* eslint-disable @typescript-eslint/no-explicit-any -- script de aceptación: respuestas JSON sin tipar */
/**
 * Ensayo de carga del panel/API (RNF-REN-01, ESP §17.5): N usuarios concurrentes (default 10, una sesión por
 * usuario) en lazo cerrado sin tiempo de reflexión (peor caso) contra las APIs de listado con páginas de 100 filas:
 * `/testrail/cases` (sin filtro, búsqueda, suite, sección con descendientes, último resultado, automatizados,
 * paginación profunda por cursor), `/tests` (búsqueda, etiqueta, estado), `/runs` (estado, ambiente), `/schedules`
 * y `/audit-log` (página 1 y siguientes). Cliente: `fetch` de Node 24 (undici). Mide p50/p95/p99 por endpoint y
 * global, errores, CPU/RAM del equipo (`os`) y de los procesos (`ps`), y conexiones PostgreSQL abiertas
 * (`pg_stat_activity`, límite del presupuesto: 20).
 *
 * Uso: node scripts/load/run-load.ts --duration 300 [--concurrency 10] [--out archivo.json] < archivo-con-clave-admin
 *      Variables: KATALYST_STACK_DIR (lee stack.env: URL API y DATABASE_URL), SEED_ADMIN_EMAIL.
 * Requisito: RATE_LIMIT_MAX alto en la API para el ensayo (10 usuarios comparten la IP de loopback).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KatalystClient, readEnvFile, readStdin, stackDir } from '../lib/katalyst-client.ts';

const argv = process.argv.slice(2);
const opt = (n: string, d: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1]! : d;
};
const DURATION_S = Number(opt('duration', '300'));
const CONCURRENCY = Number(opt('concurrency', '10'));
const OUT = opt('out', '');
const STACK = stackDir();
const stackEnv = readEnvFile(path.join(STACK, 'stack.env'));
const API = process.env.KATALYST_DEV_API_URL ?? stackEnv.KATALYST_DEV_API_URL ?? 'http://127.0.0.1:3000';
const DB_URL = process.env.DATABASE_URL ?? stackEnv.DATABASE_URL ?? '';
const DB_NAME = DB_URL ? new URL(DB_URL).pathname.slice(1) : '';
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@katalyst.example.test';
const log = (m: string) => process.stderr.write(`[load] ${m}\n`);

interface Scenario {
  name: string;
  weight: number;
  path: () => string;
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, idx)]! * 10) / 10;
}

function sampleProcesses(): { name: string; cpu: number; rssMiB: number }[] {
  const pids: Record<string, string> = {};
  for (const n of ['api', 'control', 'reports', 'supervisor']) {
    const f = path.join(STACK, 'pids', `${n}.pid`);
    if (fs.existsSync(f)) pids[n] = fs.readFileSync(f, 'utf8').trim();
  }
  const out: { name: string; cpu: number; rssMiB: number }[] = [];
  try {
    const ps = execFileSync('ps', ['-A', '-o', 'pid=,pcpu=,rss=,comm='], { encoding: 'utf8' });
    let pgCpu = 0;
    let pgRss = 0;
    for (const line of ps.split('\n')) {
      const m = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const [, pid, cpu, rss, comm] = m;
      for (const [n, p] of Object.entries(pids)) if (p === pid) out.push({ name: n, cpu: Number(cpu), rssMiB: Math.round(Number(rss) / 1024) });
      if (/postgres/.test(comm!)) {
        pgCpu += Number(cpu);
        pgRss += Number(rss);
      }
    }
    out.push({ name: 'postgres(total)', cpu: Math.round(pgCpu * 10) / 10, rssMiB: Math.round(pgRss / 1024) });
  } catch {
    /* ps no disponible */
  }
  return out;
}

function pgConnections(): number | null {
  if (!DB_NAME) return null;
  try {
    const n = execFileSync('psql', [DB_URL.replace(/\?.*$/, ''), '-Atc', `select count(*) - 1 from pg_stat_activity where datname = '${DB_NAME.replace(/'/g, '')}'`], { encoding: 'utf8', timeout: 5000 });
    return Number(n.trim());
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const password = await readStdin();
  const sessions: KatalystClient[] = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    const c = new KatalystClient(API);
    await c.login(ADMIN_EMAIL, password);
    sessions.push(c);
  }
  const c0 = sessions[0]!;
  const suites = await c0.ok('GET', '/testrail/suites');
  const loadSuite = (suites.items ?? suites).find((s: any) => /Carga/.test(s.name));
  if (!loadSuite) throw new Error('No hay suite de carga: ejecuta scripts/load/seed-5000.ts');
  const sectionsRes = await c0.ok('GET', `/testrail/sections?suiteId=${loadSuite.id}`);
  const sections = (sectionsRes.items ?? sectionsRes).filter((s: any) => (s.depth ?? 0) === 0);
  const envs = await c0.all('/environments');
  const envId = (envs.find((e: any) => e.name === (process.env.SEED_ENV_NAME ?? 'staging-local')) ?? envs[0])?.id;
  // Cursores de páginas profundas (2..10) del listado principal de casos y de auditoría.
  const caseCursors: string[] = [];
  let cur: string | null = null;
  for (let i = 0; i < 10; i++) {
    const page: any = await c0.ok('GET', `/testrail/cases?limit=100${cur ? `&cursor=${encodeURIComponent(cur)}` : ''}`);
    if (!page.nextCursor) break;
    cur = page.nextCursor;
    caseCursors.push(cur!);
  }
  const auditCursors: string[] = [];
  cur = null;
  for (let i = 0; i < 10; i++) {
    const page: any = await c0.ok('GET', `/audit-log?limit=100${cur ? `&cursor=${encodeURIComponent(cur)}` : ''}`);
    if (!page.nextCursor) break;
    cur = page.nextCursor;
    auditCursors.push(cur!);
  }
  const words = ['Órdenes', 'Agendamientos', 'Instalaciones', 'Despachos', 'Facturación', 'totales', 'Exportar', 'detalle', '0042', 'grupo 3'];
  let k = 0;
  const rnd = <T>(a: T[]): T => a[(k = (k * 1103515245 + 12345) % 2147483648) % a.length]!;
  const scenarios: Scenario[] = [
    { name: 'cases:lista', weight: 3, path: () => '/testrail/cases?limit=100' },
    { name: 'cases:busqueda', weight: 3, path: () => `/testrail/cases?limit=100&q=${encodeURIComponent(rnd(words))}` },
    { name: 'cases:suite+automatizados', weight: 2, path: () => `/testrail/cases?limit=100&suiteId=${loadSuite.id}&automated=true` },
    { name: 'cases:seccion+descendientes', weight: 2, path: () => `/testrail/cases?limit=100&section=${rnd(sections).id}` },
    { name: 'cases:ultimo-resultado', weight: 1, path: () => '/testrail/cases?limit=100&lastResult=fallido' },
    { name: 'cases:pagina-profunda', weight: 2, path: () => `/testrail/cases?limit=100&cursor=${encodeURIComponent(rnd(caseCursors))}` },
    { name: 'tests:lista', weight: 2, path: () => '/tests?limit=100' },
    { name: 'tests:busqueda+etiqueta', weight: 2, path: () => `/tests?limit=100&tag=%40carga&q=${encodeURIComponent(rnd(words))}` },
    { name: 'tests:estado', weight: 1, path: () => '/tests?limit=100&status=aprobado&sort=-updatedAt' },
    { name: 'runs:lista', weight: 2, path: () => '/runs?limit=100' },
    { name: 'runs:filtros', weight: 1, path: () => `/runs?limit=100&status=terminada&environmentId=${envId}` },
    { name: 'schedules:lista', weight: 1, path: () => '/schedules?limit=100' },
    { name: 'audit:lista', weight: 1, path: () => '/audit-log?limit=100' },
    { name: 'audit:pagina-profunda', weight: 1, path: () => `/audit-log?limit=100&cursor=${encodeURIComponent(rnd(auditCursors))}` },
  ];
  const wheel = scenarios.flatMap((s) => Array.from({ length: s.weight }, () => s));
  const lat = new Map<string, number[]>(scenarios.map((s) => [s.name, []]));
  const errors = new Map<string, number>();
  const statusCounts = new Map<number, number>();
  const rows = new Map<string, number>();

  const host = { cpus: os.cpus().length, model: os.cpus()[0]?.model, totalMemMiB: Math.round(os.totalmem() / 1048576), platform: `${os.platform()} ${os.release()}`, node: process.version };
  const samples: any[] = [];
  let cpuPrev = os.cpus().map((c) => c.times);
  const sample = () => {
    const now = os.cpus().map((c) => c.times);
    let idle = 0;
    let total = 0;
    now.forEach((t, i) => {
      const p = cpuPrev[i]!;
      const d = { user: t.user - p.user, nice: t.nice - p.nice, sys: t.sys - p.sys, idle: t.idle - p.idle, irq: t.irq - p.irq };
      idle += d.idle;
      total += d.user + d.nice + d.sys + d.idle + d.irq;
    });
    cpuPrev = now;
    samples.push({
      t: Math.round((Date.now() - tStart) / 1000),
      hostCpuPct: total ? Math.round((1 - idle / total) * 1000) / 10 : null,
      load1: Math.round(os.loadavg()[0]! * 100) / 100,
      freeMemMiB: Math.round(os.freemem() / 1048576),
      processes: sampleProcesses(),
      pgConnections: pgConnections(),
    });
  };

  log(`plan: ${CONCURRENCY} usuarios × ${DURATION_S} s, ${scenarios.length} escenarios, páginas de 100 filas, ${API}`);
  const tStart = Date.now();
  const end = tStart + DURATION_S * 1000;
  sample();
  const sampler = setInterval(sample, 5000);
  let total = 0;
  await Promise.all(
    sessions.map(async (c, w) => {
      let i = w * 7;
      while (Date.now() < end) {
        const s = wheel[i++ % wheel.length]!;
        const r = await c.request('GET', s.path()).catch((e: Error) => ({ status: 0, ms: NaN, body: { error: e.message } }) as any);
        total++;
        statusCounts.set(r.status, (statusCounts.get(r.status) ?? 0) + 1);
        if (r.status === 200) {
          lat.get(s.name)!.push(r.ms);
          rows.set(s.name, Math.max(rows.get(s.name) ?? 0, r.body?.items?.length ?? 0));
        } else errors.set(s.name, (errors.get(s.name) ?? 0) + 1);
      }
    }),
  );
  clearInterval(sampler);
  sample();
  const elapsed = (Date.now() - tStart) / 1000;
  const all = [...lat.values()].flat().sort((a, b) => a - b);
  const perEndpoint = scenarios.map((s) => {
    const v = lat.get(s.name)!.sort((a, b) => a - b);
    return { endpoint: s.name, n: v.length, errors: errors.get(s.name) ?? 0, maxRows: rows.get(s.name) ?? 0, p50: pct(v, 50), p95: pct(v, 95), p99: pct(v, 99), max: Math.round((v.at(-1) ?? NaN) * 10) / 10 };
  });
  const maxConn = Math.max(...samples.map((s) => s.pgConnections ?? 0));
  const procMax: Record<string, { cpuMax: number; rssMaxMiB: number }> = {};
  for (const s of samples)
    for (const p of s.processes) {
      const m = (procMax[p.name] ??= { cpuMax: 0, rssMaxMiB: 0 });
      m.cpuMax = Math.max(m.cpuMax, p.cpu);
      m.rssMaxMiB = Math.max(m.rssMaxMiB, p.rssMiB);
    }
  const result = {
    plan: { users: CONCURRENCY, durationS: DURATION_S, pageSize: 100, thinkTimeMs: 0, scenarios: scenarios.map((s) => ({ name: s.name, weight: s.weight })), api: API },
    host,
    startedAt: new Date(tStart).toISOString(),
    elapsedS: Math.round(elapsed),
    requests: total,
    rps: Math.round((total / elapsed) * 10) / 10,
    statusCounts: Object.fromEntries(statusCounts),
    overall: { n: all.length, p50: pct(all, 50), p95: pct(all, 95), p99: pct(all, 99), max: Math.round((all.at(-1) ?? NaN) * 10) / 10 },
    perEndpoint,
    resources: {
      hostCpuPctAvg: Math.round((samples.reduce((a, s) => a + (s.hostCpuPct ?? 0), 0) / samples.length) * 10) / 10,
      hostCpuPctMax: Math.max(...samples.map((s) => s.hostCpuPct ?? 0)),
      load1Max: Math.max(...samples.map((s) => s.load1)),
      freeMemMiBMin: Math.min(...samples.map((s) => s.freeMemMiB)),
      processes: procMax,
      pgConnectionsMax: maxConn,
    },
    verdict: { p95UnderOneSecond: pct(all, 95) < 1000 && perEndpoint.every((e) => e.p95 < 1000), poolWithinBudget: maxConn <= 20, noErrors: [...errors.values()].reduce((a, b) => a + b, 0) === 0 },
    samples,
  };
  const json = JSON.stringify(result, null, 2);
  if (OUT) fs.writeFileSync(OUT, json);
  process.stdout.write(`${JSON.stringify({ ...result, samples: `${samples.length} muestras` }, null, 2)}\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(`[load] ERROR: ${(e as Error).message}\n`);
  process.exit(1);
});
