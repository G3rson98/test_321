/**
 * RF-GRB-01, ESP §13.6: flujo de dispositivo contra un servidor falso (aprobación, vencimiento 5 min, slow_down,
 * rechazo) con reloj virtual. Verifica que el sondeo nunca supera el intervalo y que el deviceCode no se expone.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KatalystApiClient } from '../src/main/core/api-client.js';
import { pollDeviceToken, startDeviceAuthorization, SLOW_DOWN_INCREMENT_MS } from '../src/main/core/device-flow.js';
import { RecorderError } from '../src/main/core/errors.js';
import { startFakeApi, virtualClock, type FakeApi } from './helpers/fake-api.js';

const CLIENT = { clientName: 'Asistente', clientVersion: '0.1.0', platform: 'windows' as const };

describe('RF-GRB-01 flujo de dispositivo', () => {
  let api: FakeApi;
  let client: KatalystApiClient;
  beforeEach(async () => {
    api = await startFakeApi();
    client = new KatalystApiClient({ baseUrl: api.apiBase });
  });
  afterEach(() => api.close());

  it('aprobación: obtiene la credencial tras consultas pendientes respetando el intervalo', async () => {
    api.device.behavior = { kind: 'approve-after', polls: 3 };
    const clock = virtualClock();
    const auth = await startDeviceAuthorization(client, CLIENT, clock);
    expect(auth.userCode).toBe('ABCD-EFGH');
    expect(auth.expiresAtMs - clock.now()).toBe(300_000);
    const token = await pollDeviceToken(client, auth, clock);
    expect(token.accessToken).toBe(api.device.token);
    expect(token.polls).toBe(3);
    expect(clock.sleeps).toEqual([5000, 5000, 5000]);
    // El deviceCode viaja en el cuerpo (POST), nunca en la URL; el flujo no envía Authorization.
    const tokenReqs = api.requests.filter((r) => r.path.endsWith('/devices/token'));
    expect(
      tokenReqs.every(
        (r) => r.method === 'POST' && !r.path.includes(api.device.deviceCode) && !r.headers.authorization,
      ),
    ).toBe(true);
  });

  it('vencimiento: deja de consultar a los 5 minutos con DEVICE_CODE_EXPIRED y sondeo limitado', async () => {
    api.device.behavior = { kind: 'never' };
    const clock = virtualClock();
    const auth = await startDeviceAuthorization(client, CLIENT, clock);
    await expect(pollDeviceToken(client, auth, clock)).rejects.toMatchObject({ code: 'DEVICE_CODE_EXPIRED' });
    expect(api.device.polls).toBeLessThanOrEqual(60); // 300 s / 5 s
    expect(clock.now() - (auth.expiresAtMs - 300_000)).toBeGreaterThanOrEqual(300_000);
  });

  it('el vencimiento local se acota a 5 min aunque la API ofrezca más', async () => {
    api.device.expiresIn = 3600;
    api.device.behavior = { kind: 'never' };
    const clock = virtualClock();
    const auth = await startDeviceAuthorization(client, CLIENT, clock);
    expect(auth.expiresAtMs - clock.now()).toBe(300_000);
  });

  it('slow_down: aumenta el intervalo 5 s por cada aviso y luego obtiene la credencial', async () => {
    api.device.behavior = { kind: 'slow-down-at', polls: [2, 3], approveAfter: 5 };
    const clock = virtualClock();
    const auth = await startDeviceAuthorization(client, CLIENT, clock);
    const seen: number[] = [];
    const token = await pollDeviceToken(client, auth, clock, { onSlowDown: (ms) => seen.push(ms) });
    expect(token.deviceId).toBe(api.device.deviceId);
    expect(seen).toEqual([5000 + SLOW_DOWN_INCREMENT_MS, 5000 + 2 * SLOW_DOWN_INCREMENT_MS]);
    expect(clock.sleeps).toEqual([5000, 5000, 10000, 15000, 15000]);
  });

  it('código vencido informado por el servidor y rechazo desde el panel', async () => {
    api.device.behavior = { kind: 'expire-after', polls: 2 };
    let clock = virtualClock();
    let auth = await startDeviceAuthorization(client, CLIENT, clock);
    await expect(pollDeviceToken(client, auth, clock)).rejects.toMatchObject({ code: 'DEVICE_CODE_EXPIRED' });

    api.device.behavior = { kind: 'deny-after', polls: 1 };
    clock = virtualClock();
    auth = await startDeviceAuthorization(client, CLIENT, clock);
    await expect(pollDeviceToken(client, auth, clock)).rejects.toMatchObject({ code: 'DEVICE_ACCESS_DENIED' });
  });

  it('cancelación por el usuario detiene el sondeo', async () => {
    api.device.behavior = { kind: 'never' };
    const clock = virtualClock();
    const auth = await startDeviceAuthorization(client, CLIENT, clock);
    const abort = new AbortController();
    const sleep = clock.sleep;
    clock.sleep = async (ms, signal) => {
      if (clock.sleeps.length === 2) abort.abort();
      return sleep(ms, signal);
    };
    await expect(pollDeviceToken(client, auth, clock, { signal: abort.signal })).rejects.toBeInstanceOf(Error);
    expect(api.device.polls).toBeLessThanOrEqual(2);
  });

  it('servidor caído: tras 3 errores de red consecutivos informa NETWORK_ERROR sin bucle infinito', async () => {
    const clock = virtualClock();
    const auth = await startDeviceAuthorization(client, CLIENT, clock);
    await api.close();
    const err = await pollDeviceToken(client, auth, clock).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecorderError);
    expect((err as RecorderError).code).toBe('NETWORK_ERROR');
    expect(clock.sleeps.length).toBe(3);
    api = await startFakeApi(); // para afterEach
  });
});
