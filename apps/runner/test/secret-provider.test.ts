/** SecretProvider propio (env|file|ssm) por referencia; nunca valores en logs. RF-AMB-02, RNF-SEG-01. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSecretProvider, SsmSecretProvider } from '../src/secrets/secret-provider.js';

describe('SecretProvider (RF-AMB-02)', () => {
  it('env: KATALYST_SECRET__<NOMBRE>; no permitido en producción', async () => {
    const p = createSecretProvider(
      { KATALYST_SECRET_PROVIDER: 'env', KATALYST_SECRET_FILE_DIR: '/nada', KATALYST_SSM_PREFIX: '/k', NODE_ENV: 'development' },
      { KATALYST_SECRET__QA_BOT: 'valor', REDIS_URL: 'redis://x' },
    );
    await expect(p.get('env:KATALYST_SECRET__QA_BOT')).resolves.toBe('valor');
    await expect(p.get('env:KATALYST_SECRET__OTRO')).rejects.toMatchObject({ code: 'SECRET_NOT_FOUND' });
    await expect(p.get('env:REDIS_URL')).rejects.toMatchObject({ code: 'SECRET_OUT_OF_SCOPE' });
    await expect(p.get('ssm:/k/x')).rejects.toMatchObject({ code: 'SECRET_SCHEME_NOT_ALLOWED' });
    expect(() => createSecretProvider({ KATALYST_SECRET_PROVIDER: 'env', KATALYST_SECRET_FILE_DIR: '/x', KATALYST_SSM_PREFIX: '/k', NODE_ENV: 'production' })).toThrow();
  });

  it('file: solo dentro del directorio permitido; referencias inválidas rechazadas', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ksec-'));
    await fs.writeFile(path.join(dir, 'pw'), 'clave\n');
    const p = createSecretProvider({ KATALYST_SECRET_PROVIDER: 'file', KATALYST_SECRET_FILE_DIR: dir, KATALYST_SSM_PREFIX: '/k', NODE_ENV: 'production' });
    await expect(p.get(`file:${dir}/pw`)).resolves.toBe('clave');
    await expect(p.get('file:/etc/passwd')).rejects.toMatchObject({ code: 'SECRET_OUT_OF_SCOPE' });
    await expect(p.get(`file:${dir}/../x`)).rejects.toMatchObject({ code: 'SECRET_REF_INVALID' });
  });

  it('ssm: limitado al prefijo, con WithDecryption', async () => {
    const asked: string[] = [];
    const p = new SsmSecretProvider('/katalyst/internal', 'us-east-1', { getParameter: async (n) => (asked.push(n), 'v') });
    await expect(p.get('ssm:/katalyst/internal/test-users/qa')).resolves.toBe('v');
    await expect(p.get('ssm:/otro/secreto')).rejects.toMatchObject({ code: 'SECRET_OUT_OF_SCOPE' });
    expect(asked).toEqual(['/katalyst/internal/test-users/qa']);
  });
});
