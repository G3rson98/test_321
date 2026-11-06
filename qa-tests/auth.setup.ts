/**
 * Autenticación del usuario de prueba y creación de storageState aislado. RF-AMB-02, RF-AMB-03, RNF-SEG-01,
 * ESP §10 regla 5, ESP §13.7, Bloque 0 (login real de Cognito y MFA).
 *
 * Flujo:
 * 1. Lee credenciales del archivo montado en tmpfs `KATALYST_TEST_USER_FILE` (JSON {username,password}); nunca de
 *    argumentos ni variables con el valor.
 * 2. Login real de Cognito en la app (FMS DeltaX). Detecta desafíos (MFA, cambio de contraseña) por la respuesta de
 *    Cognito o por la UI y falla con `auth_desafio_mfa` (incompatible con ejecución desatendida).
 * 3. Espera `users/api/users/current` (timeout real del frontend: 30 s) y valida identidad (KATALYST_EXPECTED_USERNAME)
 *    y ambiente (origen de app y de API esperados).
 * 4. Guarda storageState con permisos 0600 en un directorio 0700 fuera del repositorio. global-teardown.ts lo borra.
 *
 * Nada de este archivo registra credenciales, tokens, cuerpos de respuesta ni el nombre del usuario.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { test as setup, expect, type Response } from '@playwright/test';
import { readEnv, requireTarget } from './fixtures/env.ts';
import { KatalystError } from './fixtures/errors.ts';
import { AUTH_TIMEOUT_MS, FRONTEND_CURRENT_TIMEOUT_MS } from './fixtures/timeouts.ts';
import { LoginPage } from './pages/LoginPage.ts';
import { matchesService, SERVICES } from './pages/services.ts';

interface TestUserCredentials {
  username: string;
  password: string;
}

const MAX_CREDENTIAL_FILE_BYTES = 16 * 1024;

async function readTestUser(file: string | undefined): Promise<TestUserCredentials> {
  if (!file) {
    throw new KatalystError(
      'auth_credenciales_no_disponibles',
      'KATALYST_TEST_USER_FILE no está definido (el supervisor monta el archivo en tmpfs).',
    );
  }
  let raw: string;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_CREDENTIAL_FILE_BYTES) {
      throw new Error('no es un archivo regular de tamaño válido');
    }
    raw = await fs.readFile(file, 'utf8');
  } catch {
    throw new KatalystError('auth_credenciales_no_disponibles', 'No se pudo leer el archivo de credenciales montado.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new KatalystError('auth_credenciales_no_disponibles', 'El archivo de credenciales no es JSON válido.');
  }
  const record = (parsed ?? {}) as Record<string, unknown>;
  const username = record['username'];
  const password = record['password'];
  if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password) {
    throw new KatalystError('auth_credenciales_no_disponibles', 'El archivo de credenciales debe tener {username, password}.');
  }
  return { username: username.trim(), password };
}

/** Claves candidatas para la identidad en la respuesta de `current`. TODO(Bloque 0): fijar el campo real. */
const IDENTITY_KEYS = ['username', 'userName', 'user_name', 'email', 'mail', 'login', 'preferred_username', 'cognitoUsername'];

/** Recorre el JSON (profundidad acotada) y recoge valores string de claves de identidad. No registra nada. */
function collectIdentityValues(value: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 3 || value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 5)) collectIdentityValues(item, depth + 1, out);
    return out;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (IDENTITY_KEYS.includes(key) && typeof child === 'string') out.push(child.trim().toLowerCase());
    else if (child && typeof child === 'object') collectIdentityValues(child, depth + 1, out);
  }
  return out;
}

async function validateCurrent(
  current: Response,
  expected: { username: string; appOrigin: string; apiOrigin: string; pageUrl: string },
): Promise<void> {
  if (current.status() !== 200) {
    throw new KatalystError('auth_current_fallido', `users/api/users/current respondió HTTP ${current.status()}.`);
  }
  if (new URL(current.url()).origin !== expected.apiOrigin) {
    throw new KatalystError('auth_ambiente_inesperado', 'La app consultó `current` en un origen de API distinto al esperado.');
  }
  if (new URL(expected.pageUrl).origin !== expected.appOrigin) {
    throw new KatalystError('auth_ambiente_inesperado', 'Tras el login la app quedó en un origen distinto al esperado.');
  }
  let body: unknown;
  try {
    body = await current.json();
  } catch {
    throw new KatalystError('auth_identidad_no_verificable', 'La respuesta de `current` no es JSON.');
  }
  const identities = collectIdentityValues(body);
  if (identities.length === 0) {
    throw new KatalystError(
      'auth_identidad_no_verificable',
      'La respuesta de `current` no expone un campo de identidad reconocido (confirmar esquema en Bloque 0).',
    );
  }
  if (!identities.includes(expected.username.toLowerCase())) {
    throw new KatalystError('auth_identidad_inesperada', 'La sesión pertenece a un usuario distinto del esperado.');
  }
}

