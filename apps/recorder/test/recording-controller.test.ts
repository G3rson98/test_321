/**
 * Flujo completo de grabación contra el servidor falso (cliente HTTP real) con codegen simulado por un proceso
 * hijo real: RF-GRB-01 (sesión local, producción bloqueada), RF-GRB-06 (iniciar/detener/descartar/regrabar/
 * verificación) y RF-GRB-02 (envío con título/etiquetas y URL del PR). RNF-SEG-01: el storageState nunca se envía.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentSummary, RecordingSession } from '@katalyst/shared/schemas';
import { KatalystApiClient } from '../src/main/core/api-client.js';
import { CodegenSession } from '../src/main/core/codegen-runner.js';
import { RecordingController, type LoginBrowser } from '../src/main/core/recording-controller.js';
import { SessionStore } from '../src/main/core/session-store.js';
import { makeRecording, startFakeApi, type FakeApi } from './helpers/fake-api.js';

const CANARY = 'KATALYST_CANARY_STORAGE_STATE_7c1';
const APP_URL = 'https://staging.example.test/';

async function waitFor(fn: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timeout esperando condición');
    await new Promise((r) => setTimeout(r, 15));
  }
}

function fakeLogin() {
  const closed: (() => void)[] = [];
  const login = {
    open: vi.fn(async (_url: string | null) => undefined),
    storageState: vi.fn(async () => ({
      cookies: [{ name: 'sid', value: CANARY, domain: 'staging.example.test' }],
      origins: [],
    })),
    close: vi.fn(async () => undefined),
    onClosed: (cb: () => void) => closed.push(cb),
    simulateUserClose: () => closed.forEach((c) => c()),
  };
  return login satisfies LoginBrowser & { simulateUserClose: () => void };
}

describe('RF-GRB-01/02/06 sesión de grabación', () => {
  let api: FakeApi;
  let base: string;
  let store: SessionStore;
  let login: ReturnType<typeof fakeLogin>;
  let ctl: RecordingController;
  let changes = 0;
  let codegenArgs: string[][] = [];
  let env: EnvironmentSummary;

  const addRecording = (
    o: Partial<RecordingSession> = {},
    appUrl: string | null = APP_URL,
    envOverrides: Record<string, unknown> = {},
  ) => {
    const rec = makeRecording({ environmentId: env.id, ...o });
    // Extensión `environment` de GET /recordings/:id (API-C, D-028).
    const environment = {
      id: env.id,
      name: 'staging',
      appUrl,
      isProduction: false,
      recordingAllowed: true,
      enabled: true,
      ...envOverrides,
    };
    const withEnv = { ...rec, environment };
    api.recordings.set(rec.id, withEnv as RecordingSession);
    return rec;
  };

  beforeEach(async () => {
    api = await startFakeApi();
    env = { id: crypto.randomUUID(), name: 'staging', isProduction: false, enabled: true, recordingAllowed: true };
    api.environments = [env];
    base = join(mkdtempSync(join(tmpdir(), 'krec-ctl-')), 'katalyst-recorder');
    store = new SessionStore({ baseDir: base });
    login = fakeLogin();
    codegenArgs = [];
    changes = 0;
    const client = new KatalystApiClient({ baseUrl: api.apiBase, getToken: () => api.device.token });
    ctl = new RecordingController({
      api: client,
      store,
      createLoginBrowser: () => login,
      createCodegen: (outputFile, onCode) =>
        new CodegenSession(
          {
            host: {
              spawn: (c, a, o) => {
                codegenArgs.push([...a]);
                return spawn(c, [...a], o);
              },
              platform: 'linux',
            },
            nodeExecutable: process.execPath,
            cliPath: join(__dirname, 'helpers', 'fake-codegen.cjs'),
            browsersPath: join(base, 'b'),
            electronRunAsNode: false,
            baseEnv: { PATH: process.env.PATH },
            pollIntervalMs: 20,
          },
          outputFile,
          onCode,
        ),
      browserReady: async () => true,
      devMode: false,
      onChange: () => {
        changes++;
      },
      stepsThrottleMs: 0,
    });
  });
  afterEach(async () => {
    await ctl.close().catch(() => undefined);
    await api.close();
  });

  it('bloquea la grabación en producción sin abrir el navegador ni crear archivos locales', async () => {
    const rec = addRecording({}, APP_URL, { isProduction: true });
    await ctl.open(rec.id);
    const v = ctl.view()!;
    expect(v.phase).toBe('bloqueada');
    expect(v.message).toMatch(/producción/);
    await expect(ctl.startLogin()).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(login.open).not.toHaveBeenCalled();
    expect(existsSync(join(base, rec.id))).toBe(false);
    expect(api.requests.some((r) => r.path.endsWith('/status'))).toBe(false);
  });

  it('flujo completo: login sin captura → storageState 0600 → codegen → verificación → detener → PR', async () => {
    const rec = addRecording();
    await ctl.open(rec.id);
    expect(ctl.view()!.phase).toBe('lista');
    expect(api.recordings.get(rec.id)!.status).toBe('vinculada');

    await ctl.startLogin();
    expect(login.open).toHaveBeenCalledWith(APP_URL);
    expect(ctl.view()!.phase).toBe('login');
    expect(codegenArgs).toEqual([]); // captura en pausa durante el login

    await ctl.startCapture({ skipLogin: false });
    await ctl.addVerification();
    expect(ctl.view()!.verificationGuide).toBe(true);
    const statePath = store.paths(rec.id).storageStatePath;
    expect(readFileSync(statePath, 'utf8')).toContain(CANARY);
    if (process.platform !== 'win32') expect(statSync(statePath).mode & 0o777).toBe(0o600);
    expect(login.close).toHaveBeenCalled();
    expect(codegenArgs[0]).toEqual(expect.arrayContaining(['--load-storage', statePath, APP_URL]));
    expect(api.recordings.get(rec.id)!.status).toBe('grabando');

    await waitFor(() => (ctl.view()?.steps.length ?? 0) === 3);
    const live = ctl.view()!;
    expect(live.steps.map((s) => s.kind)).toEqual(['accion', 'accion', 'verificacion']);
    expect(live.pendingVerifications).toBe(0); // la verificación pedida apareció
    expect(live.verificationGuide).toBe(false);
    expect(live.codePreview).not.toContain(CANARY);

    await ctl.stop();
    await waitFor(() => ctl.view()!.phase === 'detenida');
    // Pasos informados a la API sin datos de sesión.
    await waitFor(() => (api.recordings.get(rec.id)!.steps?.length ?? 0) === 3);

    const draft = {
      title: 'Ver lista de agendamientos',
      tags: ['@agendamiento', '@humo'],
      classification: 'lectura' as const,
    };
    const report = await ctl.validate(draft);
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);

    await ctl.submit(draft, false);
    const v = ctl.view()!;
    expect(v.phase).toBe('enviada');
    expect(v.prUrl).toBe('https://git.example.test/qa-tests/pull/84');
    const complete = api.requests.find((r) => r.path.endsWith('/complete'))!;
    const body = complete.body as {
      code: string;
      title: string;
      tags: string[];
      classification: string;
      steps: unknown[];
      pendingVerifications: number;
    };
    expect(body.title).toBe('C1501 Ver lista de agendamientos @agendamiento @humo');
    expect(body.code).toContain("test('C1501 Ver lista de agendamientos @agendamiento @humo'");
    expect(body.code).toContain("page.goto('/schedulings')");
    expect(body.classification).toBe('lectura');
    expect(body.pendingVerifications).toBe(0);
    expect(body.steps).toHaveLength(3);
    // RNF-SEG-01: ningún request lleva el storageState.
    expect(JSON.stringify(api.requests.map((r) => r.body))).not.toContain(CANARY);
    // Tras el envío se borran código y storageState locales.
    expect(existsSync(join(base, rec.id))).toBe(false);
  });

  it('si el QA cierra Chromium durante el login vuelve a "lista" sin grabar', async () => {
    const rec = addRecording();
    await ctl.open(rec.id);
    await ctl.startLogin();
    login.simulateUserClose();
    expect(ctl.view()!.phase).toBe('lista');
    expect(ctl.view()!.message).toMatch(/Cerraste el navegador/);
  });

  it('advertencias pendientes exigen confirmación y los secretos bloquean el envío', async () => {
    const rec = addRecording();
    await ctl.open(rec.id);
    await ctl.startCapture({ skipLogin: true });
    await waitFor(() => (ctl.view()?.steps.length ?? 0) === 3);
    await ctl.stop();
    await waitFor(() => ctl.view()!.phase === 'detenida');
    // Fuerza una verificación pendiente (acción después de la última verificación) y un secreto.
    const codePath = store.paths(rec.id).codePath;
    const code = readFileSync(codePath, 'utf8').replace(
      '});\n',
      "  await page.getByLabel('Correo').fill('ana.rojas@cliente.com');\n});\n",
    );
    writeFileSync(codePath, code);
    await ctl.close();
    await ctl.open(rec.id); // recupera la grabación local sin enviar
    expect(ctl.view()!.phase).toBe('detenida');
    expect(ctl.view()!.message).toMatch(/recuperó/);
    const draft = { title: 'Lista', tags: [], classification: 'lectura' as const };
    await expect(ctl.submit(draft, true)).rejects.toMatchObject({ code: 'VALIDATION_BLOCKED' });
    expect(api.requests.some((r) => r.path.endsWith('/complete'))).toBe(false);
    expect(JSON.stringify(ctl.view()!.validation)).not.toContain('ana.rojas@cliente.com');

    expect(await ctl.maskSensitive()).toBe(1);
    await expect(ctl.submit(draft, false)).rejects.toMatchObject({ code: 'WARNINGS_NOT_ACKNOWLEDGED' });
    await ctl.submit(draft, true);
    expect(ctl.view()!.phase).toBe('enviada');
    const body = api.requests.find((r) => r.path.endsWith('/complete'))!.body as {
      code: string;
      pendingVerifications: number;
    };
    expect(body.code).not.toContain('ana.rojas@cliente.com');
    expect(body.pendingVerifications).toBe(1);
  });

  it('descartar cancela en Katalyst, detiene codegen y borra todo lo local', async () => {
    const rec = addRecording();
    await ctl.open(rec.id);
    await ctl.startLogin();
    await ctl.startCapture({ skipLogin: false });
    await waitFor(() => (ctl.view()?.steps.length ?? 0) >= 1);
    await ctl.discard('Prueba');
    expect(ctl.view()!.phase).toBe('cancelada');
    expect(api.recordings.get(rec.id)!.status).toBe('cancelada');
    expect(existsSync(join(base, rec.id))).toBe(false);
  });

  it('regrabar reutiliza la sesión iniciada vigente y descarta los pasos anteriores', async () => {
    const rec = addRecording();
    await ctl.open(rec.id);
    await ctl.startLogin();
    await ctl.startCapture({ skipLogin: false });
    await waitFor(() => (ctl.view()?.steps.length ?? 0) === 3);
    await ctl.stop();
    await waitFor(() => ctl.view()!.phase === 'detenida');
    await ctl.rerecord();
    expect(codegenArgs).toHaveLength(2);
    expect(codegenArgs[1]).toContain('--load-storage');
    await ctl.stop();
    await waitFor(() => ctl.view()!.phase === 'detenida');
  });

  it('vencimiento (2 h): detiene procesos y borra storageState y código', async () => {
    const rec = addRecording();
    await ctl.open(rec.id);
    await ctl.startLogin();
    await ctl.startCapture({ skipLogin: false });
    await waitFor(() => (ctl.view()?.steps.length ?? 0) >= 1);
    await ctl.expire();
    expect(ctl.view()!.phase).toBe('vencida');
    expect(existsSync(join(base, rec.id))).toBe(false);
  });

  it('una grabación ya vencida o terminada no abre el navegador', async () => {
    const old = addRecording({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    await ctl.open(old.id);
    expect(ctl.view()!.phase).toBe('vencida');
    const done = addRecording({ status: 'pr_abierto', prUrl: 'https://git.example.test/pr/1' });
    await ctl.open(done.id);
    expect(ctl.view()!.phase).toBe('enviada');
    expect(ctl.view()!.prUrl).toBe('https://git.example.test/pr/1');
  });

  it('rechazo del servidor muestra los motivos', async () => {
    api.completeResponse = (r) => ({
      status: 200,
      body: {
        ...r,
        status: 'rechazada',
        rejectionReasons: [{ code: 'TODO_SELECTOR', message: 'Selector pendiente', line: 7 }],
      },
    });
    const rec = addRecording();
    await ctl.open(rec.id);
    await ctl.startCapture({ skipLogin: true });
    await waitFor(() => (ctl.view()?.steps.length ?? 0) === 3);
    await ctl.stop();
    await waitFor(() => ctl.view()!.phase === 'detenida');
    await ctl.submit({ title: 'x', tags: [], classification: 'lectura' }, true);
    expect(ctl.view()!.phase).toBe('rechazada');
    expect(ctl.view()!.rejectionReasons).toEqual([{ code: 'TODO_SELECTOR', message: 'Selector pendiente', line: 7 }]);
  });

  it('error de red al enviar conserva el código local para reintentar', async () => {
    api.completeResponse = () => ({
      status: 503,
      body: { error: { code: 'SERVICE_UNAVAILABLE', message: 'Servicio no disponible temporalmente.' } },
    });
    const rec = addRecording();
    await ctl.open(rec.id);
    await ctl.startCapture({ skipLogin: true });
    await waitFor(() => (ctl.view()?.steps.length ?? 0) === 3);
    await ctl.stop();
    await waitFor(() => ctl.view()!.phase === 'detenida');
    await ctl.submit({ title: 'x', tags: [], classification: 'lectura' }, true);
    expect(ctl.view()!.phase).toBe('detenida');
    expect(ctl.view()!.message).toMatch(/Katalyst respondió con un error/);
    expect(existsSync(store.paths(rec.id).codePath)).toBe(true);
    expect(changes).toBeGreaterThan(0);
  });
});

describe('RF-GRB-02 rechazo en el sandbox del backend (422)', () => {
  it('SECRET_DETECTED deja la sesión rechazada, muestra motivos sin valores y borra lo local', async () => {
    const api = await startFakeApi();
    const env: EnvironmentSummary = {
      id: crypto.randomUUID(),
      name: 'staging',
      isProduction: false,
      enabled: true,
      recordingAllowed: true,
    };
    const rec = makeRecording({ environmentId: env.id });
    api.recordings.set(rec.id, {
      ...rec,
      environment: {
        id: env.id,
        name: 'staging',
        appUrl: APP_URL,
        isProduction: false,
        recordingAllowed: true,
        enabled: true,
      },
    } as RecordingSession);
    api.completeResponse = (r) => {
      api.recordings.set(r.id, {
        ...r,
        status: 'rechazada',
        rejectionReasons: [{ code: 'SECRET_DETECTED', message: 'Posible secreto (jwt)', line: 4 }],
      });
      return {
        status: 422,
        body: {
          error: {
            code: 'SECRET_DETECTED',
            message: 'Se detectaron secretos.',
            details: { reasons: ['SECRET_DETECTED'] },
          },
        },
      };
    };
    const base = join(mkdtempSync(join(tmpdir(), 'krec-rej-')), 'k');
    const store = new SessionStore({ baseDir: base });
    const ctl = new RecordingController({
      api: new KatalystApiClient({ baseUrl: api.apiBase, getToken: () => api.device.token }),
      store,
      createLoginBrowser: () => fakeLogin(),
      createCodegen: (outputFile, onCode) =>
        new CodegenSession(
          {
            host: { spawn: (c, a, o) => spawn(c, [...a], o), platform: 'linux' },
            nodeExecutable: process.execPath,
            cliPath: join(__dirname, 'helpers', 'fake-codegen.cjs'),
            browsersPath: base,
            electronRunAsNode: false,
            baseEnv: { PATH: process.env.PATH },
            pollIntervalMs: 20,
          },
          outputFile,
          onCode,
        ),
      browserReady: async () => true,
      devMode: false,
      onChange: () => undefined,
    });
    await ctl.open(rec.id);
    // Con `environment` en el detalle no se consulta GET /environments (el dispositivo no tiene ese permiso).
    expect(api.requests.some((r) => r.path.endsWith('/environments'))).toBe(false);
    await ctl.startCapture({ skipLogin: true });
    await waitFor(() => (ctl.view()?.steps.length ?? 0) === 3);
    await ctl.stop();
    await waitFor(() => ctl.view()!.phase === 'detenida');
    await ctl.submit({ title: 'x', tags: [], classification: 'lectura' }, true);
    expect(ctl.view()!.phase).toBe('rechazada');
    expect(ctl.view()!.rejectionReasons).toEqual([
      { code: 'SECRET_DETECTED', message: 'Posible secreto (jwt)', line: 4 },
    ]);
    expect(existsSync(join(base, rec.id))).toBe(false);
    await api.close();
  });
});
