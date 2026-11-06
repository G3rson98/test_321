/**
 * Grabación (ESP §14 "Grabación e IA", §13.6): flujo de dispositivo con vencimiento/un solo uso/consulta limitada,
 * credencial revocable (solo hash), grabación prohibida en producción, enlace solo con ID, transiciones idempotentes,
 * código con secreto rechazado sin reflejarlo, TODO/esperas fijas como advertencias que bloquean aprobación, rama +
 * PR sin tocar la rama protegida y PR no fusionado que NO aparece en el catálogo.
 * RF-GRB-01, RF-GRB-02, RF-GRB-05, RF-GRB-06, RNF-SEG-01.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { KatalystError } from '@katalyst/shared';
import { loadConfig } from '../src/config.js';
import { resolveBearer, type Principal } from '../src/lib/auth.js';
import { hashToken } from '../src/lib/crypto-tokens.js';
import { LocalGitPrProvider } from '../src/adapters/git-pr/index.js';
import {
  decideAuthorization,
  deviceHeartbeat,
  deviceStatus,
  pollDeviceToken,
  revokeDevice,
  startDeviceAuthorization,
  viewAuthorization,
} from '../src/modules/devices/service.js';
import {
  cancelRecording,
  completeRecording,
  createRecording,
  expireRecordingSessions,
  getRecording,
  stableKeyFor,
  updateRecordingStatus,
} from '../src/modules/recordings/service.js';
import { analyzeRecording } from '../src/modules/recordings/codegen.js';
import { createCase, createEnvironment, createLocalRepo, gitBranches, gitShow } from './support/api-c.js';

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
const config = loadConfig({ ...process.env, PUBLIC_BASE_URL: 'https://katalyst.example.test', GIT_PROTECTED_BRANCH: 'main' });
afterAll(() => prisma.$disconnect());

async function user(role: 'qa' | 'dev' | 'admin' = 'qa'): Promise<Principal & { kind: 'panel_user' }> {
  const u = await prisma.panelUser.create({ data: { email: `${role}-${crypto.randomUUID().slice(0, 8)}@example.test`, name: role, role } });
  return { kind: 'panel_user', id: u.id, role, email: u.email, sessionId: crypto.randomUUID() };
}

const err = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as KatalystError;
  }
  throw new Error('se esperaba error');
};

const CLIENT = { clientName: 'Katalyst Recorder', clientVersion: '0.1.0', platform: 'windows' as const };

describe('flujo de dispositivo (RF-GRB-01, ESP §13.6)', () => {
  it('RF-GRB-01 código de un solo uso, aprobación desde sesión, consulta limitada y credencial revocable (solo hash)', async () => {
    const qa = await user();
    const t0 = new Date();
    const start = await startDeviceAuthorization(prisma, config.PUBLIC_BASE_URL, CLIENT, t0);
    expect(start.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(start.expiresIn).toBe(300);
    expect(start.verificationUriComplete).toContain(start.userCode);
    expect(start.verificationUriComplete).not.toContain(start.deviceCode);
    const stored = await prisma.deviceAuthorization.findUniqueOrThrow({ where: { userCode: start.userCode } });
    expect(stored.deviceCodeHash).toBe(hashToken(start.deviceCode));
    expect(JSON.stringify(stored)).not.toContain(start.deviceCode);

    expect((await err(pollDeviceToken(prisma, start.deviceCode, new Date(t0.getTime() + 1000)))).code).toBe('DEVICE_AUTHORIZATION_PENDING');
    // Consulta antes del intervalo (5 s) → slow down.
    expect((await err(pollDeviceToken(prisma, start.deviceCode, new Date(t0.getTime() + 2000)))).code).toBe('DEVICE_SLOW_DOWN');
    expect((await viewAuthorization(prisma, start.userCode)).status).toBe('pendiente');
    await decideAuthorization(prisma, qa, start.userCode, 'aprobada');
    // Idempotente para la misma decisión.
    await decideAuthorization(prisma, qa, start.userCode, 'aprobada');
    const tok = await pollDeviceToken(prisma, start.deviceCode, new Date(t0.getTime() + 60_000));
    expect(tok.accessToken).toMatch(/^kdv_/);
    expect(tok.tokenType).toBe('Bearer');
    // Un solo uso.
    expect((await err(pollDeviceToken(prisma, start.deviceCode, new Date(t0.getTime() + 120_000)))).code).toBe('DEVICE_CODE_INVALID');
    // La credencial autentica como dispositivo del usuario; en BD solo su hash.
    const cred = await prisma.apiCredential.findFirstOrThrow({ where: { device: { id: tok.deviceId } } });
    expect(cred.tokenHash).toBe(hashToken(tok.accessToken));
    expect(cred.kind).toBe('dispositivo');
    const r = await resolveBearer({ prisma }, tok.accessToken);
    expect('principal' in r && r.principal).toMatchObject({ kind: 'device', id: tok.deviceId, userId: qa.id });
    await deviceHeartbeat(prisma, tok.deviceId, { clientVersion: '0.1.1', activeRecordingId: null });
    expect(await deviceStatus(prisma, qa.id)).toMatchObject({ linked: true, online: true, clientVersion: '0.1.1' });
    // Revocar invalida la credencial.
    await revokeDevice(prisma, qa, tok.deviceId, (o) => o === qa.id);
    const r2 = await resolveBearer({ prisma }, tok.accessToken);
    expect('error' in r2 && r2.error).toBe('TOKEN_REVOKED');
    expect((await deviceStatus(prisma, qa.id)).linked).toBe(false);
  });

  it('RF-GRB-01 vencimiento a los 5 min y denegación', async () => {
    const qa = await user();
    const t0 = new Date();
    const a = await startDeviceAuthorization(prisma, config.PUBLIC_BASE_URL, CLIENT, t0);
    expect((await err(pollDeviceToken(prisma, a.deviceCode, new Date(t0.getTime() + 301_000)))).code).toBe('DEVICE_CODE_EXPIRED');
    expect((await err(decideAuthorization(prisma, qa, a.userCode, 'aprobada', undefined, new Date(t0.getTime() + 302_000)))).code).toBe(
      'DEVICE_CODE_EXPIRED',
    );
    const b = await startDeviceAuthorization(prisma, config.PUBLIC_BASE_URL, CLIENT);
    await decideAuthorization(prisma, qa, b.userCode, 'denegada');
    expect((await err(pollDeviceToken(prisma, b.deviceCode))).code).toBe('DEVICE_ACCESS_DENIED');
    expect((await err(pollDeviceToken(prisma, 'kdc_' + 'A'.repeat(43)))).code).toBe('DEVICE_CODE_INVALID');
  });
});

const GOOD_CODE = `import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('/loadOrder');
  await page.getByRole('button', { name: 'Distribuidores' }).click();
  await page.waitForTimeout(3000);
  await page.locator('.css-2etuwl').click();
  // TODO selector
  await expect(page.locator('.InovuaReactDataGrid__row').first()).toBeVisible();
});
`;

describe('sesiones de grabación (RF-GRB-01/02/05/06, ESP §13.6)', () => {
  it('RF-GRB-01 producción o ambiente sin grabación → RECORDING_PRODUCTION_BLOCKED; enlace solo con ID y vence en 2 h', async () => {
    const qa = await user();
    const c = await createCase(prisma);
    const prod = await createEnvironment(prisma, { isProduction: true });
    expect((await err(createRecording(prisma, qa, { caseId: c.id, environmentId: prod.id, tags: [] }))).code).toBe('RECORDING_PRODUCTION_BLOCKED');
    const noRec = await createEnvironment(prisma, { recordingAllowed: false });
    expect((await err(createRecording(prisma, qa, { caseId: c.id, environmentId: noRec.id, tags: [] }))).code).toBe('RECORDING_PRODUCTION_BLOCKED');
    const env = await createEnvironment(prisma);
    const now = new Date();
    const r = await createRecording(prisma, qa, { caseId: c.id, environmentId: env.id, tags: ['@oc', '@escritura'] }, undefined, now);
    expect(r.assistantLink).toBe(`katalyst://grabar?session=${r.recording.id}`);
    expect(r.recording.status).toBe('creada');
    expect(r.recording.tags).toEqual(['@oc']); // @escritura es derivada de la clasificación
    expect(new Date(r.recording.expiresAt).getTime() - now.getTime()).toBe(2 * 3_600_000);
    expect(JSON.stringify(r)).not.toMatch(/storageState|password|kdv_/i);
    // Otro QA no la ve (404).
    expect((await err(getRecording(prisma, await user(), r.recording.id))).code).toBe('NOT_FOUND');
    expect((await getRecording(prisma, await user('admin'), r.recording.id)).id).toBe(r.recording.id);
  });

  it('RF-GRB-06 transiciones idempotentes, cancelación idempotente y vencimiento', async () => {
    const qa = await user();
    const c = await createCase(prisma);
    const env = await createEnvironment(prisma);
    const r = (await createRecording(prisma, qa, { caseId: c.id, environmentId: env.id, tags: [] })).recording;
    expect((await updateRecordingStatus(prisma, qa, r.id, { status: 'vinculada' })).status).toBe('vinculada');
    expect((await updateRecordingStatus(prisma, qa, r.id, { status: 'vinculada' })).status).toBe('vinculada');
    const g = await updateRecordingStatus(prisma, qa, r.id, { status: 'grabando', steps: [{ kind: 'accion', description: 'Clic en Distribuidores' }] });
    expect(g.steps).toHaveLength(1);
    expect((await cancelRecording(prisma, qa, r.id)).status).toBe('cancelada');
    expect((await cancelRecording(prisma, qa, r.id)).status).toBe('cancelada');
    expect((await err(updateRecordingStatus(prisma, qa, r.id, { status: 'grabando' }))).code).toBe('RECORDING_INVALID_STATE');
    // Vencimiento por tarea periódica.
    const r2 = (await createRecording(prisma, qa, { caseId: c.id, environmentId: env.id, tags: [] })).recording;
    expect(await expireRecordingSessions(prisma, new Date(Date.now() + 2 * 3_600_000 + 1000))).toBeGreaterThanOrEqual(1);
    expect((await getRecording(prisma, qa, r2.id)).status).toBe('vencida');
    expect((await err(completeRecording(prisma, { config, git: null }, qa, r2.id, { code: GOOD_CODE, classification: 'lectura', title: 'x', tags: [], steps: [], pendingVerifications: 0 }))).code).toBe('RECORDING_EXPIRED');
  });

  it('RF-GRB-05 grabación con secreto se rechaza sin reflejarlo en mensajes, auditoría ni sesión', async () => {
    const qa = await user();
    const c = await createCase(prisma);
    const env = await createEnvironment(prisma);
    const r = (await createRecording(prisma, qa, { caseId: c.id, environmentId: env.id, tags: [] })).recording;
    const secret = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJxYS11c2VyIn0.c2lnbmF0dXJhLXNpbnRldGljYQ';
    const code = GOOD_CODE.replace("await page.goto('/loadOrder');", `await page.goto('/loadOrder');\n  await page.setExtraHTTPHeaders({ Authorization: 'Bearer ${secret}' });`);
    const e = await err(completeRecording(prisma, { config, git: null }, qa, r.id, { code, classification: 'lectura', title: 'Abrir OC', tags: [], steps: [], pendingVerifications: 0 }));
    expect(e.code).toBe('SECRET_DETECTED');
    expect(JSON.stringify({ m: e.message, d: e.details })).not.toContain(secret);
    const s = await getRecording(prisma, qa, r.id);
    expect(s.status).toBe('rechazada');
    expect(s.rejectionReasons.map((x) => x.code)).toContain('SECRET_DETECTED');
    expect(JSON.stringify(s)).not.toContain(secret);
    const audit = await prisma.auditLog.findMany({ where: { entityId: r.id } });
    expect(JSON.stringify(audit)).not.toContain(secret);
  });

  it('RF-GRB-02 rama + PR con archivo C<id> @tags y manifiesto sin_clasificar; la rama protegida NO cambia y el catálogo no lo incorpora', async () => {
    const repo = createLocalRepo();
    const git = new LocalGitPrProvider(repo, 'main');
    const qa = await user();
    const c = await createCase(prisma, { title: 'Abrir Órdenes de carga' });
    const env = await createEnvironment(prisma);
    const r = (await createRecording(prisma, qa, { caseId: c.id, environmentId: env.id, tags: ['@oc'] })).recording;
    await updateRecordingStatus(prisma, qa, r.id, { status: 'grabando' });
    const done = await completeRecording(prisma, { config, git }, qa, r.id, {
      code: GOOD_CODE,
      classification: 'lectura',
      title: 'Abrir Órdenes de carga y cambiar a Distribuidores',
      tags: ['@humo'],
      steps: [
        { kind: 'accion', description: 'Clic en Distribuidores' },
        { kind: 'no_soportada', description: 'Arrastrar columna' },
      ],
      pendingVerifications: 1,
    });
    expect(done.status).toBe('pr_abierto');
    expect(done.branch).toBe(`katalyst/grabacion/c${c.trCaseId}-${r.id.slice(0, 8)}`);
    expect(done.prUrl).toBe(`local://${done.branch}`);
    expect(done.commit).toMatch(/^[0-9a-f]{40}$/);
    const codes = done.rejectionReasons.map((x) => x.code);
    expect(codes).toEqual(expect.arrayContaining(['TODO_SELECTOR', 'WAIT_FOR_TIMEOUT', 'GENERATED_CSS_CLASS', 'PENDING_VERIFICATION', 'UNSUPPORTED_STEPS']));
    expect(gitBranches(repo)).toContain(done.branch);
    const file = `tests/grabaciones/c${c.trCaseId}-${r.id.slice(0, 8)}.spec.ts`;
    const content = gitShow(repo, done.branch!, file)!;
    expect(content).toContain(`"C${c.trCaseId} Abrir Órdenes de carga y cambiar a Distribuidores @humo @oc"`);
    expect(content).toContain(`stableKey('${stableKeyFor(r.id)}')`);
    expect(content).toContain("from '../../fixtures/test.ts'");
    const manifest = JSON.parse(gitShow(repo, done.branch!, 'katalyst.manifest.json')!);
    expect(manifest.tests).toHaveLength(1);
    expect(manifest.tests[0]).toMatchObject({ stableKey: stableKeyFor(r.id), file, classification: 'sin_clasificar', cases: [`C${c.trCaseId}`] });
    // Rama protegida intacta: el PR no fusionado no existe para el catálogo.
    expect(JSON.parse(gitShow(repo, 'main', 'katalyst.manifest.json')!).tests).toHaveLength(0);
    expect(gitShow(repo, 'main', file)).toBeNull();
    expect(await prisma.automatedTest.count({ where: { stableKey: stableKeyFor(r.id) } })).toBe(0);
    // Idempotente: completar de nuevo devuelve el mismo PR.
    const again = await completeRecording(prisma, { config, git }, qa, r.id, { code: GOOD_CODE, classification: 'lectura', title: 'x', tags: [], steps: [], pendingVerifications: 0 });
    expect(again.prUrl).toBe(done.prUrl);
  });

  it('RF-GRB-02 plataforma Git caída: la sesión vuelve a su estado previo y puede reintentarse', async () => {
    const qa = await user();
    const c = await createCase(prisma);
    const env = await createEnvironment(prisma);
    const r = (await createRecording(prisma, qa, { caseId: c.id, environmentId: env.id, tags: [] })).recording;
    await updateRecordingStatus(prisma, qa, r.id, { status: 'grabando' });
    const broken = new LocalGitPrProvider('/nonexistent/katalyst-repo', 'main');
    const e = await err(completeRecording(prisma, { config, git: broken }, qa, r.id, { code: GOOD_CODE, classification: 'lectura', title: 'x', tags: [], steps: [], pendingVerifications: 0 }));
    expect(e.code).toBe('GIT_PROVIDER_UNAVAILABLE');
    expect((await getRecording(prisma, qa, r.id)).status).toBe('grabando');
  });

  it('RF-GRB-05 análisis estático: sintaxis inválida y credenciales escritas rechazan; storageState se elimina', () => {
    const base = { caseRef: 'C123', titleText: 'Caso', tags: [], stableKey: stableKeyFor('x'), recordingId: 'r', fixtureImport: '../../fixtures/test.ts', metadata: [], pendingVerifications: 0, unsupportedSteps: 0 };
    const bad = analyzeRecording({ ...base, code: "import { test } from '@playwright/test';\ntest('t', async ({ page }) => { await page.goto( ; });" });
    expect(bad.rejections.map((i) => i.code)).toContain('SYNTAX_ERROR');
    const creds = analyzeRecording({ ...base, code: GOOD_CODE.replace("await page.goto('/loadOrder');", "await page.getByLabel('password').fill('password', 'Sup3rSecreta!');") });
    expect(creds.rejections.map((i) => i.code)).toContain('HARDCODED_CREDENTIALS');
    const ss = analyzeRecording({ ...base, code: GOOD_CODE.replace("test('test'", "test.use({ storageState: 'auth.json' });\ntest('test'") });
    expect(ss.content).not.toContain('storageState');
    expect(ss.warnings.map((i) => i.code)).toContain('STORAGE_STATE_REMOVED');
  });
});
