/**
 * Semilla del stack LOCAL (scripts/dev-stack.sh debe estar corriendo). Idempotente.
 *   1. Administrador inicial (contraseña por STDIN; nunca como argumento) vía `bootstrap-admin --password-stdin`.
 *   2. Login en la API, conexión TestRail FALSA (`env:KATALYST_SECRET__TESTRAIL_FAKE`) y sincronización.
 *   3. Ambiente "staging-local" (no producción) apuntando a la fixture local + usuario de prueba de solo lectura.
 *   4. Refresco del catálogo (`POST /tests/refresh` → supervisor `catalog-listing` → revisión `completa`).
 * Uso: node scripts/seed-dev.ts < archivo-con-clave-admin
 *      Variables: KATALYST_STACK_DIR, SEED_ADMIN_EMAIL (default admin@katalyst.example.test), SEED_ENV_NAME.
 * Imprime un JSON con los IDs creados (sin secretos).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { KatalystClient, readEnvFile, readStdin, stackDir, waitFor } from './lib/katalyst-client.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const STACK = stackDir();
const stackEnv = { ...readEnvFile(path.join(STACK, 'stack.env')), ...readEnvFile(path.join(STACK, 'secrets.env')) };
if (!stackEnv.DATABASE_URL) throw new Error(`No se encontró ${STACK}/stack.env: ejecuta scripts/dev-stack.sh start primero`);
const API = process.env.KATALYST_DEV_API_URL ?? stackEnv.KATALYST_DEV_API_URL ?? 'http://127.0.0.1:3000';
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@katalyst.example.test';
const ENV_NAME = process.env.SEED_ENV_NAME ?? 'staging-local';
const TEST_USER = process.env.FAKE_DELTAX_USER ?? 'qa.local@example.test';
const log = (m: string) => process.stderr.write(`[seed-dev] ${m}\n`);

function bootstrapAdmin(password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--conditions=source', '--import', 'tsx', 'src/cli/bootstrap-admin.ts', '--email', ADMIN_EMAIL, '--name', 'Administrador local', '--password-stdin'],
      { cwd: path.join(ROOT, 'apps/api'), env: { ...process.env, ...stackEnv }, stdio: ['pipe', 'inherit', 'inherit'] },
    );
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`bootstrap-admin terminó con código ${code}`))));
    child.stdin.end(`${password}\n`);
  });
}

async function main(): Promise<void> {
  const password = await readStdin();
  if (password.length < 12) throw new Error('La contraseña del administrador debe tener al menos 12 caracteres');
  await bootstrapAdmin(password);

  const c = new KatalystClient(API);
  await c.login(ADMIN_EMAIL, password);
  log(`sesión iniciada como ${ADMIN_EMAIL}`);

  // --- TestRail falso ---
  const current = await c.request('GET', '/testrail/connection');
  const conn = {
    baseUrl: stackEnv.FAKE_TESTRAIL_URL ?? 'http://127.0.0.1:4010',
    username: 'svc-katalyst@example.test',
    secretRef: 'env:KATALYST_SECRET__TESTRAIL_FAKE',
    projectExternalId: 1,
    suiteExternalIds: [1, 2],
    enabled: true,
    ...(current.status === 200 && current.body?.version ? { version: current.body.version } : {}),
  };
  await c.ok('PUT', '/testrail/connection', conn, [200, 201]);
  const test = await c.ok('POST', '/testrail/connection/test', {}, [200]);
  log(`conexión TestRail falsa guardada (prueba: ${JSON.stringify(test).slice(0, 160)})`);
  const sync = await c.ok('POST', '/testrail/sync', {}, [202]);
  const syncDone = await waitFor(async () => {
    const r = await c.ok('GET', `/testrail/sync-runs/${sync.id}`);
    return r.status === 'en_curso' ? null : r;
  }, 120_000, 'sincronización TestRail');
  if (syncDone.status !== 'exitosa') throw new Error(`sync TestRail ${syncDone.status}: ${JSON.stringify(syncDone).slice(0, 400)}`);
  log(`sync TestRail ${syncDone.status}: ${JSON.stringify(syncDone.counts ?? syncDone.stats ?? {}).slice(0, 200)}`);

  // --- Ambiente y usuario de prueba ---
  const envs = await c.all('/environments');
  let env = envs.find((e: any) => e.name === ENV_NAME);
  if (!env) {
    env = await c.ok(
      'POST',
      '/environments',
      {
        name: ENV_NAME,
        appUrl: stackEnv.FAKE_DELTAX_URL ?? 'http://127.0.0.1:4020',
        apiUrl: stackEnv.FAKE_DELTAX_URL ?? 'http://127.0.0.1:4020',
        isProduction: false,
        maxConcurrency: 1,
        enabled: true,
        recordingAllowed: false,
        allowedHosts: ['127.0.0.1'],
      },
      [201],
    );
    log(`ambiente ${ENV_NAME} creado`);
  }
  const users = await c.all(`/environments/${env.id}/users`);
  let user = users.find((u: any) => u.username === TEST_USER);
  if (!user) {
    user = await c.ok(
      'POST',
      `/environments/${env.id}/users`,
      { label: 'qa-local', username: TEST_USER, secretRef: 'env:KATALYST_SECRET__QA_LOCAL', readOnly: true, allowsConcurrency: false },
      [201],
    );
    log('usuario de prueba creado');
  }

  // --- Catálogo (listado aislado por el supervisor) ---
  const rev = await c.ok('POST', '/tests/refresh', {}, [202]);
  const revDone = await waitFor(async () => {
    const r = await c.ok('GET', `/catalog/revisions/${rev.id}`);
    return r.status === 'en_curso' ? null : r;
  }, 240_000, 'revisión del catálogo');
  if (revDone.status !== 'completa') throw new Error(`revisión del catálogo ${revDone.status}: ${JSON.stringify(revDone).slice(0, 600)}`);
  const tests = await c.all('/tests');
  log(`catálogo: revisión ${revDone.status}, ${tests.length} tests (commit ${String(revDone.gitCommit).slice(0, 12)})`);

  process.stdout.write(
    `${JSON.stringify({ adminEmail: ADMIN_EMAIL, environmentId: env.id, testUserId: user.id, syncRunId: sync.id, catalogRevisionId: rev.id, gitCommit: revDone.gitCommit, tests: tests.length }, null, 2)}\n`,
  );
}

main().catch((e: unknown) => {
  process.stderr.write(`[seed-dev] ERROR: ${(e as Error).message}\n`);
  process.exit(1);
});