async function writeStorageState(file: string, state: unknown): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state), { mode: 0o600, flag: 'w' });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, file);
  const mode = (await fs.stat(file)).mode & 0o777;
  if (mode !== 0o600) {
    await fs.rm(file, { force: true });
    throw new KatalystError('storage_state_ruta_insegura', `storageState quedó con permisos ${mode.toString(8)}; se eliminó.`);
  }
}

type LoginOutcome =
  | { kind: 'ok'; current: Response }
  | { kind: 'mfa'; detail: string }
  | { kind: 'invalid'; detail: string }
  | { kind: 'cognito_error'; detail: string }
  | { kind: 'timeout' };

const NEVER = new Promise<never>(() => {});

setup('autenticar usuario de prueba y validar identidad/ambiente', async ({ page }) => {
  setup.setTimeout(AUTH_TIMEOUT_MS);
  const env = readEnv();
  const { appUrl, apiUrl } = requireTarget(env);
  const credentials = await readTestUser(env.testUserFile);
  const expectedUsername = env.expectedUsername ?? credentials.username;

  // Limpia cualquier estado previo (p. ej. tras un crash) antes de crear uno nuevo (ESP §13.7).
  await fs.rm(env.storageStatePath, { force: true });

  const login = new LoginPage(page);
  await login.goto();
  try {
    await login.waitForForm(30_000);
  } catch {
    throw new KatalystError(
      'auth_formulario_no_disponible',
      'No se encontró el formulario de login (selectores pendientes de Bloque 0 o app no disponible).',
    );
  }

  // Señales de Cognito: desafíos interactivos o errores de credenciales. Solo se leen ChallengeName/__type.
  let resolveCognito: (outcome: LoginOutcome) => void = () => {};
  const cognitoOutcome = new Promise<LoginOutcome>((resolve) => {
    resolveCognito = resolve;
  });
  page.on('response', (response) => {
    if (!LoginPage.isCognitoResponse(response)) return;
    void LoginPage.readCognitoSignal(response).then((signal) => {
      if (signal.kind === 'challenge') resolveCognito({ kind: 'mfa', detail: `desafío Cognito ${signal.challengeName}` });
      if (signal.kind === 'error') {
        const detail = `Cognito ${signal.errorType}`;
        if (/NotAuthorized|UserNotFound/.test(signal.errorType)) resolveCognito({ kind: 'invalid', detail });
        else if (/PasswordResetRequired|UserNotConfirmed/.test(signal.errorType)) resolveCognito({ kind: 'mfa', detail });
        else resolveCognito({ kind: 'cognito_error', detail });
      }
    }, () => undefined);
  });

  const currentPromise: Promise<LoginOutcome> = page
    .waitForResponse((r) => r.request().method() !== 'OPTIONS' && matchesService(r.url(), SERVICES.usersCurrent), {
      timeout: FRONTEND_CURRENT_TIMEOUT_MS * 2,
    })
    .then((current) => ({ kind: 'ok', current }) as const, () => NEVER);
  const mfaUi: Promise<LoginOutcome> = login.mfaChallenge
    .waitFor({ state: 'visible', timeout: FRONTEND_CURRENT_TIMEOUT_MS * 2 })
    .then(() => ({ kind: 'mfa', detail: 'pantalla de verificación visible' }) as const, () => NEVER);
  const errorUi: Promise<LoginOutcome> = login.errorMessage
    .waitFor({ state: 'visible', timeout: FRONTEND_CURRENT_TIMEOUT_MS * 2 })
    .then(() => ({ kind: 'invalid', detail: 'mensaje de error de login visible' }) as const, () => NEVER);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<LoginOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), FRONTEND_CURRENT_TIMEOUT_MS * 2);
  });

  await login.submitCredentials(credentials.username, credentials.password);
  const outcome = await Promise.race([currentPromise, cognitoOutcome, mfaUi, errorUi, timeout]);
  clearTimeout(timer);

  switch (outcome.kind) {
    case 'mfa':
      throw new KatalystError(
        'auth_desafio_mfa',
        `El login requiere intervención (${outcome.detail}); incompatible con ejecución desatendida. Bloqueo de Bloque 0.`,
      );
    case 'invalid':
      throw new KatalystError('auth_credenciales_invalidas', `Login rechazado (${outcome.detail}).`);
    case 'cognito_error':
      throw new KatalystError('auth_cognito_error', `Cognito devolvió un error no relacionado con credenciales (${outcome.detail}).`);
    case 'timeout':
      throw new KatalystError('auth_timeout', 'El login no completó ni presentó un desafío dentro del tiempo esperado.');
    case 'ok':
      break;
  }

  await validateCurrent(outcome.current, {
    username: expectedUsername,
    appOrigin: new URL(appUrl).origin,
    apiOrigin: new URL(apiUrl).origin,
    pageUrl: page.url(),
  });
  await expect(login.password, 'El formulario de login sigue visible tras autenticar').toBeHidden();

  await writeStorageState(env.storageStatePath, await page.context().storageState());
});
