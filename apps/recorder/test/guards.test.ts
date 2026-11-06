/**
 * Bloqueo de producción (ESP §13.6, RF-GRB-05), protocolo `katalyst://` solo con ID de sesión (ESP §13.6),
 * servidor solo HTTPS (RNF-SEG-03) y credencial de dispositivo cifrada y revocable (RF-GRB-01, RNF-SEG-01).
 */
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { EnvironmentSummary } from '@katalyst/shared/schemas';
import { isSafeExternalUrl, normalizeServerUrl } from '../src/main/core/config.js';
import { CredentialStore, type Encryptor } from '../src/main/core/credential-store.js';
import { findDeepLinkInArgv, parseDeepLink } from '../src/main/core/deep-link.js';
import {
  assertRecordableEnvironment,
  assertUrlNotProduction,
  resolveRecordingEnvironment,
} from '../src/main/core/environment-guard.js';

const envId = randomUUID();
const summary = (o: Partial<EnvironmentSummary> = {}): EnvironmentSummary => ({
  id: envId,
  name: 'staging',
  isProduction: false,
  enabled: true,
  recordingAllowed: true,
  ...o,
});

describe('RF-GRB-05 bloqueo de grabación en producción', () => {
  it('permite staging habilitado para grabar', () => {
    const env = resolveRecordingEnvironment(
      {
        environmentId: envId,
        environment: { id: envId, name: 'staging', isProduction: false, appUrl: 'https://staging.deltax.example/' },
      },
      [summary()],
    );
    expect(assertRecordableEnvironment(env, { devMode: false }).appUrl).toBe('https://staging.deltax.example/');
  });

  it('bloquea un ambiente marcado como producción (en el detalle o en la lista: gana el más restrictivo)', () => {
    expect(() =>
      assertRecordableEnvironment(
        resolveRecordingEnvironment({ environmentId: envId }, [summary({ isProduction: true })]),
        { devMode: false },
      ),
    ).toThrow(expect.objectContaining({ code: 'PRODUCTION_BLOCKED' }));
    const env = resolveRecordingEnvironment(
      { environmentId: envId, environment: { id: envId, name: 'x', isProduction: true } },
      [summary()],
    );
    expect(() => assertRecordableEnvironment(env, { devMode: false })).toThrow(
      expect.objectContaining({ code: 'PRODUCTION_BLOCKED' }),
    );
  });

  it('bloquea hosts productivos de DeltaX aunque la configuración diga lo contrario', () => {
    for (const appUrl of ['https://cbc.deltax.la/', 'https://fmsapi.deltax.la/x', 'https://a.cbc.deltax.la/']) {
      const env = resolveRecordingEnvironment(
        { environmentId: envId, environment: { id: envId, name: 'x', isProduction: false, appUrl } },
        [summary()],
      );
      expect(() => assertRecordableEnvironment(env, { devMode: false })).toThrow(
        expect.objectContaining({ code: 'PRODUCTION_BLOCKED' }),
      );
    }
    expect(() => assertUrlNotProduction('https://cbc.deltax.la/loadOrder')).toThrow(
      expect.objectContaining({ code: 'PRODUCTION_BLOCKED' }),
    );
  });

  it('falla cerrado: ambiente desconocido, grabación no habilitada o deshabilitado', () => {
    expect(() =>
      assertRecordableEnvironment(resolveRecordingEnvironment({ environmentId: envId }, []), { devMode: false }),
    ).toThrow(expect.objectContaining({ code: 'ENVIRONMENT_UNKNOWN' }));
    expect(() =>
      assertRecordableEnvironment(
        resolveRecordingEnvironment({ environmentId: envId }, [summary({ recordingAllowed: false })]),
        { devMode: false },
      ),
    ).toThrow(expect.objectContaining({ code: 'RECORDING_NOT_ALLOWED' }));
    expect(() =>
      assertRecordableEnvironment(
        resolveRecordingEnvironment({ environmentId: envId }, [summary({ enabled: false })]),
        { devMode: false },
      ),
    ).toThrow(expect.objectContaining({ code: 'RECORDING_NOT_ALLOWED' }));
    // Solo la extensión del detalle sin `recordingAllowed` ⇒ desconocido ⇒ no permitido.
    expect(() =>
      assertRecordableEnvironment(
        resolveRecordingEnvironment(
          { environmentId: envId, environment: { id: envId, name: 's', isProduction: false } },
          null,
        ),
        { devMode: false },
      ),
    ).toThrow(expect.objectContaining({ code: 'RECORDING_NOT_ALLOWED' }));
  });

  it('URL del ambiente: https obligatorio; http solo loopback en modo desarrollo; sin credenciales', () => {
    const mk = (appUrl: string) =>
      resolveRecordingEnvironment(
        { environmentId: envId, environment: { id: envId, name: 's', isProduction: false, appUrl } },
        [summary()],
      );
    expect(() => assertRecordableEnvironment(mk('http://staging.example.test/'), { devMode: false })).toThrow(
      expect.objectContaining({ code: 'ENVIRONMENT_URL_INSECURE' }),
    );
    expect(() => assertRecordableEnvironment(mk('http://127.0.0.1:5173/'), { devMode: false })).toThrow(
      expect.objectContaining({ code: 'ENVIRONMENT_URL_INSECURE' }),
    );
    expect(assertRecordableEnvironment(mk('http://127.0.0.1:5173/'), { devMode: true }).appUrl).toBe(
      'http://127.0.0.1:5173/',
    );
  });
});

