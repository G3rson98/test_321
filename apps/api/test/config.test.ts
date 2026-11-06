/** RNF-OPT-05 / RNF-SEG-01: configuración validada, pool total ≤ 20 y secretos solo por referencia. */
import { describe, expect, it } from 'vitest';
import { ConfigError, ENV_DOCS, EnvSchema, loadConfig } from '../src/config.js';
import { withPoolParams } from '../src/db.js';
import { REPORTS_SECURITY_HEADERS, buildReportsApp } from '../src/main.reports.js';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { controlLoops, touchHealthFile } from '../src/main.control.js';
import { poolSizeFor, resolveFileBackedEnv } from '../src/config.js';
import { ApiCEnvSchema } from '../src/modules/recordings/settings.js';

const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };

describe('config', () => {
  it('RNF-OPT-05 rechaza pools que superan el presupuesto total de 20', () => {
    expect(() =>
      loadConfig({ ...base, DATABASE_POOL_API: '15', DATABASE_POOL_CONTROL: '5', DATABASE_POOL_REPORTS: '2' }),
    ).toThrow(ConfigError);
    expect(loadConfig(base).DATABASE_POOL_API).toBe(10);
    const c = loadConfig(base);
    expect(c.DATABASE_POOL_API + c.DATABASE_POOL_CONTROL + c.DATABASE_POOL_REPORTS).toBe(19);
  });

  it('RNF-OPT-05 DATABASE_POOL_MAX sobrescribe el pool del proceso actual', () => {
    expect(poolSizeFor(loadConfig({ ...base, DATABASE_POOL_MAX: '6' }), 'api')).toBe(6);
    expect(poolSizeFor(loadConfig(base), 'control')).toBe(6);
    expect(poolSizeFor(loadConfig(base), 'reports')).toBe(3);
    expect(poolSizeFor(loadConfig({ ...base, DATABASE_POOL_MAX: '' }), 'api')).toBe(10);
    expect(() => loadConfig({ ...base, DATABASE_POOL_MAX: '21' })).toThrow(ConfigError);
  });

  it('RNF-SEG-01 DATABASE_URL_FILE / REDIS_URL_FILE (secretos montados por deploy)', () => {
    const files: Record<string, string> = {
      '/run/secrets/db': 'postgresql://u:p@db:5432/k\n',
      '/run/secrets/redis': 'redis://redis:6379/0',
    };
    const env = resolveFileBackedEnv(
      { DATABASE_URL_FILE: '/run/secrets/db', REDIS_URL_FILE: '/run/secrets/redis' },
      (p) => files[p]!,
    );
    expect(env.DATABASE_URL).toBe('postgresql://u:p@db:5432/k');
    expect(env.REDIS_URL).toBe('redis://redis:6379/0');
    expect(
      resolveFileBackedEnv({ DATABASE_URL: 'postgresql://x', DATABASE_URL_FILE: '/nope' }, () => 'otro').DATABASE_URL,
    ).toBe('postgresql://x');
    expect(() => loadConfig({ DATABASE_URL_FILE: '/ruta/inexistente/katalyst-db' })).toThrow(/DATABASE_URL_FILE/);
  });

  it('RNF-OBS-02 control actualiza HEALTH_FILE en cada ciclo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'katalyst-health-'));
    try {
      const file = join(dir, 'sub', 'alive');
      const loops = controlLoops(loadConfig({ ...base, HEALTH_FILE: file }));
      const health = loops.find((l) => l.name === 'health_file')!;
      expect(health.intervalMs).toBeLessThanOrEqual(15_000);
      const t = new Date('2026-11-06T12:00:00Z');
      await health.tick({ logger: undefined as never, now: t });
      expect(statSync(file).mtime.getTime()).toBe(t.getTime());
      touchHealthFile(file, new Date('2026-11-06T12:00:15Z'));
      expect(statSync(file).mtime.toISOString()).toBe('2026-11-06T12:00:15.000Z');
      expect(controlLoops(loadConfig(base)).some((l) => l.name === 'health_file')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('RNF-SEG-01 secretos solo como referencia válida', () => {
    expect(() => loadConfig({ ...base, TESTRAIL_API_KEY_REF: 'mi-api-key-en-claro' })).toThrow(ConfigError);
    expect(loadConfig({ ...base, TESTRAIL_API_KEY_REF: 'ssm:/katalyst/internal/testrail' }).TESTRAIL_API_KEY_REF).toBe(
      'ssm:/katalyst/internal/testrail',
    );
    expect(loadConfig({ ...base, TESTRAIL_API_KEY_REF: '' }).TESTRAIL_API_KEY_REF).toBeUndefined();
  });

  it('RNF-SEG-03 producción exige SESSION_SECRET_REF y cookies Secure', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/SESSION_SECRET_REF/);
  });

  it('ESP §13.3/§13.5 límites de ticks (planificador y watchdog ≤ 15 s, lease 75 s)', () => {
    expect(() => loadConfig({ ...base, SCHEDULER_TICK_MS: '30000' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, WATCHDOG_INTERVAL_MS: '16000' })).toThrow(ConfigError);
    const c = loadConfig(base);
    expect(c.LEASE_TTL_MS).toBe(75_000);
    expect(c.GLOBAL_BROWSER_CONCURRENCY).toBe(1);
    expect(c.SIGNED_URL_TTL_SECONDS).toBeLessThanOrEqual(300);
    expect(c.DEFAULT_TIMEZONE).toBe('America/La_Paz');
    expect(c.CORS_ALLOWED_ORIGINS).toEqual([]);
  });

  it('ENV_DOCS documenta todas las variables del esquema', () => {
    expect(Object.keys(ENV_DOCS).sort()).toEqual(Object.keys(EnvSchema.shape).sort());
    for (const [k, d] of Object.entries(ENV_DOCS)) if (k.endsWith('_REF')) expect(d.secret, k).toBe(true);
  });

  it('RNF-OPT-05 connection_limit por proceso en la URL', () => {
    const url = withPoolParams('postgresql://u:p@h:5432/db?schema=public', 4, 10);
    expect(url).toContain('connection_limit=4');
    expect(url).toContain('pool_timeout=10');
    expect(url).toContain('schema=public');
  });
});

describe('procesos auxiliares', () => {
  it('RNF-SEG-05 visor de reportes con CSP estricta y sin cookies', async () => {
    const app = buildReportsApp(loadConfig({ ...base, LOG_LEVEL: 'silent' }));
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toBe(REPORTS_SECURITY_HEADERS['content-security-policy']);
    expect(res.headers['set-cookie']).toBeUndefined();
    await app.close();
  });

  it('RNF-REN-02/RNF-CON-01 bucles de control dentro de los plazos', () => {
    const loops = controlLoops(loadConfig(base));
    const byName = Object.fromEntries(loops.map((l) => [l.name, l.intervalMs]));
    expect(byName['planificador']).toBeLessThanOrEqual(15_000);
    expect(byName['watchdog_leases']).toBeLessThanOrEqual(15_000);
    expect(byName['evaluador_umbrales']).toBe(60_000);
  });

  it('RNF-SEG-01 variables de API-C (D-031) validadas en config.ts con los mismos defaults que settings.ts', () => {
    const c = loadConfig(base);
    const apiC = ApiCEnvSchema.parse({});
    for (const k of Object.keys(ApiCEnvSchema.shape) as (keyof typeof apiC)[]) {
      expect(c[k as keyof typeof c], k).toEqual(apiC[k]);
    }
    expect(() => loadConfig({ ...base, AI_EFFORT: 'max' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, RECORDING_TESTS_DIR: '../fuera' })).toThrow(ConfigError);
    expect(loadConfig({ ...base, ARTIFACT_FS_SIGNING_KEY_REF: 'env:KATALYST_SECRET__X' }).ARTIFACT_FS_SIGNING_KEY_REF).toBe('env:KATALYST_SECRET__X');
    expect(() => loadConfig({ ...base, ARTIFACT_FS_SIGNING_KEY_REF: 'valor-en-claro' })).toThrow(ConfigError);
  });
});
