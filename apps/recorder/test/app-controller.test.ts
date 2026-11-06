/**
 * Estado global del asistente contra el servidor falso: vínculo por flujo de dispositivo con credencial en el almacén,
 * enlace `katalyst://` antes de vincular, salud informada a la API (heartbeat), revocación (RF-GRB-01, ESP §9, §13.6)
 * y cliente HTTP (sobre de error, sin seguir redirecciones con la credencial).
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../src/shared/ipc.js';
import { AppStateSchema } from '../src/shared/ipc.js';
import { ApiError, KatalystApiClient } from '../src/main/core/api-client.js';
import { AppController } from '../src/main/core/app-controller.js';
import { CredentialStore, type Encryptor } from '../src/main/core/credential-store.js';
import { SessionStore } from '../src/main/core/session-store.js';
import { makeRecording, startFakeApi, virtualClock, type FakeApi } from './helpers/fake-api.js';

const enc: Encryptor = {
  isAvailable: async () => true,
  encrypt: async (s) => Buffer.from(s, 'utf8').reverse(),
  decrypt: async (b) => Buffer.from(b).reverse().toString('utf8'),
};

async function waitFor(fn: () => boolean, ms = 3000) {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('RF-GRB-01 AppController (vínculo, salud y enlaces)', () => {
  let api: FakeApi;
  let ctl: AppController;
  let states: AppState[];
  let opened: string[];
  let credFile: string;

  beforeEach(async () => {
    api = await startFakeApi();
    api.device.behavior = { kind: 'approve-after', polls: 2 };
    states = [];
    opened = [];
    const dir = mkdtempSync(join(tmpdir(), 'kapp-'));
    credFile = join(dir, 'cred.bin');
    ctl = new AppController({
      version: '0.1.0',
      platform: 'windows',
      devMode: true, // permite el servidor falso en loopback http
      config: { load: async () => ({ serverUrl: api.url }), save: vi.fn(async () => undefined) },
      credentials: new CredentialStore(credFile, enc),
      store: new SessionStore({ baseDir: join(dir, 'tmp') }),
      browser: { check: async () => ({ installed: true, source: 'descargado' }), install: async () => true },
      openExternal: async (u) => {
        opened.push(u);
      },
      createLoginBrowser: () => {
        throw new Error('no se usa');
      },
      createCodegen: () => {
        throw new Error('no se usa');
      },
      clock: virtualClock(),
      onState: (s) => states.push(s),
    });
    await ctl.init();
  });
  afterEach(async () => {
    await ctl.shutdown();
    await api.close();
  });

  it('vincula con código de un solo uso, guarda la credencial cifrada y abre la grabación pedida por enlace', async () => {
    const rec = makeRecording();
    api.recordings.set(rec.id, rec);
    api.environments = [
      { id: rec.environmentId, name: 'staging', isProduction: false, enabled: true, recordingAllowed: true },
    ];
    await ctl.handleDeepLink(`katalyst://grabar?session=${rec.id}`);
    expect(ctl.state().pendingRecordingId).toBe(rec.id);
    expect(ctl.state().device.status).toBe('sin_vincular');

    await ctl.startLink();
    const linking = ctl.state();
    expect(linking.device.status).toBe('vinculando');
    expect(linking.device.userCode).toBe('ABCD-EFGH');
    await ctl.openVerification();
    expect(opened).toEqual([`${api.url}/dispositivos?codigo=ABCD-EFGH`]);

    await waitFor(() => ctl.state().recording !== null && ctl.state().recording!.phase !== 'cargando');
    const s = ctl.state();
    expect(s.device.status).toBe('vinculado');
    expect(s.pendingRecordingId).toBeNull();
    expect(s.recording?.id).toBe(rec.id);
    // El estado publicado al renderer no contiene la credencial ni el deviceCode.
    for (const st of states) {
      expect(AppStateSchema.safeParse(st).success).toBe(true);
      expect(JSON.stringify(st)).not.toContain(api.device.token);
      expect(JSON.stringify(st)).not.toContain(api.device.deviceCode);
    }
    // Heartbeat informa salud con la grabación activa.
    await waitFor(() => api.requests.some((r) => r.path.endsWith('/devices/heartbeat')));
    const hb = api.requests.find((r) => r.path.endsWith('/devices/heartbeat'))!;
    expect(hb.headers.authorization).toBe(`Bearer ${api.device.token}`);
    expect((hb.body as { clientVersion: string }).clientVersion).toBe('0.1.0');
    await waitFor(() => ctl.state().device.healthy === true);
  });

  it('enlaces inválidos no hacen nada salvo avisar', async () => {
    await ctl.handleDeepLink('katalyst://grabar?session=x&token=abc');
    expect(ctl.state().notice?.kind).toBe('error');
    expect(ctl.state().pendingRecordingId).toBeNull();
  });

  it('credencial revocada en el servidor: el heartbeat (401) la borra y vuelve a "sin vincular"', async () => {
    await ctl.startLink();
    await waitFor(() => ctl.state().device.status === 'vinculado');
    api.revoked = true;
    await ctl.heartbeat();
    expect(ctl.state().device.status).toBe('sin_vincular');
    expect(ctl.state().device.message).toMatch(/revocada/);
    expect(await new CredentialStore(credFile, enc).load(api.url)).toBeNull();
  });

  it('desvincular revoca en el servidor y borra la credencial local', async () => {
    await ctl.startLink();
    await waitFor(() => ctl.state().device.status === 'vinculado');
    await ctl.unlink();
    expect(api.requests.some((r) => r.method === 'DELETE' && r.path.includes('/devices/'))).toBe(true);
    expect(ctl.state().device.status).toBe('sin_vincular');
  });

  it('lista grabaciones activas del usuario (oculta las terminadas)', async () => {
    await ctl.startLink();
    await waitFor(() => ctl.state().device.status === 'vinculado');
    api.recordings.set('a', makeRecording({ status: 'grabando' }));
    api.recordings.set('b', makeRecording({ status: 'pr_abierto' }));
    const activas = await ctl.listRecordings('activas');
    expect(activas.items.map((i) => i.status)).toEqual(['grabando']);
    const todas = await ctl.listRecordings('todas');
    expect(todas.items).toHaveLength(2);
  });
});

describe('RNF-SEG-01 cliente HTTP', () => {
  it('no sigue redirecciones (la credencial no viaja a otro host) y no refleja el token en errores', async () => {
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/api/v1/recordings')) {
        res.writeHead(302, { location: 'http://evil.example/steal' });
        res.end();
        return;
      }
      res.writeHead(422, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: 'RECORDING_PRODUCTION_BLOCKED',
            message: 'No se permite grabar en producción.',
            requestId: 'r1',
          },
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
    const token = 'kdev_' + 'q'.repeat(40);
    const client = new KatalystApiClient({ baseUrl: base, getToken: () => token });
    const redirect = await client.listRecordings().catch((e: unknown) => e);
    expect(redirect).toBeInstanceOf(ApiError);
    expect((redirect as ApiError).code).toBe('NETWORK_ERROR');
    const env = await client.listEnvironments().catch((e: unknown) => e);
    expect(env).toMatchObject({ status: 422, code: 'RECORDING_PRODUCTION_BLOCKED', requestId: 'r1' });
    expect(JSON.stringify(env)).not.toContain(token);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('sin credencial no llama a rutas autenticadas', async () => {
    const fetchSpy = vi.fn();
    const client = new KatalystApiClient({
      baseUrl: 'https://k.example.test/api/v1',
      fetch: fetchSpy,
      getToken: () => null,
    });
    await expect(client.getRecording('3f2b6c1e-8d4a-4b7e-9c2d-1a2b3c4d5e6f')).rejects.toMatchObject({ status: 401 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