describe('ESP §13.6 protocolo katalyst://', () => {
  const id = '3f2b6c1e-8d4a-4b7e-9c2d-1a2b3c4d5e6f';
  it('acepta solo el ID de sesión', () => {
    expect(parseDeepLink(`katalyst://grabar?session=${id}`)).toEqual({ kind: 'recording', recordingId: id });
    expect(parseDeepLink(`katalyst://recording/${id}`)).toEqual({ kind: 'recording', recordingId: id });
    expect(parseDeepLink(`KATALYST://grabar?session=${id.toUpperCase()}`)).toEqual({
      kind: 'recording',
      recordingId: id,
    });
  });
  it('rechaza enlaces con credenciales, parámetros extra u otros esquemas', () => {
    for (const bad of [
      `katalyst://grabar?session=${id}&token=abc`,
      `katalyst://grabar?session=${id}&session=${id}`,
      `katalyst://grabar?session=../../etc`,
      `katalyst://user:pass@grabar?session=${id}`,
      `katalyst://grabar?session=${id}#x`,
      `katalyst://recording/${id}?token=x`,
      `katalyst://otro?session=${id}`,
      `https://grabar?session=${id}`,
      'katalyst://grabar',
      `katalyst://grabar?session=${id}${'a'.repeat(300)}`,
    ]) {
      expect(parseDeepLink(bad), bad).toBeNull();
    }
  });
  it('encuentra el enlace en argv (Windows second-instance)', () => {
    expect(findDeepLinkInArgv(['C:\\Katalyst.exe', '--flag', `katalyst://grabar?session=${id}`])).toBe(
      `katalyst://grabar?session=${id}`,
    );
    expect(findDeepLinkInArgv(['C:\\Katalyst.exe'])).toBeNull();
  });
});

describe('RNF-SEG-03 servidor HTTPS y URLs externas', () => {
  it('normaliza a origen https y rechaza http salvo loopback en desarrollo', () => {
    expect(normalizeServerUrl('https://katalyst.example.test/panel?x=1', { devMode: false })).toBe(
      'https://katalyst.example.test',
    );
    expect(() => normalizeServerUrl('http://katalyst.example.test', { devMode: false })).toThrow();
    expect(() => normalizeServerUrl('http://localhost:3000', { devMode: false })).toThrow();
    expect(normalizeServerUrl('http://localhost:3000', { devMode: true })).toBe('http://localhost:3000');
    expect(() => normalizeServerUrl('http://192.168.1.10:3000', { devMode: true })).toThrow();
    expect(() => normalizeServerUrl('https://u:p@katalyst.example.test', { devMode: false })).toThrow();
    expect(() => normalizeServerUrl('file:///etc/passwd', { devMode: true })).toThrow();
  });
  it('solo abre en el navegador del sistema URLs https (y del mismo origen para el panel)', () => {
    expect(
      isSafeExternalUrl('https://k.example.test/dispositivos?codigo=ABCD-EFGH', {
        devMode: false,
        requireOrigin: 'https://k.example.test',
      }),
    ).toBe(true);
    expect(
      isSafeExternalUrl('https://evil.example/dispositivos', {
        devMode: false,
        requireOrigin: 'https://k.example.test',
      }),
    ).toBe(false);
    expect(isSafeExternalUrl('javascript:alert(1)', { devMode: true })).toBe(false);
    expect(isSafeExternalUrl('file:///C:/Windows', { devMode: true })).toBe(false);
  });
});

describe('RF-GRB-01 credencial de dispositivo en el almacén del SO', () => {
  const xor: Encryptor = {
    isAvailable: async () => true,
    encrypt: async (s) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ 0x5a)),
    decrypt: async (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString('utf8'),
  };
  const cred = (o = {}) => ({
    accessToken: 'kdev_' + 'z'.repeat(40),
    deviceId: randomUUID(),
    expiresAt: '2099-01-01T00:00:00.000Z',
    serverUrl: 'https://k.example.test',
    linkedAt: '2026-11-06T12:00:00.000Z',
    ...o,
  });

  it('guarda cifrado (sin el token en claro), carga y revoca', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'kcred-')), 'device-credential.bin');
    const store = new CredentialStore(file, xor);
    const c = cred();
    await store.save(c);
    expect(readFileSync(file).toString('utf8')).not.toContain(c.accessToken);
    expect(await new CredentialStore(file, xor).load('https://k.example.test')).toEqual(c);
    await store.clear();
    expect(existsSync(file)).toBe(false);
    expect(await new CredentialStore(file, xor).load('https://k.example.test')).toBeNull();
  });

  it('sin cifrado del SO no persiste en disco (solo memoria)', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'kcred-')), 'device-credential.bin');
    const store = new CredentialStore(file, { ...xor, isAvailable: async () => false });
    await store.save(cred());
    expect(existsSync(file)).toBe(false);
    expect(store.isPersistent()).toBe(false);
    expect(await store.load('https://k.example.test')).not.toBeNull();
    await expect(store.assertPersistent()).rejects.toMatchObject({ code: 'CREDENTIAL_STORE_UNAVAILABLE' });
  });

  it('credencial vencida, corrupta o de otro servidor se descarta', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kcred-'));
    const file = join(dir, 'c.bin');
    let now = Date.UTC(2026, 10, 6);
    const store = new CredentialStore(file, xor, () => now);
    await store.save(cred({ expiresAt: '2026-11-07T00:00:00.000Z' }));
    expect(await new CredentialStore(file, xor, () => now).load('https://otro.example.test')).toBeNull();
    expect(existsSync(file)).toBe(false);
    await store.save(cred({ expiresAt: '2026-11-07T00:00:00.000Z' }));
    now = Date.UTC(2026, 10, 8);
    expect(await new CredentialStore(file, xor, () => now).load('https://k.example.test')).toBeNull();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, 'basura');
    expect(await new CredentialStore(file, xor, () => now).load('https://k.example.test')).toBeNull();
  });
});
