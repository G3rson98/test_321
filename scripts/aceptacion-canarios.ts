/* eslint-disable @typescript-eslint/no-explicit-any -- script de aceptación: respuestas JSON sin tipar */
/**
 * Ensayo de aceptación de CANARIOS (ESP §13.7, RNF-SEG-01/02) sobre el stack local (scripts/dev-stack.sh).
 * La fixture local (scripts/fake-deltax.mjs con FAKE_DELTAX_CANARIES) expone un token, una cookie, un dato personal
 * y un secreto `KATALYST_CANARY_*` en DOM, URL, respuestas de red, encabezados, localStorage y consola; el test
 * C900009 los lee y FALLA con un mensaje que los incluye. Este script:
 *   1. crea (si falta) el ambiente `canario-local` con política de evidencia AMPLIA (reporte, log, traza, captura),
 *   2. lanza una corrida C900009 + C900006 publicando al TestRail falso,
 *   3. busca cada canario (texto plano, URL-encoded y base64) y las credenciales de desarrollo en: volcado completo
 *      de la BD (`pg_dump --data-only`: run_result, test_attempt, artifact, outbox_delivery, event_log, audit_log…),
 *      logs de los procesos, almacén de artefactos (JSON/HTML/ZIP con blobs embebidos y trazas descomprimidas),
 *      adjuntos/resultados recibidos por el TestRail falso y respuestas de la API.
 * Uso: FAKE_DELTAX_CANARIES='{"token":…}' (el mismo valor con el que arrancó fake-deltax) \
 *      node scripts/aceptacion-canarios.ts < archivo-con-clave-admin
 * Imprime un JSON con conteos por ubicación (sin los valores) y sale ≠ 0 si aparece algún canario.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KatalystClient, readEnvFile, readStdin, stackDir, waitFor } from './lib/katalyst-client.ts';

const STACK = stackDir();
const stackEnv = readEnvFile(path.join(STACK, 'stack.env'));
const secrets = readEnvFile(path.join(STACK, 'secrets.env'));
const API = stackEnv.KATALYST_DEV_API_URL ?? 'http://127.0.0.1:3000';
const TR = stackEnv.FAKE_TESTRAIL_URL ?? 'http://127.0.0.1:4010';
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@katalyst.example.test';
const CANARIES = JSON.parse(process.env.FAKE_DELTAX_CANARIES ?? 'null') as Record<string, string> | null;
if (!CANARIES) throw new Error('Define FAKE_DELTAX_CANARIES (JSON {token, cookie, personal, secret}) igual que en fake-deltax');
const log = (m: string) => process.stderr.write(`[canarios] ${m}\n`);

/** Valores buscados: canarios sembrados + credenciales de desarrollo del stack (no deben filtrarse). */
const NEEDLES: Record<string, string> = {
  'canario.token': CANARIES.token!,
  'canario.cookie': CANARIES.cookie!,
  'canario.personal': CANARIES.personal!,
  'canario.secreto': CANARIES.secret!,
  'contraseña usuario de prueba': secrets.KATALYST_SECRET__QA_LOCAL!,
  'API key TestRail': secrets.KATALYST_SECRET__TESTRAIL_FAKE!,
  'token supervisor': fs.readFileSync(path.join(STACK, 'supervisor.token'), 'utf8').trim(),
  'secreto de sesión': secrets.KATALYST_SECRET__SESSION!,
};
function variants(v: string): string[] {
  const out = new Set([v, encodeURIComponent(v)]);
  // base64 en las tres alineaciones (núcleo estable del codificado).
  // El tramo central de base64('x'×p + v) solo depende de v para esa alineación; p ∈ {0,1,2} cubre todas.
  for (let pad = 0; pad < 3; pad++) {
    const b = Buffer.from('x'.repeat(pad) + v).toString('base64');
    out.add(b.slice(4, b.length - 4));
  }
  return [...out].filter((x) => x.length >= 8);
}
const NEEDLE_VARIANTS = Object.entries(NEEDLES).map(([name, v]) => ({ name, vs: variants(v) }));
const GENERIC = /KATALYST_CANARY_[A-Za-z0-9_-]+/g;

const hits: { where: string; needle: string }[] = [];
const scanned: Record<string, number> = {};
function scanText(where: string, text: string, group: string): void {
  scanned[group] = (scanned[group] ?? 0) + 1;
  for (const n of NEEDLE_VARIANTS) if (n.vs.some((v) => text.includes(v))) hits.push({ where, needle: n.name });
  const g = text.match(GENERIC);
  if (g) hits.push({ where, needle: `patrón KATALYST_CANARY_* ×${g.length}` });
}

