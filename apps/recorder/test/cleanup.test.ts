/**
 * ESP §7 (retención), §13.6, §13.7, RNF-SEG-01: storageState temporal 0600 que se borra al cerrar/cancelar/vencer
 * (2 h) y código local máximo 24 h; limpieza de sesiones abandonadas al iniciar y periódica.
 */
import { mkdtempSync, promises as fs, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startPeriodicCleanup, sweepSessions, type TimerApi } from '../src/main/core/cleanup.js';
import { LOCAL_CODE_TTL_MS, SessionStore, STORAGE_STATE_TTL_MS } from '../src/main/core/session-store.js';

const HOUR = 60 * 60 * 1000;
const STATE = {
  cookies: [{ name: 'session', value: 'KATALYST_CANARY_STATE', domain: 'staging.example.test' }],
  origins: [],
};

describe('RNF-SEG-01 session-store y limpieza', () => {
  let base: string;
  let now: number;
  let store: SessionStore;
  beforeEach(() => {
    base = join(mkdtempSync(join(tmpdir(), 'katalyst-rec-test-')), 'katalyst-recorder');
    now = Date.UTC(2026, 10, 6, 12);
    store = new SessionStore({ baseDir: base, now: () => now });
  });
  afterEach(async () => {
    await fs.rm(join(base, '..'), { recursive: true, force: true });
  });

  const expiresIn = (ms: number) => new Date(now + ms).toISOString();

  it('crea el directorio y el storageState con permisos restringidos (POSIX 0700/0600)', async () => {
    const id = randomUUID();
    const paths = await store.open(id, expiresIn(2 * HOUR));
    const statePath = await store.writeStorageState(id, STATE);
    expect(statePath).toBe(paths.storageStatePath);
    if (process.platform !== 'win32') {
      expect(statSync(base).mode & 0o777).toBe(0o700);
      expect(statSync(paths.dir).mode & 0o777).toBe(0o700);
      expect(statSync(statePath).mode & 0o777).toBe(0o600);
    }
    expect(await store.validStorageState(id)).toBe(statePath);
  });

  it('rechaza IDs que no son UUID (sin path traversal)', () => {
    expect(() => store.paths('../../etc')).toThrow();
    expect(() => store.paths('..\\..\\Windows')).toThrow();
  });

  it('el storageState vence a las 2 h aunque la grabación siga vigente', async () => {
    const id = randomUUID();
    await store.open(id, expiresIn(10 * HOUR));
    const p = await store.writeStorageState(id, STATE);
    now += STORAGE_STATE_TTL_MS - 1;
    expect(await store.validStorageState(id)).toBe(p);
    now += 1;
    expect(await store.validStorageState(id)).toBeNull();
    expect(existsSync(p)).toBe(false);
  });

  it('al iniciar el asistente elimina todo storageState abandonado y conserva código < 24 h', async () => {
    const id = randomUUID();
    const paths = await store.open(id, expiresIn(2 * HOUR));
    await store.writeStorageState(id, STATE);
    writeFileSync(paths.codePath, "test('C1 x', async () => {});");
    await store.markCodeSaved(id);
    const r = await sweepSessions(store, { startup: true });
    expect(r.removedStorageStates).toEqual([id]);
    expect(existsSync(paths.storageStatePath)).toBe(false);
    expect(existsSync(paths.codePath)).toBe(true);
  });

  it('borra la carpeta completa cuando el código local supera 24 h', async () => {
    const id = randomUUID();
    const paths = await store.open(id, expiresIn(2 * HOUR));
    writeFileSync(paths.codePath, 'x');
    await store.markCodeSaved(id);
    now += LOCAL_CODE_TTL_MS;
    const r = await sweepSessions(store);
    expect(r.removedSessions).toEqual([id]);
    expect(existsSync(paths.dir)).toBe(false);
  });

  it('periódica: respeta sesiones activas (solo vence su storageState) y elimina entradas ajenas o corruptas', async () => {
    const active = randomUUID();
    const corrupt = randomUUID();
    await store.open(active, expiresIn(10 * HOUR));
    const p = await store.writeStorageState(active, STATE);
    mkdirSync(join(base, corrupt));
    writeFileSync(join(base, corrupt, 'meta.json'), '{no json');
    writeFileSync(join(base, 'basura.txt'), 'x');
    now += LOCAL_CODE_TTL_MS + 1;
    const r = await sweepSessions(store, { activeIds: new Set([active]) });
    expect(existsSync(join(base, active))).toBe(true);
    expect(existsSync(p)).toBe(false);
    expect(r.removedStorageStates).toEqual([active]);
    expect(r.removedSessions).toEqual([corrupt]);
    expect(r.removedForeign).toEqual(['basura.txt']);
  });

  it('la grabación vencida invalida el storageState aunque no hayan pasado 2 h', async () => {
    const id = randomUUID();
    await store.open(id, expiresIn(30 * 60 * 1000));
    await store.writeStorageState(id, STATE);
    now += 30 * 60 * 1000;
    await sweepSessions(store, { activeIds: new Set([id]) });
    expect(await store.validStorageState(id)).toBeNull();
  });

  it('remove borra storageState y código', async () => {
    const id = randomUUID();
    const paths = await store.open(id, expiresIn(HOUR));
    await store.writeStorageState(id, STATE);
    writeFileSync(paths.codePath, 'x');
    await store.remove(id);
    expect(existsSync(paths.dir)).toBe(false);
  });

  it('startPeriodicCleanup programa la tarea cada 5 min y no la solapa', async () => {
    let tick: (() => void) | null = null;
    let cleared = false;
    const timers: TimerApi = {
      setInterval: (fn, ms) => {
        expect(ms).toBe(5 * 60 * 1000);
        tick = fn;
        return 1;
      },
      clearInterval: () => {
        cleared = true;
      },
    };
    let runs = 0;
    let release!: () => void;
    const stop = startPeriodicCleanup(
      () =>
        new Promise<void>((r) => {
          runs++;
          release = r;
        }),
      undefined,
      timers,
    );
    tick!();
    tick!();
    expect(runs).toBe(1);
    release();
    await new Promise((r) => setTimeout(r, 0));
    tick!();
    expect(runs).toBe(2);
    stop();
    expect(cleared).toBe(true);
  });
});
