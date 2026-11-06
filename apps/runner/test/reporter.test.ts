/**
 * Reporter de Katalyst + ResultTracker con resultados simulados de Playwright:
 * pasado, fallido, inestable tras retry, timeout, skip autorizado; mapeo por `katalyst.stableKey` (no título).
 * RF-CAT-05, RF-EJE-05, RF-EJE-08, RF-RES-01, RNF-CON-03.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CHROMIUM_NO_THROTTLE_FLAGS } from '@katalyst/shared';
import { describe, expect, it } from 'vitest';
import { ResultTracker } from '../src/executor/result-tracker.js';
import KatalystReporter from '../src/reporter/katalyst-reporter.js';
import type { ReporterMessage, ReporterPlan } from '../src/reporter/protocol.js';
import { assignedTest } from './helpers/assignment.js';
import { FakeWorkerApi } from './helpers/fake-api.js';
import { silentLogger } from './helpers/logger.js';

const K = {
  pass: randomUUID(),
  fail: randomUUID(),
  flaky: randomUUID(),
  timeout: randomUUID(),
  skip: randomUUID(),
  other: randomUUID(),
};

function project(name: string, deps: string[] = [], args: string[] = [...CHROMIUM_NO_THROTTLE_FLAGS]) {
  return { name, dependencies: deps, use: { launchOptions: { args } } };
}

type FakeTest = ReturnType<typeof fakeTest>;
function fakeTest(title: string, stableKey: string | null, proj: ReturnType<typeof project>, retries = 0) {
  return {
    id: `id-${title.replace(/\W+/g, '')}`,
    title,
    annotations: stableKey ? [{ type: 'katalyst.stableKey', description: stableKey }] : [],
    location: { file: `/repo/tests/${title}.spec.ts`, line: 3, column: 1 },
    retries,
    timeout: 120_000,
    expectedStatus: 'passed' as const,
    parent: { project: () => proj },
  };
}

function result(retry: number, status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted', errors: Array<{ message: string }> = [], extra: Record<string, unknown> = {}) {
  return { retry, status, startTime: new Date('2026-11-06T12:00:00Z'), duration: 1234, errors, attachments: [], annotations: [], ...extra };
}

describe('KatalystReporter (RF-CAT-05: identidad por katalyst.stableKey)', () => {
  it('preprocess excluye tests no asignados, sin anotación y duplicados; informa faltantes y flags', async () => {
    const setup = project('setup');
    const env = project('staging', ['setup']);
    const tests = [
      fakeTest('setup-login', null, setup),
      fakeTest('C1 pasa', K.pass, env),
      fakeTest('C2 renombrado pero misma clave', K.fail, env),
      fakeTest('sin anotacion', null, env),
      fakeTest('no asignado', K.other, env),
      fakeTest('dup a', K.flaky, env),
      fakeTest('dup b', K.flaky, env),
    ];
    const msgs: ReporterMessage[] = [];
    const plan: ReporterPlan = {
      schemaVersion: 1,
      projectName: 'staging',
      tests: [K.pass, K.fail, K.flaky, K.timeout].map((stableKey) => ({ stableKey, parameterKey: 'default' })),
      requiredChromiumFlags: [...CHROMIUM_NO_THROTTLE_FLAGS],
    };
    const reporter = new KatalystReporter({ sink: (m) => void msgs.push(m), plan });
    const excluded: string[] = [];
    await reporter.preprocess({
      config: { projects: [setup, env] } as never,
      suite: { allTests: () => tests } as never,
      testRun: { exclude: (t: FakeTest) => excluded.push(t.title) } as never,
    });
    expect(excluded.sort()).toEqual(['dup a', 'dup b', 'no asignado', 'sin anotacion']);
    const planMsg = msgs.find((m) => m.type === 'plan');
    expect(planMsg).toMatchObject({ type: 'plan', missingChromiumFlags: [] });
    if (planMsg?.type !== 'plan') throw new Error('sin plan');
    expect(planMsg.found.map((f) => f.title).sort()).toEqual(['C1 pasa', 'C2 renombrado pero misma clave']);
    expect(planMsg.missing).toEqual([`${K.timeout}::default`]);
    expect(planMsg.duplicates).toEqual([`${K.flaky}::default`]);
    expect(planMsg.unmapped).toHaveLength(1);
  });

  it('RNF-CON-03: detecta flags de Chromium ausentes en el project', async () => {
    const env = project('staging', [], ['--headless']);
    const msgs: ReporterMessage[] = [];
    const reporter = new KatalystReporter({
      sink: (m) => void msgs.push(m),
      plan: { schemaVersion: 1, projectName: null, tests: [{ stableKey: K.pass, parameterKey: 'default' }], requiredChromiumFlags: [...CHROMIUM_NO_THROTTLE_FLAGS] },
    });
    await reporter.preprocess({ config: { projects: [env] } as never, suite: { allTests: () => [fakeTest('a', K.pass, env)] } as never, testRun: { exclude: () => undefined } });
    const p = msgs.find((m) => m.type === 'plan');
    expect(p?.type === 'plan' && p.missingChromiumFlags.length).toBe(3);
  });
});

describe('ResultTracker con eventos simulados (RF-EJE-05, RF-EJE-08, RF-RES-01)', () => {
  async function run(scenario: (r: KatalystReporter, env: ReturnType<typeof project>, setup: ReturnType<typeof project>) => void) {
    const api = new FakeWorkerApi();
    const tests = [
      assignedTest(K.pass),
      assignedTest(K.fail),
      assignedTest(K.flaky, { retries: 1 }),
      assignedTest(K.timeout),
      assignedTest(K.skip),
    ];
    const gateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kgate-'));
    const stops: string[] = [];
    const tracker = new ResultTracker({
      api,
      leaseId: randomUUID(),
      generation: 1,
      tests,
      logger: silentLogger(),
      knownSecrets: () => ['SuperSecreta123'],
      now: () => new Date('2026-11-06T12:00:05Z'),
      gateDir,
      requestStop: (c) => stops.push(c),
    });
    let chain = Promise.resolve();
    const setup = project('setup');
    const env = project('staging', ['setup']);
    const reporter = new KatalystReporter({ sink: (m) => void (chain = chain.then(() => tracker.handle(m))), plan: null });
    reporter.onBegin({ projects: [setup, env] } as never);
    scenario(reporter, env, setup);
    await reporter.onEnd({ status: 'passed' } as never);
    await chain;
    const byResult = (key: string) => {
      const id = tests.find((t) => t.stableKey === key)!.runResultId;
      return (api.ops('result') as Array<Record<string, unknown>>).filter((r) => r.runResultId === id);
    };
    return { api, tracker, byResult, gateDir, stops, tests };
  }

  it('pasado, fallido (sanitizado), inestable tras retry, timeout y skip autorizado', async () => {
    const { byResult, api, gateDir, stops } = await run((r, env) => {
      const pass = fakeTest('C1', K.pass, env);
      r.onTestBegin(pass as never, result(0, 'passed') as never);
      r.onTestEnd(pass as never, result(0, 'passed') as never);

      const fail = fakeTest('C2', K.fail, env);
      r.onTestBegin(fail as never, result(0, 'failed') as never);
      r.onTestEnd(
        fail as never,
        result(0, 'failed', [{ message: 'expect(received).toBe(expected) clave SuperSecreta123 token=abcdef123456 KATALYST_CANARY_TOKEN_x1' }]) as never,
      );

      const flaky = fakeTest('C3', K.flaky, env, 1);
      r.onTestBegin(flaky as never, result(0, 'failed') as never);
      r.onTestEnd(flaky as never, result(0, 'failed', [{ message: 'Error: expect(locator).toBeVisible() failed' }]) as never);
      r.onTestBegin(flaky as never, result(1, 'passed') as never);
      r.onTestEnd(flaky as never, result(1, 'passed') as never);

      const to = fakeTest('C4', K.timeout, env);
      r.onTestBegin(to as never, result(0, 'timedOut') as never);
      r.onTestEnd(to as never, result(0, 'timedOut', [{ message: 'Test timeout of 120000ms exceeded.' }]) as never);

      const skip = fakeTest('C5', K.skip, env);
      r.onTestBegin(skip as never, result(0, 'skipped') as never);
      r.onTestEnd(
        skip as never,
        result(0, 'skipped', [], { annotations: [{ type: 'skip', description: 'dxmon_no_disponible: scripts legados ausentes' }] }) as never,
      );
    });
    expect(stops).toEqual([]);
    expect(byResult(K.pass)).toEqual([expect.objectContaining({ attemptNo: 1, attemptStatus: 'pasado', final: true, finalStatus: 'pasado' })]);

    const [fail] = byResult(K.fail);
    expect(fail).toMatchObject({ attemptStatus: 'fallido', errorCategory: 'asercion', final: true, finalStatus: 'fallido' });
    expect(String(fail!.error)).not.toContain('SuperSecreta123');
    expect(String(fail!.error)).not.toContain('KATALYST_CANARY');
    expect(String(fail!.error)).not.toContain('abcdef123456');

    const flaky = byResult(K.flaky);
    expect(flaky).toEqual([
      expect.objectContaining({ attemptNo: 1, attemptStatus: 'fallido', final: false }),
      expect.objectContaining({ attemptNo: 2, attemptStatus: 'pasado', final: true, finalStatus: 'inestable' }),
    ]);
    const attempts = api.ops('attempt') as Array<{ runResultId: string; kind: string; attemptNo: number }>;
    expect(attempts.filter((a) => a.kind === 'retry')).toHaveLength(1);

    expect(byResult(K.timeout)).toEqual([
      expect.objectContaining({ attemptStatus: 'fallido', errorCategory: 'timeout_aplicacion', finalStatus: 'fallido', reason: 'timeout_test' }),
    ]);
    expect(byResult(K.skip)).toEqual([
      expect.objectContaining({ attemptStatus: 'omitido', finalStatus: 'omitido', error: expect.stringContaining('dxmon_no_disponible') }),
    ]);
    // Cada intento persistió su inicio antes del resultado y liberó la compuerta del test.
    expect(api.calls.findIndex((c) => c.op === 'attempt')).toBeLessThan(api.calls.findIndex((c) => c.op === 'result'));
    const gates = await fs.readdir(gateDir);
    expect(gates).toContain('id-C3-1.json');
    expect(JSON.parse(await fs.readFile(path.join(gateDir, 'id-C3-1.json'), 'utf8'))).toEqual({ proceed: true, attemptNo: 2 });
  });

  it('navegador no aprovisionable = infraestructura; [auth_*] = login; setup fallido se informa aparte', async () => {
    const { byResult, tracker } = await run((r, env, setup) => {
      const s = fakeTest('login', null, setup);
      r.onTestBegin(s as never, result(0, 'failed') as never);
      r.onTestEnd(s as never, result(0, 'failed', [{ message: '[auth_credenciales_invalidas] Credenciales rechazadas' }]) as never);
      const b = fakeTest('C1', K.pass, env);
      r.onTestBegin(b as never, result(0, 'failed') as never);
      r.onTestEnd(b as never, result(0, 'failed', [{ message: "browserType.launch: Executable doesn't exist at /ms-playwright/chromium" }]) as never);
      const c = fakeTest('C2', K.fail, env);
      r.onTestBegin(c as never, result(0, 'failed') as never);
      r.onTestEnd(c as never, result(0, 'failed', [{ message: 'Error: [auth_desafio_mfa] MFA requerido' }]) as never);
    });
    expect(tracker.setupFailed?.message).toContain('auth_credenciales_invalidas');
    expect(byResult(K.pass)).toEqual([
      expect.objectContaining({ attemptStatus: 'error_infraestructura', errorCategory: 'navegador_no_disponible', finalStatus: 'error_infraestructura' }),
    ]);
    expect(byResult(K.fail)).toEqual([
      expect.objectContaining({ attemptStatus: 'error_infraestructura', errorCategory: 'login', finalStatus: 'bloqueado', reason: 'login_fallido' }),
    ]);
  });

  it('proceed=false al iniciar intento ⇒ compuerta cerrada y detención por cancelación', async () => {
    const api = new FakeWorkerApi();
    api.proceed = false;
    const gateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kgate-'));
    const stops: string[] = [];
    const t = assignedTest(K.pass);
    const tracker = new ResultTracker({
      api,
      leaseId: randomUUID(),
      generation: 1,
      tests: [t],
      logger: silentLogger(),
      knownSecrets: () => [],
      now: () => new Date(),
      gateDir,
      requestStop: (c) => stops.push(c),
    });
    await tracker.handle({ type: 'testBegin', key: `${K.pass}::default`, testId: 'tid', title: 'x', projectName: 'staging', isSetup: false, retry: 0, startTime: new Date().toISOString() });
    expect(stops).toEqual(['cancel']);
    expect(JSON.parse(await fs.readFile(path.join(gateDir, 'tid-0.json'), 'utf8'))).toMatchObject({ proceed: false });
  });
});
