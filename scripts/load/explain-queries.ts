/* eslint-disable @typescript-eslint/no-explicit-any -- script de aceptación: respuestas JSON sin tipar */
/**
 * RNF-REN-01 / ESP §17.4–17.5: consultas por solicitud (detección de N+1) y planes EXPLAIN de las APIs de listado.
 * Construye la API EN PROCESO (`buildApp`) con un PrismaClient instrumentado (eventos `query`), ejecuta cada
 * listado con `limit=10` y `limit=100` y compara el número de consultas SQL: si crece con el tamaño de página hay N+1.
 * Luego ejecuta `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` de cada SELECT capturado (parámetros sustituidos como
 * literales; solo lectura) e informa nodos, índices usados, Seq Scan sobre tablas grandes y tiempo.
 *
 * Uso (desde la raíz): KATALYST_STACK_DIR=… node --conditions=source --import ./apps/api/node_modules/tsx/dist/esm/index.mjs \
 *        scripts/load/explain-queries.ts [--out archivo.json]
 *   (o `pnpm load:explain`). Usa DATABASE_URL/REDIS_URL de stack.env (BD con los datos de seed-5000.ts).
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readEnvFile, stackDir } from '../lib/katalyst-client.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const API = path.join(ROOT, 'apps/api');
const stackEnv = { ...readEnvFile(path.join(stackDir(), 'stack.env')), ...readEnvFile(path.join(stackDir(), 'secrets.env')) };
Object.assign(process.env, stackEnv, { LOG_LEVEL: 'warn', RATE_LIMIT_MAX: '100000' });
const OUT = (() => {
  const i = process.argv.indexOf('--out');
  return i >= 0 ? process.argv[i + 1]! : '';
})();
const BIG_TABLES = new Set(['testrail_case', 'automated_test', 'test_case_link', 'run', 'run_result', 'case_result', 'test_attempt', 'audit_log', 'schedule']);

const req = createRequire(path.join(API, 'package.json'));
const { PrismaClient } = req('@prisma/client') as { PrismaClient: new (o?: object) => any };
const imp = (rel: string) => import(pathToFileURL(path.join(API, rel)).href);

function literal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (Array.isArray(v)) return `ARRAY[${v.map(literal).join(',')}]`;
  return `'${String(v).replace(/'/g, "''")}'`;
}
function inline(sql: string, params: unknown[]): string {
  return sql.replace(/\$(\d+)/g, (_m, n: string) => literal(params[Number(n) - 1]));
}
function walkPlan(node: any, acc: { nodes: Set<string>; indexes: Set<string>; seqBig: Set<string> }): void {
  acc.nodes.add(node['Node Type']);
  if (node['Index Name']) acc.indexes.add(node['Index Name']);
  if (node['Node Type'] === 'Seq Scan' && BIG_TABLES.has(node['Relation Name'])) acc.seqBig.add(node['Relation Name']);
  for (const child of node.Plans ?? []) walkPlan(child, acc);
}

async function main(): Promise<void> {
  const { loadConfig } = await imp('src/config.ts');
  const { buildApp } = await imp('src/app.ts');
  const { createLogger } = await imp('src/logger.ts');
  const { createRedis } = await imp('src/redis.ts');
  const config = loadConfig();
  const prisma = new PrismaClient({ datasources: { db: { url: config.DATABASE_URL } }, log: [{ emit: 'event', level: 'query' }] });
  let captured: { query: string; params: unknown[]; ms: number }[] = [];
  prisma.$on('query', (e: { query: string; params: string; duration: number }) => {
    let params: unknown[];
    try {
      params = JSON.parse(e.params);
    } catch {
      params = [];
    }
    captured.push({ query: e.query, params, ms: e.duration });
  });
  const redis = createRedis(config.REDIS_URL);
  const app = await buildApp({ config, logger: createLogger({ level: 'warn', service: 'explain' }), prisma, redis });
  const auth = { authorization: '' };
  // Sesión: token API efímero del administrador (Bearer) creado directamente, sin contraseña.
  const { generateOpaqueToken, hashToken } = await imp('src/lib/crypto-tokens.ts');
  const admin = await prisma.panelUser.findFirst({ where: { role: 'admin' }, orderBy: { createdAt: 'asc' } });
  const { PERMISSIONS } = await import(pathToFileURL(path.join(ROOT, 'packages/shared/src/rbac/permissions.ts')).href);
  const tok = generateOpaqueToken('apiToken');
  const cred = await prisma.apiCredential.create({
    data: { kind: 'token_api', name: 'explain-queries (efímero)', hint: tok.slice(-4), tokenHash: hashToken(tok), scopes: [...PERMISSIONS], principalId: admin.id, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  auth.authorization = `Bearer ${tok}`;

  const suite = await prisma.testRailSuite.findFirst({ where: { name: { contains: 'Carga' } } });
  const section = await prisma.testRailSection.findFirst({ where: { suiteId: suite?.id, depth: 0 } });
  const env = await prisma.environment.findFirst();
  const endpoints: [string, string][] = [
    ['cases:lista', '/api/v1/testrail/cases?limit=__L__'],
    ['cases:busqueda', '/api/v1/testrail/cases?limit=__L__&q=Agendamientos'],
    ['cases:suite+automatizados', `/api/v1/testrail/cases?limit=__L__&suiteId=${suite?.id}&automated=true`],
    ['cases:seccion+descendientes', `/api/v1/testrail/cases?limit=__L__&section=${section?.id}`],
    ['cases:ultimo-resultado', '/api/v1/testrail/cases?limit=__L__&lastResult=fallido'],
    ['tests:lista', '/api/v1/tests?limit=__L__'],
    ['tests:busqueda+etiqueta', '/api/v1/tests?limit=__L__&tag=%40carga&q=Despachos'],
    ['runs:lista', '/api/v1/runs?limit=__L__'],
    ['runs:filtros', `/api/v1/runs?limit=__L__&status=terminada&environmentId=${env?.id}`],
    ['schedules:lista', '/api/v1/schedules?limit=__L__'],
    ['audit:lista', '/api/v1/audit-log?limit=__L__'],
  ];
  const report: any[] = [];
  try {
    for (const [name, url] of endpoints) {
      const counts: Record<string, number> = {};
      let last: typeof captured = [];
      for (const l of [10, 100]) {
        await app.inject({ method: 'GET', url: url.replace('__L__', String(l)), headers: auth }); // calentamiento
        captured = [];
        const res = await app.inject({ method: 'GET', url: url.replace('__L__', String(l)), headers: auth });
        if (res.statusCode !== 200) throw new Error(`${name} → HTTP ${res.statusCode}: ${res.body.slice(0, 300)}`);
        // Solo SELECT de datos (excluye autenticación y el UPDATE de lastUsedAt, que es asíncrono y limitado).
        counts[`limit${l}`] = captured.filter((q) => /^\s*(SELECT|WITH)/i.test(q.query) && !/"api_credential"|"panel_session"|"panel_user"|^\s*SELECT 1/.test(q.query)).length;
        counts[`rows${l}`] = (res.json() as { items: unknown[] }).items.length;
        last = captured;
      }
      const plans: any[] = [];
      for (const q of last) {
        if (!/^\s*(SELECT|WITH)/i.test(q.query) || /pg_|"api_credential"|"panel_user"|"panel_session"/.test(q.query)) continue;
        const rows = await prisma.$queryRawUnsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${inline(q.query, q.params)}`);
        const plan = (rows as any[])[0]['QUERY PLAN'][0];
        const acc = { nodes: new Set<string>(), indexes: new Set<string>(), seqBig: new Set<string>() };
        walkPlan(plan.Plan, acc);
        const tables = [...new Set([...q.query.matchAll(/"public"\."([a-z_]+)"/g)].map((m) => m[1]!))];
        plans.push({ tables, execMs: Math.round(plan['Execution Time'] * 100) / 100, indexes: [...acc.indexes], seqScanOnBigTables: [...acc.seqBig], nodes: [...acc.nodes] });
      }
      const nPlusOne = counts.limit100! > counts.limit10!;
      report.push({ endpoint: name, queries: counts, nPlusOne, plans });
      process.stderr.write(`[explain] ${name}: consultas limit10=${counts.limit10} limit100=${counts.limit100} ${nPlusOne ? 'N+1!' : 'sin N+1'}; seq scans: ${[...new Set(plans.flatMap((p) => p.seqScanOnBigTables))].join(',') || 'ninguno'}; máx ${Math.max(...plans.map((p) => p.execMs), 0)} ms\n`);
    }
  } finally {
    await prisma.apiCredential.delete({ where: { id: cred.id } }).catch(() => undefined);
    await app.close();
    await prisma.$disconnect();
    redis.disconnect();
  }
  const json = JSON.stringify(report, null, 2);
  if (OUT) fs.writeFileSync(OUT, json);
  process.stdout.write(`${json}\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(`[explain] ERROR: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
