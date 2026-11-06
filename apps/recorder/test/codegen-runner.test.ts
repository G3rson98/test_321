/**
 * RF-GRB-01/06, ESP §13.7: lanzamiento de codegen sin secretos en argumentos ni entorno, lectura incremental de la
 * salida y detención. Usa un doble del CLI (test/helpers/fake-codegen.cjs) ejecutado con Node.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildChildEnv,
  buildCodegenArgs,
  buildInstallArgs,
  CodegenSession,
  PLAYWRIGHT_VERSION,
} from '../src/main/core/codegen-runner.js';

describe('RF-GRB-06 codegen-runner', () => {
  it('argumentos: target playwright-test, salida, test id, chromium, --load-storage y URL sin credenciales', () => {
    const args = buildCodegenArgs({
      cliPath: '/app/cli.js',
      outputFile: '/tmp/x/recording.spec.ts',
      storageStatePath: '/tmp/x/state.json',
      url: 'https://staging.example.test/loadOrder',
    });
    expect(args).toEqual([
      '/app/cli.js',
      'codegen',
      '--target=playwright-test',
      '--output',
      '/tmp/x/recording.spec.ts',
      '--test-id-attribute',
      'data-testid',
      '--browser',
      'chromium',
      '--load-storage',
      '/tmp/x/state.json',
      'https://staging.example.test/loadOrder',
    ]);
    expect(() =>
      buildCodegenArgs({
        cliPath: 'c',
        outputFile: 'o',
        storageStatePath: null,
        url: 'https://u:p@staging.example.test/',
      }),
    ).toThrow();
    expect(() =>
      buildCodegenArgs({ cliPath: 'c', outputFile: 'o', storageStatePath: null, url: 'file:///etc/passwd' }),
    ).toThrow();
    expect(buildInstallArgs('/app/cli.js')).toEqual(['/app/cli.js', 'install', 'chromium', '--no-shell']);
    expect(PLAYWRIGHT_VERSION).toBe('1.65.0');
  });

  it('entorno del hijo: lista blanca (sin NODE_OPTIONS, tokens ni variables KATALYST_*)', () => {
    const env = buildChildEnv(
      {
        PATH: '/usr/bin',
        TEMP: '/tmp',
        NODE_OPTIONS: '--require /evil.js',
        KATALYST_DEVICE_TOKEN: 'secreto',
        GITHUB_TOKEN: 'ghp_x',
        ELECTRON_RUN_AS_NODE: '0',
      },
      { browsersPath: '/b', electronRunAsNode: true },
    );
    expect(env).toEqual({
      PATH: '/usr/bin',
      TEMP: '/tmp',
      PLAYWRIGHT_BROWSERS_PATH: '/b',
      PLAYWRIGHT_SKIP_BROWSER_GC: '1',
      ELECTRON_RUN_AS_NODE: '1',
    });
  });

  it('lee la salida mientras se graba y se detiene con SIGTERM conservando el código', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kcodegen-'));
    const output = join(dir, 'recording.spec.ts');
    const seen: string[] = [];
    const session = new CodegenSession(
      {
        host: {
          spawn: (c, a, o) => spawn(c, [...a], o),
          platform: process.platform === 'win32' ? 'linux' : process.platform,
        },
        nodeExecutable: process.execPath,
        cliPath: join(__dirname, 'helpers', 'fake-codegen.cjs'),
        browsersPath: join(dir, 'browsers'),
        electronRunAsNode: false,
        baseEnv: { PATH: process.env.PATH, KATALYST_DEVICE_TOKEN: 'no-debe-pasar' },
        pollIntervalMs: 20,
      },
      output,
      (code) => seen.push(code),
    );
    session.start({ storageStatePath: join(dir, 'state.json'), url: 'https://staging.example.test/' });
    await new Promise((r) => setTimeout(r, 400));
    expect(session.running).toBe(true);
    const exit = await session.stop();
    expect(exit.stoppedByUser).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[seen.length - 1]).toContain('toBeVisible()');
    const meta = JSON.parse(readFileSync(output + '.meta', 'utf8')) as { args: string[]; env: Record<string, string> };
    expect(meta.args).toContain('--load-storage');
    expect(meta.env.KATALYST_DEVICE_TOKEN).toBeUndefined();
    expect(meta.env.PLAYWRIGHT_BROWSERS_PATH).toBe(join(dir, 'browsers'));
  });

  it('informa la salida inesperada del proceso (cierre por el usuario o error)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kcodegen-'));
    const output = join(dir, 'recording.spec.ts');
    const session = new CodegenSession(
      {
        host: { spawn: (c, a, o) => spawn(c, [...a, '--exit-fast'], o), platform: 'linux' },
        nodeExecutable: process.execPath,
        cliPath: join(__dirname, 'helpers', 'fake-codegen.cjs'),
        browsersPath: dir,
        electronRunAsNode: false,
        baseEnv: { PATH: process.env.PATH },
        pollIntervalMs: 20,
      },
      output,
      () => undefined,
    );
    session.start({ storageStatePath: null, url: null });
    const exit = await session.exited;
    expect(exit).toEqual({ code: 3, signal: null, stoppedByUser: false });
  });
});