function isZip(b: Buffer): boolean {
  return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}
function scanBuffer(where: string, buf: Buffer, group: string, depth = 0): void {
  scanText(where, buf.toString('latin1'), group);
  if (isZip(buf) && depth < 4) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcan-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.zip'), buf);
      execFileSync('unzip', ['-qq', '-o', path.join(dir, 'a.zip'), '-d', path.join(dir, 'x')], { stdio: 'ignore' });
      for (const f of walk(path.join(dir, 'x'))) scanBuffer(`${where}!${path.relative(path.join(dir, 'x'), f)}`, fs.readFileSync(f), group, depth + 1);
    } catch {
      hits.push({ where, needle: 'ZIP no inspeccionable' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  // Blobs base64 embebidos (reporte HTML de Playwright).
  const text = buf.toString('latin1');
  for (const m of text.matchAll(/data:([a-z/+-]+);base64,([A-Za-z0-9+/=]{40,})/g)) {
    scanBuffer(`${where}#blob(${m[1]})`, Buffer.from(m[2]!, 'base64'), group, depth + 1);
  }
}
function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

async function main(): Promise<void> {
  const password = await readStdin();
  const c = new KatalystClient(API);
  await c.login(ADMIN_EMAIL, password);

  const envs = await c.all('/environments');
  let env = envs.find((e: any) => e.name === 'canario-local');
  if (!env) {
    env = await c.ok('POST', '/environments', {
      name: 'canario-local',
      appUrl: stackEnv.FAKE_DELTAX_URL,
      apiUrl: stackEnv.FAKE_DELTAX_URL,
      isProduction: false,
      maxConcurrency: 1,
      allowedHosts: ['127.0.0.1'],
      artifactPolicy: { enabledKinds: ['reporte', 'log', 'traza', 'captura'], screenshotsOnFailureOnly: true, traceOnFailureOnly: true, videoOnFailureOnly: true },
    }, [201]);
    await c.ok('POST', `/environments/${env.id}/users`, { label: 'qa-canario', username: process.env.FAKE_DELTAX_USER ?? 'qa.local@example.test', secretRef: 'env:KATALYST_SECRET__QA_LOCAL', readOnly: true }, [201]);
    log('ambiente canario-local creado (política: reporte, log, traza, captura)');
  }
  const cases = await c.all('/testrail/cases?q=C90000');
  const all = cases.length >= 2 ? cases : await c.all('/testrail/cases');
  const id = (n: number) => all.find((x: any) => x.trCaseId === n)?.id;
  const run = await c.ok('POST', '/runs', { caseIds: [id(900009), id(900006)], environmentId: env.id, retries: 0, testrail: { mode: 'nueva' } }, [201], { 'idempotency-key': `canarios-${randomUUID()}` });
  log(`corrida ${run.id} creada`);
  const done = await waitFor(async () => {
    const r = await c.ok('GET', `/runs/${run.id}`);
    return ['terminada', 'cancelada', 'interrumpida'].includes(r.status) ? r : null;
  }, 300_000, 'corrida terminal', 1000);
  const synced = await waitFor(async () => {
    const r = await c.ok('GET', `/runs/${run.id}`);
    return ['sincronizada', 'requiere_intervencion'].includes(r.syncStatus) ? r : null;
  }, 180_000, 'publicación TestRail', 1000);
  // Margen para entregas de adjuntos (seq 1000) y cierre (seq 2000) del outbox.
  await new Promise((r) => setTimeout(r, 8000));
  const results = await c.all(`/runs/${run.id}/results`);
  const artifacts = await c.all(`/runs/${run.id}/artifacts`);
  const attempts: any[] = [];
  for (const r of results) attempts.push(...((await c.ok('GET', `/runs/${run.id}/results/${r.id}/attempts`)).items ?? []));
  const summary = {
    runId: run.id,
    status: done.status,
    outcome: done.outcome,
    syncStatus: synced.syncStatus,
    results: results.map((r: any) => ({ title: r.title.slice(0, 7), status: r.status })),
    attempts: attempts.map((a: any) => ({ status: a.status, errorCategory: a.errorCategory, errorExcerpt: String(a.error ?? '').slice(0, 220) })),
    artifacts: artifacts.map((a: any) => ({ kind: a.kind, contentType: a.contentType, sizeBytes: a.sizeBytes, sanitizationStatus: a.sanitizationStatus, reason: a.sanitizationReason })),
  };
  log(`corrida ${done.status}/${done.outcome}, sync ${synced.syncStatus}, ${artifacts.length} artefactos`);

  // --- 1) API: respuestas de los recursos de la corrida ---
  const apiPaths = [`/runs/${run.id}`, `/runs/${run.id}/results?limit=100`, `/runs/${run.id}/case-results?limit=100`, `/runs/${run.id}/targets`, `/runs/${run.id}/artifacts?limit=100`, '/audit-log?limit=200', '/integrations/testrail/deliveries?limit=100', ...results.map((r: any) => `/runs/${run.id}/results/${r.id}/attempts`)];
  for (const p of apiPaths) {
    const r = await c.request('GET', p);
    scanText(`API GET ${p} (HTTP ${r.status})`, JSON.stringify(r.body), 'api');
  }
  // SSE acotado de la corrida (flujo abierto): se leen los eventos durante 4 s.
  {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 4000);
    let text = '';
    try {
      const res = await fetch(`${API}/api/v1/runs/${run.id}/events`, { headers: { cookie: c.cookie, accept: 'text/event-stream' }, signal: ac.signal });
      const reader = res.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += Buffer.from(value).toString('utf8');
      }
    } catch {
      /* fin por tiempo */
    } finally {
      clearTimeout(timer);
    }
    scanText(`API SSE /runs/${run.id}/events (${text.length} B)`, text, 'api');
  }
  // Descarga de cada artefacto por su URL firmada (lo que vería un usuario).
  for (const a of artifacts) {
    if (a.sanitizationStatus !== 'sanitizado') continue;
    const link = await c.request('GET', `/runs/${run.id}/artifacts/${a.id}`);
    if (link.status !== 200) continue;
    const res = await fetch(link.body.url);
    scanBuffer(`descarga artefacto ${a.kind} ${a.contentType}`, Buffer.from(await res.arrayBuffer()), 'descargas');
  }

  // --- 2) BD completa ---
  const dbUrl = stackEnv.DATABASE_URL!;
  const dump = execFileSync('pg_dump', ['--data-only', '--no-owner', dbUrl], { maxBuffer: 1024 * 1024 * 1024 }).toString('utf8');
  scanText('BD pg_dump --data-only (todas las tablas)', dump, 'bd');
  const tables = ['run_result', 'test_attempt', 'artifact', 'outbox_delivery', 'event_log', 'audit_log', 'case_result', 'run'];
  const perTable: Record<string, number> = {};
  for (const t of tables) {
    perTable[t] = Number(execFileSync('psql', [dbUrl, '-Atc', `select count(*) from ${t}`]).toString().trim());
  }

  // --- 3) Logs de los procesos ---
  for (const f of walk(path.join(STACK, 'logs'))) if (!/fake-/.test(f)) scanText(`log ${path.basename(f)}`, fs.readFileSync(f, 'utf8'), 'logs');

  // --- 4) Almacén de artefactos (fs) ---
  for (const f of walk(path.join(STACK, 'artifacts', 'runs', run.id))) scanBuffer(`almacén ${path.basename(f)}`, fs.readFileSync(f), 'almacen');

  // --- 5) TestRail falso: resultados y adjuntos recibidos ---
  const tr = await (await fetch(`${TR}/_fake/state`)).json();
  scanText('TestRail falso: runs/tests/resultados', JSON.stringify({ runs: tr.runs, tests: tr.tests, results: tr.results }), 'testrail');
  for (const f of walk(path.join(STACK, 'fake-testrail', 'attachments'))) scanBuffer(`TestRail adjunto ${path.basename(f)}`, fs.readFileSync(f), 'testrail');

  // --- 6) Restos temporales del runner (secretos montados / storageState) ---
  const leftovers = walk(path.join(STACK, 'runner', 'shards')).concat(walk(path.join(STACK, 'runner', 'data', 'runs')));

  const out = { summary, scannedLocations: scanned, rowCounts: perTable, trAttachments: walk(path.join(STACK, 'fake-testrail', 'attachments')).length, runnerLeftovers: leftovers.length, hits };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (hits.length || leftovers.length) process.exit(2);
}

main().catch((e: unknown) => {
  process.stderr.write(`[canarios] ERROR: ${(e as Error).message}\n`);
  process.exit(1);
});
