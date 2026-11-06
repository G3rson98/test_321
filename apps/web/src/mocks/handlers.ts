/**
 * Handlers MSW alineados con `apps/api/src/modules/<módulo>/routes.ts`: mismas rutas, métodos, códigos (200/201/202),
 * filtros/orden/paginación por cursor `{items, nextCursor, hasNext}` (ESP §17.3), errores uniformes
 * `{ error: { code, message, requestId, details? } }`, CSRF en mutaciones e Idempotency-Key en `POST /runs`.
 * Cada respuesta pasa por el esquema Zod de @katalyst/shared que usa la API (`reply`/`replyPage`), así que un
 * campo que la API no serializa tampoco llega desde el mock. No hay endpoints fuera de `ROUTES`.
 */
import { http, HttpResponse, type DefaultBodyType, type StrictRequest } from 'msw';
import { decodeCursor, encodeCursor } from '@katalyst/shared/schemas';
import {
  AlertSchema,
  ExportCreateSchema,
  RecordingCreateSchema,
  NotificationChannelUpdateSchema,
  NotificationPreferencesUpdateSchema,
  PanelUserCreateSchema,
  PanelUserUpdateSchema,
  EventMarkCreateSchema,
  PerfThresholdCreateSchema,
  PerfThresholdUpdateSchema,
  ScheduleCreateSchema,
  SchedulePreviewRequestSchema,
  ScheduleUpdateSchema,
  EnvironmentCreateSchema,
  EnvironmentUpdateSchema,
  SuiteCreateSchema,
  SuiteUpdateSchema,
  TestUserCreateSchema,
  TestUserUpdateSchema,
  ApiTokenCreatedResponseSchema,
  ApiTokenSchema,
  ArtifactAccessResponseSchema,
  ArtifactSchema,
  AuditEntrySchema,
  AuthProvidersResponseSchema,
  AutomatedTestSchema,
  CaseLinkSchema,
  CaseResultSchema,
  DeliveryRetryResponseSchema,
  DeviceAuthorizationViewSchema,
  DeviceSchema,
  DeviceStatusResponseSchema,
  EnvironmentSchema,
  EnvironmentSummarySchema,
  EventMarkSchema,
  ExportDownloadResponseSchema,
  ExportJobSchema,
  GenerationDetailSchema,
  HistoryResponseSchema,
  LogoutResponseSchema,
  MeResponseSchema,
  NotificationChannelSchema,
  NotificationChannelTestResponseSchema,
  NotificationPreferencesSchema,
  OkResponseSchema,
  OutboxDeliverySchema,
  PanelUserSchema,
  PerfErrorItemSchema,
  PerfResponseSchema,
  PerfSeriesItemSchema,
  PerfThresholdSchema,
  RecordingCreatedSchema,
  RecordingDetailSchema,
  RunCancelResponseSchema,
  RunDetailSchema,
  RunPreviewResponseSchema,
  RunResultSchema,
  RunSummarySchema,
  RunTestRailTargetSchema,
  ScheduleNextResponseSchema,
  ScheduleOccurrenceSchema,
  SchedulePreviewResponseSchema,
  ScheduleRevisionSchema,
  ScheduleSchema,
  SuiteSchema,
  TestAttemptSchema,
  TestRailCaseDetailSchema,
  TestRailCaseSummarySchema,
  TestRailConnectionSchema,
  TestRailConnectionTestResponseSchema,
  TestRailSectionSchema,
  TestRailSyncRunSchema,
  TestUserSchema,
} from '@katalyst/shared/schemas';
import { z } from 'zod';
import { permissionsForRole } from '@katalyst/shared/rbac';
import { previewOccurrences, nextOccurrence, buildCronExpressions, ScheduleBuildError, validateSchedule } from '@katalyst/shared/schedule';
import { CASE_RESULT_STATUSES, type RunResultStatus } from '@katalyst/shared/enums';
import type {
  Environment,
  ExportJob,
  GenerationRequest,
  Me,
  PanelUser,
  PerfResponse,
  RecordingSession,
  RunPreview,
  Schedule,
  Suite,
  SyncRun,
  TestUser,
} from '@/lib/api/types';
import * as db from './data/seed';
import { reply, replyPage } from './contract';
import { DEMO_PASSWORD } from './fixtures';
import { currentSeq, emit, sseStream } from './sim';

const API = '/api/v1';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let reqCounter = 0;

// ---------------------------------------------------------------------------
// Sesión simulada (cookie de sesión emulada; en la API real es HttpOnly)
// ---------------------------------------------------------------------------
const COOKIE = 'katalyst_mock_session';
let sessionUserId: string | null = null;
let csrf: string | null = null;
function readCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(new RegExp(`${COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]!) : null;
}
function writeCookie(v: string | null) {
  if (typeof document === 'undefined') return;
  document.cookie = v ? `${COOKIE}=${encodeURIComponent(v)}; path=/; SameSite=Strict` : `${COOKIE}=; path=/; max-age=0`;
}
function currentUser(): PanelUser | null {
  const id = sessionUserId ?? readCookie()?.split('|')[0] ?? null;
  if (!id) return null;
  const u = db.users.find((x) => x.id === id && !x.disabledAt) ?? null;
  if (u && !csrf) csrf = readCookie()?.split('|')[1] ?? null;
  return u;
}
export function mockLogin(email: string): PanelUser | null {
  const u = db.userByEmail(email) ?? null;
  if (!u) return null;
  sessionUserId = u.id;
  csrf = crypto.randomUUID();
  writeCookie(`${u.id}|${csrf}`);
  return u;
}
export function mockLogout(): void {
  sessionUserId = null;
  csrf = null;
  writeCookie(null);
}
function me(u: PanelUser): Me {
  return {
    user: { id: u.id, email: u.email, name: u.name, role: u.role },
    permissions: permissionsForRole(u.role),
    session: { expiresAt: new Date(Date.now() + 8 * HOUR).toISOString(), csrfToken: csrf ?? '' },
    timezone: 'America/La_Paz',
  };
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
function err(status: number, code: string, message: string, details?: Record<string, unknown>) {
  reqCounter += 1;
  return HttpResponse.json({ error: { code, message, requestId: `mock-${reqCounter}`, ...(details ? { details } : {}) } }, { status });
}
const RANK = { qa: 1, dev: 2, admin: 3 } as const;
function guard(request: StrictRequest<DefaultBodyType>, min: 'qa' | 'dev' | 'admin' = 'qa'): PanelUser | Response {
  const u = currentUser();
  if (!u) return err(401, 'UNAUTHENTICATED', 'Se requiere autenticación.');
  if (request.method !== 'GET' && request.headers.get('X-CSRF-Token') !== csrf) {
    return err(403, 'CSRF_INVALID', 'Token CSRF ausente o inválido.');
  }
  if (RANK[u.role] < RANK[min]) return err(403, 'FORBIDDEN', 'No tienes permiso para esta operación.');
  return u;
}
const isResp = (x: unknown): x is Response => x instanceof Response;

function page<T>(items: readonly T[], url: URL, max = 100) {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 25) || 25, 1), max);
  const c = url.searchParams.get('cursor');
  const offset = c ? Number(decodeCursor(c)?.o ?? 0) : 0;
  const slice = items.slice(offset, offset + limit);
  const hasNext = offset + limit < items.length;
  // La API nunca devuelve `total` (paginación keyset): el mock tampoco.
  return { items: slice, nextCursor: hasNext ? encodeCursor({ o: offset + limit }) : null, hasNext };
}
function sortBy<T>(items: T[], sort: string | null, getters: Record<string, (x: T) => string | number | null>, idOf: (x: T) => string): T[] {
  const s = sort ?? '';
  const desc = s.startsWith('-');
  const key = desc ? s.slice(1) : s;
  const g = getters[key];
  if (!g) return items;
  return [...items].sort((a, b) => {
    const va = g(a) ?? '';
    const vb = g(b) ?? '';
    const cmp = va < vb ? -1 : va > vb ? 1 : idOf(a).localeCompare(idOf(b));
    return desc ? -cmp : cmp;
  });
}
const all = (url: URL, k: string) => url.searchParams.getAll(k).flatMap((v) => v.split(',')).filter(Boolean);
async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

const notFound = (message = 'Recurso inexistente o no visible.') => err(404, 'NOT_FOUND', message);
function scheduleOut(s: Schedule): Schedule {
  const next = s.enabled && !s.deletedAt ? nextOccurrence(s.cronExpressions, s.timezone, new Date()) : null;
  return { ...s, nextOccurrence: next ? next.toISOString() : null };
}
const replySchedule = (s: Schedule, status = 200) => reply(ScheduleSchema, scheduleOut(s), status);
/** Detalle de grabación = sesión + ambiente resumido (RecordingDetailSchema). */
function recordingDetail(r: Omit<RecordingSession, 'environment'>): RecordingSession {
  const e = db.environments.find((x) => x.id === r.environmentId);
  return { ...r, environment: { id: r.environmentId, name: e?.name ?? '', appUrl: e?.appUrl ?? null, isProduction: e?.isProduction ?? false, recordingAllowed: e?.recordingAllowed ?? false, enabled: e?.enabled ?? false } };
}
/** Valida y responde un cuerpo de creación/actualización con el esquema de la API (422 VALIDATION_FAILED). */
function validate<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> | Response {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  return err(422, 'VALIDATION_FAILED', 'La solicitud no cumple el esquema.', {
    issues: r.error.issues.slice(0, 20).map((i) => ({ path: i.path.map(String), code: i.code, message: i.message })),
  });
}

/** Mismo criterio que `compileSchedule` de la API (mínimo de intervalo 5 min por defecto). */
const MIN_INTERVAL_MINUTES = 5;
type Compiled = { cronExpressions: string[]; description: string | null; windowStart: string | null; windowEnd: string | null };
function compile(b: { editor?: Parameters<typeof buildCronExpressions>[0]; cronExpressions?: string[]; timezone: string }): Compiled | { issue: { code: string; message: string } } {
  let c: Compiled;
  if (b.editor) {
    try {
      c = buildCronExpressions(b.editor, { minIntervalMinutes: MIN_INTERVAL_MINUTES });
    } catch (e) {
      if (e instanceof ScheduleBuildError) return { issue: { code: e.code, message: e.message } };
      return { issue: { code: 'CRON_INVALID', message: 'Expresión cron inválida.' } };
    }
  } else {
    c = { cronExpressions: b.cronExpressions ?? [], description: null, windowStart: null, windowEnd: null };
  }
  const v = validateSchedule(c.cronExpressions, b.timezone, { minIntervalMinutes: MIN_INTERVAL_MINUTES });
  if (!v.ok) return { issue: { code: v.issues[0]?.code ?? 'CRON_INVALID', message: v.issues[0]?.message ?? 'Expresión cron inválida.' } };
  return c;
}
function selectorOf(b: { suiteId?: string; caseIds?: string[]; tags?: string[] }): Schedule['selector'] {
  return b.suiteId ? { kind: 'suite', suiteId: b.suiteId } : b.caseIds ? { kind: 'cases', caseIds: b.caseIds } : { kind: 'tags', tags: b.tags ?? [] };
}

// ---------------------------------------------------------------------------
// Preview / creación de corridas
// ---------------------------------------------------------------------------
interface RunBody {
  suiteId?: string;
  caseIds?: string[];
  tags?: string[];
  environmentId: string;
  retries?: number;
  excludeFlaky?: boolean;
  testrail?: { mode: string };
}
function selectedCases(b: RunBody): db.MockCase[] | Response {
  const n = [b.suiteId, b.caseIds, b.tags].filter((x) => x !== undefined).length;
  if (n !== 1) return err(422, 'SELECTION_EXCLUSIVE', 'Indica exactamente uno de suiteId, caseIds o tags.');
  if (b.caseIds) {
    if (b.caseIds.length === 0) return err(422, 'SELECTION_EMPTY', 'La selección no resuelve ningún caso ni test.');
    if (b.caseIds.length > 500) return err(422, 'SELECTION_TOO_LARGE', 'La selección explícita supera el máximo de 500 casos.');
    const cs = b.caseIds.map(db.caseById);
    if (cs.some((c) => !c)) return err(422, 'SELECTION_FOREIGN_IDS', 'La selección contiene IDs inexistentes o ajenos al proyecto.');
    return cs as db.MockCase[];
  }
  if (b.suiteId) {
    const s = db.suiteById(b.suiteId);
    if (!s || s.deletedAt) return err(422, 'SELECTION_FOREIGN_IDS', 'La suite no existe.');
    return db.resolveSelector(s.selector);
  }
  return db.resolveSelector({ tags: b.tags ?? [] });
}
function buildPreview(b: RunBody, cs: db.MockCase[]): RunPreview | Response {
  const env = db.environments.find((e) => e.id === b.environmentId);
  if (!env) return err(422, 'SELECTION_FOREIGN_IDS', 'Ambiente inexistente.');
  if (!env.enabled) return err(422, 'ENVIRONMENT_DISABLED', 'El ambiente está deshabilitado.');
  const blockers: { code: string; message: string }[] = [];
  const warnings: { code: string; message: string }[] = [];
  const planTests: RunPreview['tests'] = [];
  const planCases: RunPreview['cases'] = cs.map((c) => {
    const reasons: RunPreview['cases'][number]['blockReasons'] = [];
    if (c.testIds.length === 0) reasons.push('sin_automatizacion');
    for (const tid of c.testIds) {
      const t = db.testById(tid)!;
      const tReasons: typeof reasons = [];
      const link = t.caseLinks.find((l) => l.caseId === c.id);
      if (env.isProduction && t.classification === 'escritura') tReasons.push('escritura_en_produccion');
      if (env.isProduction && t.classification === 'sin_clasificar') tReasons.push('clasificacion_ausente');
      if (link?.reviewStatus === 'requiere_revision') {
        if (env.isProduction) tReasons.push('revision_pendiente');
        else if (!warnings.some((w) => w.code === 'REVIEW_PENDING')) warnings.push({ code: 'REVIEW_PENDING', message: `${c.ref} tiene la revisión de pasos pendiente; en staging manual se ejecuta con advertencia.` });
      }
      if (b.excludeFlaky && t.flaky.isFlaky) tReasons.push('excluido_inestable');
      reasons.push(...tReasons.filter((r) => !reasons.includes(r)));
      if (!planTests.some((p) => p.automatedTestId === t.id)) {
        planTests.push({
          automatedTestId: t.id,
          stableKey: t.stableKey,
          filePath: t.filePath,
          title: t.title,
          classification: t.classification,
          parameterKey: 'default',
          retries: t.classification === 'escritura' && !t.writeIdempotencyApproved ? 0 : (b.retries ?? 0),
          writeIdempotencyApproved: t.writeIdempotencyApproved,
          executable: tReasons.length === 0,
          blockReasons: tReasons,
          selectedCaseIds: [c.id],
          touchedCaseIds: [],
        });
      }
    }
    return {
      caseId: c.id,
      trCaseId: c.trCaseId,
      ref: c.ref,
      title: c.title,
      revision: c.revision,
      testrailSuiteId: c.suiteId,
      executable: reasons.length === 0,
      blockReasons: reasons,
      requiredTests: c.testIds.map((tid) => ({ stableKey: db.testById(tid)!.stableKey, parameterKey: 'default' })),
      expectedCoverage: c.testIds.length === 0 ? 'ninguna' : 'completa',
    };
  });
  if (env.isProduction) warnings.push({ code: 'PRODUCTION', message: 'Producción: solo se ejecutan tests aprobados de solo lectura con usuario de solo lectura.' });
  const executableTests = planTests.filter((t) => t.executable).length;
  return {
    previewToken: `pv-${Date.now()}`,
    selection: b.suiteId ? { kind: 'suite', suiteId: b.suiteId } : b.caseIds ? { kind: 'cases', caseIds: b.caseIds } : { kind: 'tags', tags: b.tags ?? [] },
    environment: db.envSummary(env),
    catalogRevisionId: db.uuid(),
    gitCommit: db.MAIN_COMMIT_SHA,
    manifestHash: 'a'.repeat(64),
    cases: planCases,
    tests: planTests,
    counts: {
      cases: planCases.length,
      executableCases: planCases.filter((c) => c.executable).length,
      blockedCases: planCases.filter((c) => !c.executable).length,
      tests: planTests.length,
      executableTests,
    },
    blockers,
    warnings,
    willLaunchBrowser: executableTests > 0,
    testrailTargets: [{ testrailSuiteId: db.ids.TR_SUITE_ID, name: 'Master', caseCount: planCases.length }],
  };
}
const idempotency = new Map<string, { body: string; runId: string }>();

// ---------------------------------------------------------------------------
// Rendimiento sintético
// ---------------------------------------------------------------------------
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}
function perfPoints(series: (typeof db.PERF_SERIES)[number], from: number, to: number, by: 'hour' | 'day' | 'minute', shift = 0) {
  const step = by === 'day' ? DAY : HOUR;
  const out: PerfResponse['series'][number]['points'] = [];
  const start = from - (from % step) + (by === 'day' ? 4 * HOUR : 0);
  for (let t = start; t < to && out.length < 1000; t += step) {
    const local = new Date(t - 4 * HOUR).getUTCHours();
    if (by === 'hour' && (local < 8 || local > 18)) continue;
    const progress = by === 'hour' ? Math.max(0, local - 8) / 10 : hash01(series.endpointKey + t);
    const noise = (hash01(series.endpointKey + (t + shift)) - 0.5) * 0.25;
    const p95 = series.base + series.growth * progress * (shift ? 0.6 : 1) + series.base * noise;
    const n = series.screen === 'Instalaciones' ? 12 : by === 'day' ? 240 : 22 + Math.round(hash01(String(t)) * 6);
    const enough = n >= 20;
    out.push({
      bucketStart: new Date(t).toISOString(),
      started: n,
      completed: n - (hash01(String(t + 7)) < 0.1 ? 1 : 0),
      discarded: 0,
      httpErrors: hash01(series.endpointKey + t + 'e') < 0.08 ? 1 : 0,
      networkErrors: 0,
      timeouts: 0,
      over29s: 0,
      meanMs: Math.round(p95 * 0.62),
      maxMs: Math.round(p95 * 1.6),
      p95Ms: enough ? Math.round(p95) : null,
      p95Status: enough ? 'ok' : 'muestra_insuficiente',
      errorRate: enough ? 0.02 : null,
      timeoutRate: enough ? 0 : null,
      quality: enough ? 'suficiente' : 'insuficiente',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
export const handlers = [
  // ---------------- Auth
  http.get(`${API}/auth/providers`, () => reply(AuthProvidersResponseSchema, { local: true, oidc: { enabled: true, displayName: 'SSO de la empresa', loginUrl: '/api/v1/auth/oidc/login' } })),
  http.post(`${API}/auth/login`, async ({ request }) => {
    const b = await body<{ email?: string; password?: string }>(request);
    const email = (b.email ?? '').trim().toLowerCase();
    if (!email || !b.password) return err(422, 'VALIDATION_FAILED', 'La solicitud no cumple el esquema.', { issues: [{ path: ['email'], code: 'required', message: 'Requerido' }] });
    if (b.password === 'demasiados') return err(429, 'RATE_LIMITED', 'Demasiadas solicitudes; intenta más tarde.', { retryAfterSeconds: 30 });
    const u = db.userByEmail(email);
    if (!u || b.password !== DEMO_PASSWORD) return err(401, 'INVALID_CREDENTIALS', 'Credenciales inválidas.');
    if (u.disabledAt) return err(403, 'USER_DISABLED', 'El usuario está deshabilitado.');
    mockLogin(email);
    return reply(MeResponseSchema, me(u));
  }),
  http.post(`${API}/auth/logout`, () => {
    mockLogout();
    return reply(LogoutResponseSchema, { ok: true });
  }),
  http.get(`${API}/auth/me`, () => {
    const u = currentUser();
    return u ? reply(MeResponseSchema, me(u)) : err(401, 'UNAUTHENTICATED', 'Se requiere autenticación.');
  }),
  http.get(`${API}/auth/tokens`, ({ request }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    const url = new URL(request.url);
    const list = url.searchParams.get('includeRevoked') === 'true' ? db.apiTokens : db.apiTokens.filter((t) => !t.revokedAt);
    return replyPage(ApiTokenSchema, page([...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), url));
  }),
  http.post(`${API}/auth/tokens`, async ({ request }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    const b = await body<{ name: string; scopes: string[]; expiresAt: string }>(request);
    const t = { id: db.uuid(), name: b.name, kind: 'token_api' as const, principalId: g.id, scopes: b.scopes as never, hint: 'Ab12', expiresAt: b.expiresAt, revokedAt: null, lastUsedAt: null, createdAt: new Date().toISOString() };
    db.apiTokens.push(t);
    return reply(ApiTokenCreatedResponseSchema, { credential: t, token: `kat_${crypto.randomUUID().replace(/-/g, '')}` }, 201);
  }),
  http.delete(`${API}/auth/tokens/:id`, ({ request, params }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    const t = db.apiTokens.find((x) => x.id === params.id);
    if (!t) return err(404, 'NOT_FOUND', 'Recurso inexistente o no visible.');
    t.revokedAt ??= new Date().toISOString();
    return reply(ApiTokenSchema, t);
  }),

  // ---------------- TestRail / catálogo
  http.get(`${API}/testrail/sections`, ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const url = new URL(request.url);
    const p = page(db.sections, url);
    return replyPage(TestRailSectionSchema, {
      ...p,
      items: p.items.map((s) => {
        const own = db.cases.filter((c) => c.sectionId === s.id && !c.archivedAt);
        return { ...s, caseCount: own.length, automatedCount: own.filter((c) => c.automated).length };
      }),
    });
  }),
  http.get(`${API}/testrail/cases`, ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const url = new URL(request.url);
    let list = db.cases.filter((c) => !c.archivedAt);
    const section = url.searchParams.get('section');
    if (section) {
      const ids = new Set([section, ...db.sections.filter((s) => s.parentId === section).map((s) => s.id)]);
      list = list.filter((c) => ids.has(c.sectionId));
    }
    const q = url.searchParams.get('q')?.toLowerCase();
    if (q) list = list.filter((c) => c.title.toLowerCase().includes(q) || c.ref.toLowerCase() === q || c.ref.toLowerCase().startsWith(q));
    const automated = url.searchParams.get('automated');
    if (automated) list = list.filter((c) => c.automated === (automated === 'true'));
    const tags = all(url, 'tag');
    if (tags.length) list = list.filter((c) => c.tags.some((t) => tags.includes(t)));
    const lr = url.searchParams.get('lastResult');
    if (lr && !CASE_RESULT_STATUSES.includes(lr as never)) return err(422, 'VALIDATION_FAILED', 'Estado de último resultado desconocido.');
    if (lr) list = list.filter((c) => c.lastResult?.status === lr);
    list = sortBy(list, url.searchParams.get('sort') ?? 'title', { title: (c) => c.title, trCaseId: (c) => c.trCaseId, syncedAt: (c) => c.syncedAt }, (c) => c.id);
    return replyPage(TestRailCaseSummarySchema, page(list, url));
  }),
  http.get(`${API}/testrail/cases/:id`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const c = db.caseById(String(params.id));
    if (!c) return notFound();
    return reply(TestRailCaseDetailSchema, c);
  }),
  http.get(`${API}/testrail/cases/:id/history`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const c = db.caseById(String(params.id));
    if (!c) return notFound();
    const items = db.runs
      .filter((r) => r.results.some((x) => x.caseIds.includes(c.id)) && r.finishedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 20)
      .map((r) => {
        const rr = r.results.find((x) => x.caseIds.includes(c.id))!;
        return { runId: r.id, environmentId: r.environment.id, status: rr.status, durationMs: rr.durationMs, retryCount: rr.retryCount, finishedAt: r.finishedAt };
      });
    const done = items.filter((i) => ['pasado', 'inestable', 'fallido'].includes(i.status));
    return reply(HistoryResponseSchema, {
      items,
      nextCursor: null,
      hasNext: false,
      trend: {
        successRate: done.length ? done.filter((i) => i.status !== 'fallido').length / done.length : null,
        avgDurationMs: done.length ? done.reduce((a, i) => a + (i.durationMs ?? 0), 0) / done.length : null,
        observations: done.length,
      },
      flaky: c.flaky ?? null,
    });
  }),
  http.post(`${API}/testrail/sync`, ({ request }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    if (db.syncRuns[0]?.status === 'en_curso') return err(409, 'TESTRAIL_SYNC_IN_PROGRESS', 'Ya hay una sincronización de TestRail en curso.');
    const s: SyncRun = { ...db.syncRuns[0]!, id: db.uuid(), status: 'en_curso', trigger: 'manual', startedAt: new Date().toISOString(), finishedAt: null, createdBy: g.id };
    db.syncRuns.unshift(s);
    emit('testrail.sync', 'testrail_sync_run', s.id, 1, null, {});
    setTimeout(() => {
      s.status = 'exitosa';
      s.finishedAt = new Date().toISOString();
      db.connection.lastSyncAt = s.finishedAt;
      emit('testrail.sync', 'testrail_sync_run', s.id, 2, null, {});
    }, 4000);
    return reply(TestRailSyncRunSchema, s, 202);
  }),
  http.get(`${API}/testrail/sync-runs`, ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    return replyPage(TestRailSyncRunSchema, page(db.syncRuns, new URL(request.url)));
  }),
  http.get(`${API}/testrail/connection`, ({ request }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    return reply(TestRailConnectionSchema, db.connection);
  }),
  http.put(`${API}/testrail/connection`, async ({ request }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    const b = await body<Partial<typeof db.connection>>(request);
    if (b.version !== undefined && b.version !== db.connection.version) return err(409, 'VERSION_CONFLICT', 'El recurso cambió desde que lo leíste; recarga antes de guardar.');
    if (b.baseUrl && !b.baseUrl.startsWith('https://')) return err(422, 'HOST_NOT_ALLOWED', 'El host o esquema de la URL no está permitido.', { issues: [{ path: ['baseUrl'], code: 'HOST_NOT_ALLOWED', message: 'Usa una URL HTTPS permitida.' }] });
    Object.assign(db.connection, b, { version: db.connection.version + 1, updatedAt: new Date().toISOString() });
    return reply(TestRailConnectionSchema, db.connection);
  }),
  http.post(`${API}/testrail/connection/test`, async ({ request }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    const b = await body<{ baseUrl?: string }>(request);
    const ok = !b.baseUrl || b.baseUrl.includes('testrail');
    return reply(TestRailConnectionTestResponseSchema, {
      ok,
      errorCode: ok ? null : 'HOST_NOT_ALLOWED',
      message: ok ? 'Conexión correcta: TestRail 9.1, proyecto encontrado, permisos de lectura y escritura de resultados.' : 'El host no está en la lista permitida.',
      testrailVersion: ok ? '9.1.2' : null,
      projects: ok ? [{ externalId: 7, name: 'FMS DeltaX' }, { externalId: 9, name: 'Portal clientes' }] : [],
      latencyMs: ok ? 184 : null,
    });
  }),
  http.get(`${API}/tests`, ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const url = new URL(request.url);
    let list = db.tests.filter((t) => t.status !== 'retirado');
    const tags = all(url, 'tag');
    if (tags.length) list = list.filter((t) => t.tags.some((x) => tags.includes(x)));
    const caseRef = url.searchParams.get('case');
    if (caseRef) list = list.filter((t) => t.caseLinks.some((l) => l.ref === caseRef));
    const caseId = url.searchParams.get('caseId');
    if (caseId) list = list.filter((t) => t.caseLinks.some((l) => l.caseId === caseId));
    const section = url.searchParams.get('section');
    if (section) {
      const secs = new Set([section, ...db.sections.filter((x) => x.parentId === section).map((x) => x.id)]);
      list = list.filter((t) => t.caseLinks.some((l) => secs.has(db.caseById(l.caseId)?.sectionId ?? '')));
    }
    const status = url.searchParams.get('status');
    if (status) list = list.filter((t) => t.status === status);
    const cls = url.searchParams.get('classification');
    if (cls) list = list.filter((t) => t.classification === cls);
    const flaky = url.searchParams.get('flaky');
    if (flaky) list = list.filter((t) => t.flaky.isFlaky === (flaky === 'true'));
    const q = url.searchParams.get('q')?.toLowerCase();
    if (q) list = list.filter((t) => t.title.toLowerCase().includes(q) || t.filePath.toLowerCase().includes(q));
    list = sortBy(list, url.searchParams.get('sort') ?? 'title', { title: (t) => t.title, filePath: (t) => t.filePath, updatedAt: (t) => t.updatedAt }, (t) => t.id);
    return replyPage(AutomatedTestSchema, page(list, url));
  }),
  http.get(`${API}/tests/:id`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const t = db.testById(String(params.id));
    return t ? reply(AutomatedTestSchema, t) : notFound();
  }),
  http.get(`${API}/tests/:id/history`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const t = db.testById(String(params.id));
    if (!t) return notFound();
    const items = db.runs
      .filter((r) => r.results.some((x) => x.automatedTestId === t.id) && r.finishedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 20)
      .map((r) => {
        const rr = r.results.find((x) => x.automatedTestId === t.id)!;
        return { runId: r.id, environmentId: r.environment.id, status: rr.status, durationMs: rr.durationMs, retryCount: rr.retryCount, finishedAt: r.finishedAt };
      });
    const done = items.filter((i) => ['pasado', 'inestable', 'fallido'].includes(i.status));
    return reply(HistoryResponseSchema, {
      items,
      nextCursor: null,
      hasNext: false,
      trend: {
        successRate: done.length ? done.filter((i) => i.status !== 'fallido').length / done.length : null,
        avgDurationMs: done.length ? done.reduce((a, i) => a + (i.durationMs ?? 0), 0) / done.length : null,
        observations: done.length,
      },
      flaky: t.flaky,
    });
  }),
  http.put(`${API}/tests/:id/case-links/:caseId/review`, async ({ request, params }) => {
    const g = guard(request, 'dev');
    if (isResp(g)) return g;
    const t = db.testById(String(params.id));
    const c = db.caseById(String(params.caseId));
    const l0 = t?.caseLinks.find((x) => x.caseId === c?.id);
    if (!t || !c || !l0) return notFound();
    const b = await body<{ caseRevision: number }>(request);
    if (b.caseRevision !== c.revision) return err(409, 'VERSION_CONFLICT', 'El recurso cambió desde que lo leíste; recarga antes de guardar.');
    const l = t.caseLinks.find((x) => x.caseId === c.id);
    if (l) Object.assign(l, { reviewStatus: 'vigente', reviewedCaseRevision: c.revision, reviewedBy: g.id, reviewedAt: new Date().toISOString() });
    const cl = c.links.find((x) => x.automatedTestId === t.id);
    if (cl) Object.assign(cl, { reviewStatus: 'vigente', reviewedCaseRevision: c.revision });
    c.linksRequiringReview = 0;
    emit('catalog.updated', 'catalog_revision', c.id, Date.now(), null, {});
    return reply(CaseLinkSchema, l);
  }),

  // ---------------- Suites
  http.get(`${API}/suites`, ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const url = new URL(request.url);
    const q = url.searchParams.get('q')?.toLowerCase();
    let list = db.suites.filter((s) => !s.deletedAt);
    if (q) list = list.filter((s) => s.name.toLowerCase().includes(q));
    list = sortBy(list, url.searchParams.get('sort') ?? 'name', { name: (s) => s.name, updatedAt: (s) => s.updatedAt }, (s) => s.id);
    return replyPage(SuiteSchema, page(list, url));
  }),
  http.get(`${API}/suites/:id`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const s = db.suiteById(String(params.id));
    return s ? reply(SuiteSchema, s) : notFound();
  }),
  http.post(`${API}/suites`, async ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const b = validate(SuiteCreateSchema, await body(request));
    if (isResp(b)) return b;
    const resolved = db.resolveSelector(b.selector);
    const s: Suite = { id: db.uuid(), name: b.name, description: b.description ?? null, selector: b.selector, createdBy: g.id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null, version: 1, resolved: { cases: resolved.length, tests: resolved.filter((c) => c.automated).length } };
    db.suites.push(s);
    return reply(SuiteSchema, s, 201);
  }),
  http.put(`${API}/suites/:id`, async ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const s = db.suiteById(String(params.id));
    if (!s || s.deletedAt) return notFound();
    const b = validate(SuiteUpdateSchema, await body(request));
    if (isResp(b)) return b;
    if (b.version !== s.version) return err(409, 'VERSION_CONFLICT', 'El recurso cambió desde que lo leíste; recarga antes de guardar.');
    const selector = b.selector ?? s.selector;
    const resolved = db.resolveSelector(selector);
    Object.assign(s, { name: b.name ?? s.name, description: b.description === undefined ? s.description : b.description, selector, version: s.version + 1, updatedAt: new Date().toISOString(), resolved: { cases: resolved.length, tests: resolved.filter((c) => c.automated).length } });
    return reply(SuiteSchema, s);
  }),
  http.delete(`${API}/suites/:id`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const s = db.suiteById(String(params.id));
    if (!s || s.deletedAt) return notFound();
    if (db.schedules.some((x) => !x.deletedAt && x.enabled && x.suiteId === s.id)) return err(409, 'CONFLICT', 'La suite está en uso por programaciones activas.');
    s.deletedAt = new Date().toISOString();
    s.version += 1;
    return reply(SuiteSchema, s);
  }),

  // ---------------- Ambientes
  http.get(`${API}/environments`, ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const url = new URL(request.url);
    const admin = g.role === 'admin';
    const list = sortBy(db.environments.filter((e) => (admin && url.searchParams.get('includeDisabled') === 'true') || !e.disabledAt), 'name', { name: (e) => e.name }, (e) => e.id);
    const p = page(list, url);
    return admin ? replyPage(EnvironmentSchema, p) : replyPage(EnvironmentSummarySchema, { ...p, items: p.items.map(db.envSummary) });
  }),
  http.get(`${API}/environments/:id`, ({ request, params }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    const e = db.environments.find((x) => x.id === params.id);
    return e ? reply(EnvironmentSchema, e) : notFound();
  }),
  http.post(`${API}/environments`, async ({ request }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    const b = validate(EnvironmentCreateSchema, await body(request));
    if (isResp(b)) return b;
    if (!b.appUrl.startsWith('https://')) return err(422, 'HOST_NOT_ALLOWED', 'El host o esquema de la URL no está permitido.');
    if (db.environments.some((x) => !x.disabledAt && x.name.toLowerCase() === b.name.toLowerCase())) return err(409, 'CONFLICT', 'Ya existe un ambiente activo con ese nombre.');
    const e = { ...db.environments[0]!, ...b, id: db.uuid(), version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), disabledAt: null } as Environment;
    db.environments.push(e);
    return reply(EnvironmentSchema, e, 201);
  }),
  http.put(`${API}/environments/:id`, async ({ request, params }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    const e = db.environments.find((x) => x.id === params.id);
    if (!e) return notFound();
    const b = validate(EnvironmentUpdateSchema, await body(request));
    if (isResp(b)) return b;
    if (b.version !== e.version) return err(409, 'VERSION_CONFLICT', 'El recurso cambió desde que lo leíste; recarga antes de guardar.');
    Object.assign(e, b, { version: e.version + 1, updatedAt: new Date().toISOString() });
    return reply(EnvironmentSchema, e);
  }),
  http.get(`${API}/environments/:id/users`, ({ request, params }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    if (!db.environments.some((x) => x.id === params.id)) return notFound();
    const url = new URL(request.url);
    const list = db.testUsers.filter((u) => u.environmentId === params.id && (u.enabled || url.searchParams.get('includeDisabled') === 'true'));
    return replyPage(TestUserSchema, page(list, url));
  }),
  http.post(`${API}/environments/:id/users`, async ({ request, params }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    const env = db.environments.find((x) => x.id === params.id);
    if (!env) return notFound();
    const b = validate(TestUserCreateSchema, await body(request));
    if (isResp(b)) return b;
    if (env.isProduction && !b.readOnly) return err(422, 'PRODUCTION_BLOCKED', 'En producción solo se admiten usuarios de solo lectura (ESP §13.7).');
    if (db.testUsers.some((u) => u.environmentId === env.id && u.label === b.label)) return err(409, 'CONFLICT', 'Ya existe un usuario con esa etiqueta en el ambiente.');
    const u: TestUser = { id: db.uuid(), environmentId: env.id, ...b, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: 1 };
    db.testUsers.push(u);
    return reply(TestUserSchema, u, 201);
  }),
  http.put(`${API}/environments/:id/users/:userId`, async ({ request, params }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    const env = db.environments.find((x) => x.id === params.id);
    const u = db.testUsers.find((x) => x.id === params.userId && x.environmentId === params.id);
    if (!env || !u) return notFound();
    const b = validate(TestUserUpdateSchema, await body(request));
    if (isResp(b)) return b;
    if (b.version !== u.version) return err(409, 'VERSION_CONFLICT', 'El recurso cambió desde que lo leíste; recarga antes de guardar.');
    if (env.isProduction && b.readOnly === false) return err(422, 'PRODUCTION_BLOCKED', 'En producción solo se admiten usuarios de solo lectura (ESP §13.7).');
    const { version: _v, ...patch } = b;
    void _v;
    Object.assign(u, patch, { version: u.version + 1, updatedAt: new Date().toISOString() });
    return reply(TestUserSchema, u);
  }),

  // ---------------- Corridas
  http.get(`${API}/runs`, ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const url = new URL(request.url);
    let list = [...db.runs];
    const env = url.searchParams.get('environmentId');
    if (env) list = list.filter((r) => r.environment.id === env);
    const st = all(url, 'status');
    if (st.length) list = list.filter((r) => st.includes(r.status));
    const oc = url.searchParams.get('outcome');
    if (oc) list = list.filter((r) => r.outcome === oc);
    const tr = url.searchParams.get('trigger');
    if (tr) list = list.filter((r) => r.trigger === tr);
    const from = url.searchParams.get('from');
    if (from) list = list.filter((r) => r.createdAt >= from);
    const to = url.searchParams.get('to');
    if (to) list = list.filter((r) => r.createdAt < to);
    const suiteId = url.searchParams.get('suiteId');
    if (suiteId) list = list.filter((r) => r.suiteId === suiteId);
    const scheduleId = url.searchParams.get('scheduleId');
    if (scheduleId) list = list.filter((r) => r.scheduleId === scheduleId);
    const sync = url.searchParams.get('syncStatus');
    if (sync) list = list.filter((r) => r.syncStatus === sync);
    const createdBy = url.searchParams.get('createdBy');
    if (createdBy) list = list.filter((r) => r.createdBy.id === createdBy);
    list = sortBy(list, url.searchParams.get('sort') ?? '-createdAt', { createdAt: (r) => r.createdAt, finishedAt: (r) => r.finishedAt }, (r) => r.id);
    return replyPage(RunSummarySchema, page(list, url));
  }),
  http.get(`${API}/runs/:id`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const r = db.runById(String(params.id));
    return r ? reply(RunDetailSchema, r) : notFound();
  }),
  http.get(`${API}/runs/:id/results`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const r = db.runById(String(params.id));
    if (!r) return notFound();
    const url = new URL(request.url);
    const st = all(url, 'status');
    let list = st.length ? r.results.filter((x) => st.includes(x.status)) : r.results;
    const q = url.searchParams.get('q')?.toLowerCase();
    if (q) list = list.filter((x) => x.title.toLowerCase().includes(q) || x.filePath.toLowerCase().includes(q));
    return replyPage(RunResultSchema, page(list, url));
  }),
  http.get(`${API}/runs/:id/results/:resultId/attempts`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const r = db.runById(String(params.id));
    if (!r) return notFound();
    if (!r.results.some((x) => x.id === params.resultId)) return notFound();
    return reply(z.object({ items: z.array(TestAttemptSchema) }), { items: r.attempts.filter((a) => a.runResultId === params.resultId) });
  }),
  http.get(`${API}/runs/:id/case-results`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const r = db.runById(String(params.id));
    if (!r) return notFound();
    return replyPage(CaseResultSchema, page(r.caseResults, new URL(request.url)));
  }),
  http.get(`${API}/runs/:id/targets`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const r = db.runById(String(params.id));
    return r ? reply(z.object({ items: z.array(RunTestRailTargetSchema) }), { items: r.targets }) : notFound();
  }),
  http.get(`${API}/runs/:id/artifacts`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const r = db.runById(String(params.id));
    if (!r) return notFound();
    const url = new URL(request.url);
    const rid = url.searchParams.get('resultId');
    return replyPage(ArtifactSchema, page(rid ? r.artifacts.filter((a) => a.runResultId === rid) : r.artifacts, url));
  }),
  http.get(`${API}/runs/:id/artifacts/:artifactId`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const r = db.runById(String(params.id));
    const a = r?.artifacts.find((x) => x.id === params.artifactId);
    if (!a) return notFound();
    if (a.sanitizationStatus !== 'sanitizado') return err(422, 'ARTIFACT_NOT_PUBLISHABLE', a.sanitizationReason ?? 'El artefacto no está disponible.');
    return reply(ArtifactAccessResponseSchema, { artifact: a, url: `http://localhost:3001/visor/${a.id}?ticket=${crypto.randomUUID()}`, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), disposition: a.kind === 'reporte' || a.kind === 'traza' ? 'viewer' : 'download' });
  }),
  http.post(`${API}/runs/preview`, async ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const b = await body<RunBody>(request);
    const cs = selectedCases(b);
    if (isResp(cs)) return cs;
    const p = buildPreview(b, cs);
    return isResp(p) ? p : reply(RunPreviewResponseSchema, p);
  }),
  http.post(`${API}/runs`, async ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const key = request.headers.get('Idempotency-Key');
    if (!key) return err(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Falta el encabezado Idempotency-Key.');
    const raw = await request.text();
    const prev = idempotency.get(`${g.id}:${key}`);
    if (prev) {
      if (prev.body !== raw) return err(409, 'IDEMPOTENCY_CONFLICT', 'La misma Idempotency-Key se usó con un cuerpo distinto.');
      return reply(RunSummarySchema, db.runById(prev.runId)!, 200);
    }
    const b = JSON.parse(raw || '{}') as RunBody;
    const cs = selectedCases(b);
    if (isResp(cs)) return cs;
    const pv = buildPreview(b, cs);
    if (isResp(pv)) return pv;
    const env = db.environments.find((e) => e.id === b.environmentId)!;
    const suite = b.suiteId ? db.suiteById(b.suiteId) ?? null : null;
    const run = db.makeRun({
      caseList: cs,
      env,
      trigger: 'manual',
      by: g,
      at: Date.now(),
      suite,
      retries: b.retries ?? 0,
      status: 'en_cola',
      plan: pv.tests.map((t) => (t.executable ? 'pendiente' : 'bloqueado') as RunResultStatus),
      selectionLabel: b.tags ? b.tags.join(' ') : null,
    });
    if (!pv.willLaunchBrowser) {
      run.status = 'terminada';
      run.outcome = 'bloqueado';
      run.finishedAt = new Date().toISOString();
    }
    db.runs.push(run);
    idempotency.set(`${g.id}:${key}`, { body: raw, runId: run.id });
    emit('run.created', 'run', run.id, run.version, run.id, {});
    db.audit.unshift({ id: db.uuid(), actorKind: 'panel_user', actorId: g.id, actorDisplay: g.name, action: 'run.create', entity: 'run', entityId: suite?.name ?? run.selectionLabel ?? null, diff: null, requestId: null, createdAt: new Date().toISOString() });
    return reply(RunSummarySchema, run, 201);
  }),
  http.post(`${API}/runs/:id/cancel`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const r = db.runById(String(params.id));
    if (!r) return notFound();
    if (['terminada', 'cancelada', 'interrumpida', 'omitida'].includes(r.status)) return err(409, 'RUN_NOT_CANCELLABLE', 'La corrida ya terminó y no puede cancelarse.');
    if (r.status !== 'cancelando') {
      r.status = 'cancelando';
      r.cancelRequestedAt = new Date().toISOString();
      r.version += 1;
      emit('run.updated', 'run', r.id, r.version, r.id, { status: r.status, outcome: r.outcome, syncStatus: r.syncStatus, counts: r.counts, startedAt: r.startedAt, finishedAt: r.finishedAt, cancelRequestedAt: r.cancelRequestedAt });
    }
    return reply(RunCancelResponseSchema, { run: r, stopConfirmed: false });
  }),

  // ---------------- Programaciones
  http.get(`${API}/schedules`, ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const url = new URL(request.url);
    let list = db.schedules.filter((s) => !s.deletedAt);
    const env = url.searchParams.get('environmentId');
    if (env) list = list.filter((s) => s.environmentId === env);
    const en = url.searchParams.get('enabled');
    if (en) list = list.filter((s) => s.enabled === (en === 'true'));
    const q = url.searchParams.get('q')?.toLowerCase();
    if (q) list = list.filter((s) => s.name.toLowerCase().includes(q));
    list = sortBy(list, url.searchParams.get('sort') ?? 'name', { name: (s) => s.name, createdAt: (s) => s.createdAt, updatedAt: (s) => s.updatedAt }, (s) => s.id);
    const p = page(list, url);
    return replyPage(ScheduleSchema, { ...p, items: p.items.map(scheduleOut) });
  }),
  http.get(`${API}/schedules/:id`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const s = db.scheduleById(String(params.id));
    return s && !s.deletedAt ? replySchedule(s) : notFound();
  }),
  http.post(`${API}/schedules/preview`, async ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const b = validate(SchedulePreviewRequestSchema, await body(request));
    if (isResp(b)) return b;
    // Como la API: siempre 200; los problemas de la expresión llegan en `issues`.
    const c = compile(b);
    if ('issue' in c) return reply(SchedulePreviewResponseSchema, { cronExpressions: b.cronExpressions ?? [], description: null, timezone: b.timezone, occurrences: [], issues: [c.issue] });
    const after = b.after ? new Date(b.after) : new Date();
    return reply(SchedulePreviewResponseSchema, { cronExpressions: c.cronExpressions, description: c.description, timezone: b.timezone, occurrences: previewOccurrences(c.cronExpressions, b.timezone, after, b.count), issues: [] });
  }),
  http.post(`${API}/schedules`, async ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const b = validate(ScheduleCreateSchema, await body(request));
    if (isResp(b)) return b;
    const c = compile(b);
    if ('issue' in c) return err(422, c.issue.code, c.issue.message, { issues: [{ path: [b.editor ? 'editor' : 'cronExpressions'], code: c.issue.code, message: c.issue.message }] });
    if (!db.environments.some((e) => e.id === b.environmentId)) return err(422, 'SELECTION_FOREIGN_IDS', 'La selección contiene IDs inexistentes o ajenos al proyecto.');
    const now = new Date().toISOString();
    const s: Schedule = {
      id: db.uuid(),
      name: b.name,
      selector: selectorOf(b),
      suiteId: b.suiteId ?? null,
      environmentId: b.environmentId,
      editor: b.editor ?? null,
      cronExpressions: c.cronExpressions,
      description: c.description,
      windowStart: c.windowStart,
      windowEnd: c.windowEnd,
      timezone: b.timezone,
      retries: b.retries,
      enabled: b.enabled,
      pausedAt: b.enabled ? null : now,
      notify: b.notify,
      revision: 1,
      createdBy: { id: g.id, kind: 'panel_user', displayName: g.name },
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      nextOccurrence: null,
      lastOccurrence: null,
      version: 1,
    };
    db.schedules.push(s);
    emit('schedule.updated', 'schedule', s.id, 1, null, {});
    return replySchedule(s, 201);
  }),
  http.put(`${API}/schedules/:id`, async ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const s = db.scheduleById(String(params.id));
    if (!s || s.deletedAt) return notFound();
    const b = validate(ScheduleUpdateSchema, await body(request));
    if (isResp(b)) return b;
    if (b.revision !== s.revision) return err(409, 'VERSION_CONFLICT', 'El recurso cambió desde que lo leíste; recarga antes de guardar.');
    const c = compile(b);
    if ('issue' in c) return err(422, c.issue.code, c.issue.message, { issues: [{ path: [b.editor ? 'editor' : 'cronExpressions'], code: c.issue.code, message: c.issue.message }] });
    Object.assign(s, {
      name: b.name,
      selector: selectorOf(b),
      suiteId: b.suiteId ?? null,
      environmentId: b.environmentId,
      editor: b.editor ?? null,
      cronExpressions: c.cronExpressions,
      description: c.description,
      windowStart: c.windowStart,
      windowEnd: c.windowEnd,
      timezone: b.timezone,
      retries: b.retries,
      enabled: b.enabled,
      notify: b.notify,
      revision: s.revision + 1,
      version: s.version + 1,
      updatedAt: new Date().toISOString(),
    });
    emit('schedule.updated', 'schedule', s.id, s.revision, null, {});
    return replySchedule(s);
  }),
  http.delete(`${API}/schedules/:id`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const s = db.scheduleById(String(params.id));
    if (!s || s.deletedAt) return notFound();
    s.deletedAt = new Date().toISOString();
    s.revision += 1;
    emit('schedule.updated', 'schedule', s.id, s.revision, null, {});
    return reply(OkResponseSchema, { ok: true });
  }),
  ...(['pause', 'resume'] as const).map((op) =>
    http.post(`${API}/schedules/:id/${op}`, ({ request, params }) => {
      const g = guard(request);
      if (isResp(g)) return g;
      const s = db.scheduleById(String(params.id));
      if (!s || s.deletedAt) return notFound();
      s.enabled = op === 'resume';
      s.pausedAt = op === 'pause' ? new Date().toISOString() : null;
      s.revision += 1;
      emit('schedule.updated', 'schedule', s.id, s.revision, null, {});
      return replySchedule(s);
    }),
  ),
  http.post(`${API}/schedules/:id/duplicate`, async ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const s = db.scheduleById(String(params.id));
    if (!s || s.deletedAt) return notFound();
    const b = await body<{ name?: string }>(request);
    const now = new Date().toISOString();
    const copy: Schedule = { ...s, id: db.uuid(), name: b.name ?? `${s.name} (copia)`, enabled: false, pausedAt: now, revision: 1, version: 1, createdBy: { id: g.id, kind: 'panel_user', displayName: g.name }, createdAt: now, updatedAt: now };
    db.schedules.push(copy);
    return replySchedule(copy, 201);
  }),
  http.get(`${API}/schedules/:id/next`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const s = db.scheduleById(String(params.id));
    if (!s || s.deletedAt) return notFound();
    const url = new URL(request.url);
    const count = Math.min(Math.max(Number(url.searchParams.get('count') ?? 5) || 5, 1), 50);
    const after = url.searchParams.get('after');
    return reply(ScheduleNextResponseSchema, { timezone: s.timezone, revision: s.revision, occurrences: s.enabled ? previewOccurrences(s.cronExpressions, s.timezone, after ? new Date(after) : new Date(), count) : [] });
  }),
  http.get(`${API}/schedules/:id/revisions`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const s = db.scheduleById(String(params.id));
    if (!s) return notFound();
    const items = Array.from({ length: s.revision }, (_, i) => ({
      scheduleId: s.id,
      revision: s.revision - i,
      changedBy: i === s.revision - 1 ? s.createdBy : { id: db.users[2]!.id, kind: 'panel_user' as const, displayName: db.users[2]!.name },
      changedAt: new Date(Date.now() - i * 3 * DAY).toISOString(),
      action: (i === s.revision - 1 ? 'create' : s.enabled ? 'update' : 'pause') as 'create' | 'update' | 'pause',
      diff: i === s.revision - 1 ? {} : { cronExpressions: { from: ['0 9 * * 1-5'], to: s.cronExpressions } },
    }));
    return replyPage(ScheduleRevisionSchema, page(items, new URL(request.url)));
  }),
  http.get(`${API}/schedules/:id/occurrences`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const s = db.scheduleById(String(params.id));
    if (!s) return notFound();
    const url = new URL(request.url);
    let items = Array.from({ length: 12 }, (_, i) => {
      const skipped = i % 5 === 2;
      return {
        id: db.uuid(db.mulberry32(i + s.revision * 97)),
        scheduleId: s.id,
        scheduleRevision: s.revision,
        scheduledFor: new Date(Date.now() - (i + 1) * DAY).toISOString(),
        status: skipped ? ('omitida' as const) : ('admitida' as const),
        reason: skipped ? ('solapamiento' as const) : null,
        runId: skipped ? null : (db.runs[i]?.id ?? null),
        admissionDelayMs: skipped ? null : 800 + i * 40,
        createdAt: new Date(Date.now() - (i + 1) * DAY).toISOString(),
      };
    });
    const st = url.searchParams.get('status');
    if (st) items = items.filter((o) => o.status === st);
    return replyPage(ScheduleOccurrenceSchema, page(items, url));
  }),

  // ---------------- Rendimiento
  http.get(`${API}/perf`, ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const url = new URL(request.url);
    const from = Date.parse(url.searchParams.get('from') ?? '');
    const to = Date.parse(url.searchParams.get('to') ?? '');
    const envId = url.searchParams.get('environmentId');
    if (!envId || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) return err(422, 'VALIDATION_FAILED', 'La solicitud no cumple el esquema.');
    const by = (url.searchParams.get('by') ?? 'hour') as 'hour' | 'day';
    const compare = url.searchParams.get('compare') === 'previous_period';
    const out: PerfResponse = {
      granularity: by,
      series: db.PERF_SERIES.slice(0, 3).map((s) => ({
        key: { environmentId: envId, endpointKey: s.endpointKey, provenance: 'dxmon', source: s.source, metricKind: s.metricKind, cacheMode: 'desconocida', workerProfile: null },
        points: perfPoints(s, from, Math.min(to, Date.now()), by),
        comparison: compare ? perfPoints(s, from - (to - from), Math.min(to, Date.now()) - (to - from), by, 1).map((p) => ({ ...p, bucketStart: new Date(Date.parse(p.bucketStart) + (to - from)).toISOString() })) : null,
      })),
      marks: db.marks.filter((m) => m.environmentId === envId && Date.parse(m.ts) >= from && Date.parse(m.ts) <= to),
      lastSampleAt: new Date(Date.now() - 4 * 60_000).toISOString(),
      gaps: [],
    };
    return reply(PerfResponseSchema, out);
  }),
  http.get(`${API}/perf/series`, ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const url = new URL(request.url);
    const envId = url.searchParams.get('environmentId');
    if (!envId) return err(422, 'VALIDATION_FAILED', 'La solicitud no cumple el esquema.');
    const q = url.searchParams.get('q')?.toLowerCase();
    const items = db.PERF_SERIES.filter((s) => !q || s.endpointKey.toLowerCase().includes(q)).map((s) => ({
      environmentId: envId,
      endpointKey: s.endpointKey,
      provenance: 'dxmon',
      source: s.source,
      metricKind: s.metricKind,
      cacheMode: 'desconocida',
      workerProfile: null,
      sampleCount: s.screen === 'Instalaciones' ? 12 : 480,
      lastSampleAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    }));
    return replyPage(PerfSeriesItemSchema, page(items, url));
  }),
  http.get(`${API}/perf/errors`, ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const base = db.startOfToday();
    const items = [
      { kind: 'http_error', code: 504, t: 11 * HOUR + 12 * 60_000, ep: 'GET warehouse/list/scheduling', ms: 30_000 },
      { kind: 'http_error', code: 504, t: 15 * HOUR + 3 * 60_000, ep: 'GET warehouse/list/scheduling', ms: 30_000 },
      { kind: 'http_error', code: 500, t: 16 * HOUR + 40 * 60_000, ep: 'GET loadingOrder/filter', ms: 1_200 },
      { kind: 'over_29s', code: 200, t: 17 * HOUR + 12 * 60_000 + 4_000, ep: 'GET warehouse/list/scheduling', ms: 61_000 },
      { kind: 'timeout', code: null, t: 13 * HOUR + 30 * 60_000, ep: 'GET loadingOrder/filter', ms: null },
    ]
      .filter((x) => base + x.t <= Date.now() + DAY)
      .map((x, i) => ({ id: db.uuid(db.mulberry32(i + 11)), ts: new Date(base + x.t).toISOString(), runId: db.runs[0]!.id, endpointKey: x.ep, provenance: 'dxmon' as const, source: 'ui' as const, kind: x.kind as 'http_error', statusCode: x.code, totalMs: x.ms, censoredAtMs: x.kind === 'timeout' ? 20_000 : null }));
    const url = new URL(request.url);
    const kind = url.searchParams.get('kind');
    return replyPage(PerfErrorItemSchema, page(kind ? items.filter((x) => x.kind === kind) : items, url));
  }),
  http.get(`${API}/perf/thresholds`, ({ request }) => {
    const g = guard(request, 'dev');
    if (isResp(g)) return g;
    const url = new URL(request.url);
    const env = url.searchParams.get('environmentId');
    return replyPage(PerfThresholdSchema, page(db.thresholds.filter((t) => !env || t.environmentId === env), url));
  }),
  http.post(`${API}/perf/thresholds`, async ({ request }) => {
    const g = guard(request, 'dev');
    if (isResp(g)) return g;
    const b = validate(PerfThresholdCreateSchema, await body(request));
    if (isResp(b)) return b;
    const now = new Date().toISOString();
    const t = { ...b, id: db.uuid(), unit: b.metric === 'p95' || b.metric === 'max' ? ('ms' as const) : ('ratio' as const), label: b.label ?? null, lastEvaluation: null, createdBy: { id: g.id, kind: 'panel_user' as const, displayName: g.name }, createdAt: now, updatedAt: now, version: 1 };
    db.thresholds.push(t as never);
    return reply(PerfThresholdSchema, t, 201);
  }),
  http.put(`${API}/perf/thresholds/:id`, async ({ request, params }) => {
    const g = guard(request, 'dev');
    if (isResp(g)) return g;
    const t = db.thresholds.find((x) => x.id === params.id);
    if (!t) return notFound();
    const b = validate(PerfThresholdUpdateSchema, await body(request));
    if (isResp(b)) return b;
    if (b.version !== t.version) return err(409, 'VERSION_CONFLICT', 'El recurso cambió desde que lo leíste; recarga antes de guardar.');
    Object.assign(t, b, { version: t.version + 1, updatedAt: new Date().toISOString() });
    return reply(PerfThresholdSchema, t);
  }),
  http.delete(`${API}/perf/thresholds/:id`, ({ request, params }) => {
    const g = guard(request, 'dev');
    if (isResp(g)) return g;
    const i = db.thresholds.findIndex((x) => x.id === params.id);
    if (i < 0) return notFound();
    db.thresholds.splice(i, 1);
    return reply(OkResponseSchema, { ok: true });
  }),
  http.get(`${API}/events`, ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const url = new URL(request.url);
    const env = url.searchParams.get('environmentId');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const list = db.marks.filter((m) => (!env || m.environmentId === env) && (!from || m.ts >= from) && (!to || m.ts < to));
    return replyPage(EventMarkSchema, page(list, url));
  }),
  http.post(`${API}/events`, async ({ request }) => {
    const g = guard(request, 'dev');
    if (isResp(g)) return g;
    const b = validate(EventMarkCreateSchema, await body(request));
    if (isResp(b)) return b;
    const m = { id: db.uuid(), ts: b.ts, label: b.label, environmentId: b.environmentId, frontendVersion: b.frontendVersion ?? null, backendVersion: b.backendVersion ?? null, createdBy: { id: g.id, kind: 'panel_user' as const, displayName: g.name }, createdAt: new Date().toISOString() };
    db.marks.push(m);
    return reply(EventMarkSchema, m, 201);
  }),

  // ---------------- Alertas, entregas, auditoría, usuarios
  http.get(`${API}/alerts`, ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const url = new URL(request.url);
    const f = (k: string) => url.searchParams.get(k);
    const list = db.alerts.filter(
      (a) =>
        (!f('status') || a.status === f('status')) &&
        (!f('kind') || a.kind === f('kind')) &&
        (!f('environmentId') || a.environmentId === f('environmentId')) &&
        (!f('thresholdId') || a.thresholdId === f('thresholdId')) &&
        (!f('from') || a.createdAt >= f('from')!) &&
        (!f('to') || a.createdAt < f('to')!),
    );
    return replyPage(AlertSchema, page(list, url));
  }),
  http.get(`${API}/alerts/:id`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const a = db.alerts.find((x) => x.id === params.id);
    return a ? reply(AlertSchema, a) : notFound();
  }),
  http.get(`${API}/integrations/testrail/deliveries`, ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const url = new URL(request.url);
    const st = all(url, 'status');
    const op = url.searchParams.get('operation');
    const runId = url.searchParams.get('runId');
    const list = db.deliveries.filter((d) => (!st.length || st.includes(d.status)) && (!op || d.operation === op) && (!runId || d.runId === runId));
    return replyPage(OutboxDeliverySchema, page(list, url));
  }),
  http.post(`${API}/integrations/testrail/deliveries/:id/retry`, ({ request, params }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    const d = db.deliveries.find((x) => x.id === params.id);
    if (!d) return notFound();
    if (d.status === 'entregada') return err(409, 'DELIVERY_NOT_RETRYABLE', 'La entrega no está en un estado reintentable.');
    Object.assign(d, { status: 'en_proceso', attempts: d.attempts + 1, updatedAt: new Date().toISOString() });
    setTimeout(() => {
      Object.assign(d, { status: 'entregada', lastError: null, lastHttpStatus: 200, nextAttemptAt: null });
      emit('sync.updated', 'run_testrail_target', d.targetId ?? d.id, Date.now(), d.runId, {});
    }, 2500);
    return reply(DeliveryRetryResponseSchema, { delivery: d, reconciliation: 'no_aplicada' });
  }),
  http.get(`${API}/audit-log`, ({ request }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    const url = new URL(request.url);
    const f = (k: string) => url.searchParams.get(k);
    const list = db.audit.filter(
      (a) =>
        (!f('action') || a.action === f('action')) &&
        (!f('entity') || a.entity === f('entity')) &&
        (!f('entityId') || a.entityId === f('entityId')) &&
        (!f('actorId') || a.actorId === f('actorId')) &&
        (!f('from') || a.createdAt >= f('from')!) &&
        (!f('to') || a.createdAt < f('to')!),
    );
    return replyPage(AuditEntrySchema, page(list, url));
  }),
  http.get(`${API}/users`, ({ request }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    const url = new URL(request.url);
    const q = url.searchParams.get('q')?.toLowerCase();
    const role = url.searchParams.get('role');
    let list = db.users.filter((u) => (url.searchParams.get('includeDisabled') === 'true' || !u.disabledAt) && (!role || u.role === role) && (!q || u.email.includes(q) || u.name.toLowerCase().includes(q)));
    list = sortBy(list, url.searchParams.get('sort') ?? 'email', { email: (u) => u.email, name: (u) => u.name, createdAt: (u) => u.createdAt }, (u) => u.id);
    return replyPage(PanelUserSchema, page(list, url));
  }),
  http.post(`${API}/users`, async ({ request }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    const b = validate(PanelUserCreateSchema, await body(request));
    if (isResp(b)) return b;
    if (db.userByEmail(b.email)) return err(409, 'EMAIL_TAKEN', 'Ya existe un usuario con ese correo.');
    const u: PanelUser = { id: db.uuid(), email: b.email.toLowerCase(), name: b.name, role: b.role, hasLocalPassword: !!b.initialPassword, authSubject: null, disabledAt: null, lastLoginAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: 1 };
    db.users.push(u);
    return reply(PanelUserSchema, u, 201);
  }),
  http.get(`${API}/users/:id`, ({ request, params }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    const u = db.users.find((x) => x.id === params.id);
    return u ? reply(PanelUserSchema, u) : notFound();
  }),
  http.put(`${API}/users/:id`, async ({ request, params }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    const u = db.users.find((x) => x.id === params.id);
    if (!u) return notFound();
    const b = validate(PanelUserUpdateSchema, await body(request));
    if (isResp(b)) return b;
    if (b.version !== u.version) return err(409, 'VERSION_CONFLICT', 'El recurso cambió desde que lo leíste; recarga antes de guardar.');
    const admins = db.users.filter((x) => x.role === 'admin' && !x.disabledAt);
    if (u.role === 'admin' && !u.disabledAt && admins.length === 1 && ((b.role && b.role !== 'admin') || b.disabled)) return err(409, 'LAST_ADMIN', 'No puede quitarse el último administrador activo.');
    if (b.role) u.role = b.role;
    if (b.name) u.name = b.name;
    if (b.disabled !== undefined) u.disabledAt = b.disabled ? new Date().toISOString() : null;
    u.version += 1;
    u.updatedAt = new Date().toISOString();
    return reply(PanelUserSchema, u);
  }),

  // ---------------- Notificaciones
  http.get(`${API}/notifications/channels`, ({ request }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    return reply(z.object({ items: z.array(NotificationChannelSchema) }), { items: db.channels });
  }),
  http.put(`${API}/notifications/channels/:kind`, async ({ request, params }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    const c = db.channels.find((x) => x.kind === params.kind);
    if (!c) return notFound();
    const b = validate(NotificationChannelUpdateSchema, await body(request));
    if (isResp(b)) return b;
    if (b.version !== undefined && b.version !== c.version) return err(409, 'VERSION_CONFLICT', 'El recurso cambió desde que lo leíste; recarga antes de guardar.');
    if (b.smtp && c.kind !== 'correo') return err(422, 'VALIDATION_FAILED', 'SMTP solo aplica al correo.');
    const secretRef = b.secretRef === undefined ? c.secretRef : b.secretRef;
    const recipients = b.recipients ?? c.recipients;
    const smtp = b.smtp === undefined ? c.smtp : b.smtp;
    const configured = c.kind === 'correo' ? smtp !== null : secretRef !== null;
    if (b.enabled && !configured) return err(422, 'CHANNEL_NOT_CONFIGURED', 'El canal de notificación no está configurado.');
    Object.assign(c, { enabled: b.enabled, secretRef, recipients, smtp, version: c.version + 1, updatedAt: new Date().toISOString() });
    return reply(NotificationChannelSchema, c);
  }),
  http.post(`${API}/notifications/channels/:kind/test`, ({ request, params }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    const c = db.channels.find((x) => x.kind === params.kind);
    if (!c) return notFound();
    const configured = c.kind === 'correo' ? c.smtp !== null : c.secretRef !== null;
    if (!configured) return err(422, 'CHANNEL_NOT_CONFIGURED', 'El canal de notificación no está configurado.');
    c.lastTestAt = new Date().toISOString();
    c.lastTestOk = true;
    return reply(NotificationChannelTestResponseSchema, { ok: true, ambiguous: false, message: 'Mensaje de prueba enviado.' });
  }),
  http.get(`${API}/notifications/preferences`, ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const p = db.preferences.get(g.id) ?? { userId: g.id, channels: [], events: [], scheduleIds: [], allSchedules: false, thresholdIds: [], allThresholds: false, updatedAt: new Date(0).toISOString(), version: 0 };
    return reply(NotificationPreferencesSchema, p);
  }),
  http.put(`${API}/notifications/preferences`, async ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const b = validate(NotificationPreferencesUpdateSchema, await body(request));
    if (isResp(b)) return b;
    const prev = db.preferences.get(g.id);
    if (prev && b.version !== undefined && b.version !== prev.version) return err(409, 'VERSION_CONFLICT', 'El recurso cambió desde que lo leíste; recarga antes de guardar.');
    const { version: _v, ...rest } = b;
    void _v;
    const p = { userId: g.id, ...rest, updatedAt: new Date().toISOString(), version: (prev?.version ?? 0) + 1 };
    db.preferences.set(g.id, p);
    return reply(NotificationPreferencesSchema, p);
  }),

  // ---------------- Exportaciones
  http.post(`${API}/exports`, async ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const b = validate(ExportCreateSchema, await body(request));
    if (isResp(b)) return b;
    if (b.scope === 'audit_log' && g.role !== 'admin') return err(403, 'FORBIDDEN', 'No tienes permiso para esta operación.');
    const now = new Date().toISOString();
    const job: ExportJob = { id: db.uuid(), format: b.format, scope: b.scope, extent: b.extent, status: 'pendiente', rowCount: null, sizeBytes: null, error: null, expiresAt: null, createdAt: now, finishedAt: null };
    exportsDb.set(job.id, { job, ownerId: g.id });
    const done = () => Object.assign(job, { status: 'listo', rowCount: b.extent === 'pagina' ? (b.limit ?? 25) : db.runs.length, sizeBytes: 18_432, finishedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + DAY).toISOString() });
    // `pagina`: se genera dentro de la solicitud (201 listo). `completo`: trabajo diferido (202 pendiente).
    if (b.extent === 'pagina') {
      done();
      return reply(ExportJobSchema, job, 201);
    }
    setTimeout(() => {
      job.status = 'en_proceso';
      emit('export.updated', 'export_job', job.id, 1, null, { ownerId: g.id });
    }, 300);
    setTimeout(() => {
      done();
      emit('export.updated', 'export_job', job.id, 2, null, { ownerId: g.id });
    }, 1500);
    return reply(ExportJobSchema, job, 202);
  }),
  http.get(`${API}/exports/:id`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const x = exportsDb.get(String(params.id));
    return x && (x.ownerId === g.id || g.role === 'admin') ? reply(ExportJobSchema, x.job) : notFound();
  }),
  http.get(`${API}/exports/:id/download`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const x = exportsDb.get(String(params.id));
    if (!x || (x.ownerId !== g.id && g.role !== 'admin')) return notFound();
    if (x.job.status === 'pendiente' || x.job.status === 'en_proceso') return err(409, 'CONFLICT', 'La exportación aún se está generando.');
    if (x.job.status !== 'listo') return notFound('La exportación no está disponible o venció.');
    const mime = x.job.format === 'csv' ? 'text/csv' : 'application/pdf';
    return reply(ExportDownloadResponseSchema, { url: `data:${mime};charset=utf-8,${encodeURIComponent('id,estado\n')}`, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() });
  }),

  // ---------------- Grabación y dispositivos (el asistente local graba; el panel crea, observa y cancela)
  http.post(`${API}/recordings`, async ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const b = validate(RecordingCreateSchema, await body(request));
    if (isResp(b)) return b;
    const c = db.caseById(b.caseId);
    if (!c) return notFound('Caso inexistente.');
    if (c.archivedAt) return err(422, 'CASE_ARCHIVED', 'El caso está archivado.');
    const env = db.environments.find((e) => e.id === b.environmentId);
    if (!env) return notFound('Ambiente inexistente.');
    if (!env.enabled) return err(422, 'ENVIRONMENT_DISABLED', 'El ambiente está deshabilitado.');
    if (env.isProduction || !env.recordingAllowed) return err(422, 'RECORDING_PRODUCTION_BLOCKED', 'No se permite grabar en producción ni en ambientes sin grabación habilitada.');
    const now = new Date().toISOString();
    const r = recordingDetail({ id: db.uuid(), caseId: c.id, caseRef: c.ref, environmentId: env.id, createdBy: g.id, deviceId: null, status: 'creada', tags: b.tags, expiresAt: new Date(Date.now() + 2 * HOUR).toISOString(), branch: null, prUrl: null, commit: null, rejectionReasons: [], steps: [], createdAt: now, updatedAt: now });
    db.recordings.push(r);
    if (db.deviceState.linked) simulateRecording(r);
    return reply(RecordingCreatedSchema, { recording: r, assistantLink: `katalyst://grabar?session=${r.id}`, assistant: { linked: db.deviceState.linked, online: db.deviceState.online, installUrl: INSTALL_URL } }, 201);
  }),
  http.get(`${API}/recordings`, ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const url = new URL(request.url);
    const st = url.searchParams.get('status');
    const caseId = url.searchParams.get('caseId');
    const list = db.recordings.filter((r) => (r.createdBy === g.id || g.role === 'admin') && (!st || r.status === st) && (!caseId || r.caseId === caseId));
    return replyPage(RecordingDetailSchema, page([...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), url));
  }),
  http.get(`${API}/recordings/:id`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const r = db.recordings.find((x) => x.id === params.id);
    if (!r || (r.createdBy !== g.id && g.role !== 'admin')) return notFound();
    return reply(RecordingDetailSchema, recordingDetail(r));
  }),
  http.post(`${API}/recordings/:id/cancel`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const r = db.recordings.find((x) => x.id === params.id);
    if (!r || (r.createdBy !== g.id && g.role !== 'admin')) return notFound();
    if (r.status === 'cancelada') return reply(RecordingDetailSchema, recordingDetail(r));
    if (['pr_abierto', 'rechazada', 'vencida'].includes(r.status)) return err(409, 'RECORDING_INVALID_STATE', 'La grabación no admite esta transición.');
    r.status = 'cancelada';
    r.updatedAt = new Date().toISOString();
    emit('recording.updated', 'recording_session', r.id, Date.now(), null, { ownerId: r.createdBy, status: r.status });
    return reply(RecordingDetailSchema, recordingDetail(r));
  }),
  http.get(`${API}/devices/status`, ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const d = db.devices.find((x) => !x.revokedAt);
    return reply(DeviceStatusResponseSchema, { linked: db.deviceState.linked, online: db.deviceState.online, lastSeenAt: db.deviceState.online ? new Date().toISOString() : (d?.lastSeenAt ?? null), clientVersion: d?.clientVersion ?? null, installUrl: INSTALL_URL });
  }),
  http.get(`${API}/devices`, ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    return reply(z.object({ items: z.array(DeviceSchema) }), { items: db.devices.filter((d) => !d.revokedAt) });
  }),
  http.delete(`${API}/devices/:id`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const d = db.devices.find((x) => x.id === params.id);
    if (!d) return notFound();
    d.revokedAt = new Date().toISOString();
    db.deviceState.linked = db.devices.some((x) => !x.revokedAt);
    db.deviceState.online = db.deviceState.linked;
    return reply(OkResponseSchema, { ok: true });
  }),
  http.get(`${API}/devices/authorizations/:userCode`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const a = db.deviceAuthorizations.get(String(params.userCode).toUpperCase());
    if (!a) return notFound();
    if (a.status === 'pendiente' && Date.parse(a.expiresAt) <= Date.now()) a.status = 'vencida';
    return reply(DeviceAuthorizationViewSchema, a);
  }),
  ...(['approve', 'deny'] as const).map((op) =>
    http.post(`${API}/devices/${op}`, async ({ request }) => {
      const g = guard(request);
      if (isResp(g)) return g;
      const b = await body<{ userCode?: string }>(request);
      if (!b.userCode || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(b.userCode)) return err(422, 'VALIDATION_FAILED', 'La solicitud no cumple el esquema.', { issues: [{ path: ['userCode'], code: 'invalid_format', message: 'Formato XXXX-XXXX' }] });
      const a = db.deviceAuthorizations.get(b.userCode);
      if (!a) return notFound();
      if (a.status === 'pendiente' && Date.parse(a.expiresAt) <= Date.now()) a.status = 'vencida';
      const decision = op === 'approve' ? 'aprobada' : 'denegada';
      if (a.status === 'vencida') return err(400, 'DEVICE_CODE_EXPIRED', 'El código de dispositivo venció.');
      if (a.status === decision && decidedBy.get(a.userCode) === g.id) return reply(OkResponseSchema, { ok: true });
      if (a.status !== 'pendiente') return err(409, 'CONFLICT', 'La solicitud ya fue resuelta.');
      a.status = decision;
      decidedBy.set(a.userCode, g.id);
      if (op === 'approve') {
        db.devices.push({ id: db.uuid(), name: `${a.clientName} (${a.platform})`, platform: a.platform, clientVersion: a.clientVersion, createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 90 * DAY).toISOString(), revokedAt: null });
        db.deviceState.linked = true;
        db.deviceState.online = true;
      }
      return reply(OkResponseSchema, { ok: true });
    }),
  ),

  // ---------------- IA (dev): 201 `en_proceso` → `listo|fallido` por SSE `generation.updated`
  ...(['create', 'review'] as const).map((op) =>
    http.post(op === 'create' ? `${API}/generate` : `${API}/generate/review`, async ({ request }) => {
      const g = guard(request, 'dev');
      if (isResp(g)) return g;
      const b = await body<{ caseId?: string; recordingId?: string }>(request);
      const c = op === 'create' ? db.caseById(b.caseId ?? '') : null;
      if (op === 'create' && !c) return notFound('Caso inexistente.');
      if (op === 'review' && !db.recordings.some((r) => r.id === b.recordingId)) return notFound();
      const gen: GenerationRequest = { id: db.uuid(), kind: op === 'create' ? 'borrador_desde_caso' : 'revision_grabacion', status: 'en_proceso', caseId: c?.id ?? null, recordingId: b.recordingId ?? null, provider: 'anthropic', model: 'claude', promptVersion: 'v1', inputTokens: null, outputTokens: null, costUsd: null, result: null, error: null, createdBy: g.id, createdAt: new Date().toISOString(), finishedAt: null };
      genDb.set(gen.id, gen);
      setTimeout(() => {
        Object.assign(gen, {
          status: 'listo',
          finishedAt: new Date().toISOString(),
          inputTokens: 1840,
          outputTokens: 420,
          costUsd: 0.012,
          result: {
            code: `test('${c?.ref ?? 'C0'} ${c?.title ?? ''}', {\n  tag: ${JSON.stringify(c?.tags ?? [])},\n  annotation: { type: 'clasificacion', description: 'lectura' },\n}, async ({ page }) => {\n  await page.goto('/schedulings');\n  // TODO selector: confirmar el rol de la vista calendario\n  await expect(page.getByRole('grid')).toBeVisible();\n});`,
            todos: 1,
            changes: ['Esperas por condición en lugar de tiempos fijos'],
            needsHumanReview: ['Confirmar selector de la vista calendario'],
            branch: null,
            prUrl: null,
            file: c ? `tests/${c.ref.toLowerCase()}.spec.ts` : null,
          },
        });
        emit('generation.updated', 'generation_request', gen.id, 2, null, { ownerId: g.id, status: 'listo' });
      }, 2000);
      return reply(GenerationDetailSchema, gen, 201);
    }),
  ),
  http.get(`${API}/generate/:id`, ({ request, params }) => {
    const g = guard(request, 'dev');
    if (isResp(g)) return g;
    const x = genDb.get(String(params.id));
    return x && (x.createdBy === g.id || g.role === 'admin') ? reply(GenerationDetailSchema, x) : notFound();
  }),

  // ---------------- SSE
  http.get(`${API}/events/stream`, ({ request }) => {
    const u = currentUser();
    if (!u) return err(401, 'UNAUTHENTICATED', 'Se requiere autenticación.');
    void currentSeq;
    const topics = new URL(request.url).searchParams.getAll('topics').flatMap((t) => t.split(',')).filter(Boolean);
    return new HttpResponse(sseStream(request.headers.get('Last-Event-ID'), topics.length ? new Set(topics) : null), {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' },
    });
  }),
];

const INSTALL_URL = 'https://descargas.deltax.la/katalyst-asistente-setup.exe';
const exportsDb = new Map<string, { job: ExportJob; ownerId: string }>();
const decidedBy = new Map<string, string>();
const genDb = new Map<string, GenerationRequest>();

/** Simula el asistente local: vincula, graba pasos, el QA agrega la verificación en el asistente y envía el PR. */
function simulateRecording(r: RecordingSession) {
  const steps: { delay: number; apply: () => void }[] = [
    { delay: 1500, apply: () => { r.status = 'vinculada'; r.deviceId = db.devices.find((d) => !d.revokedAt)?.id ?? null; } },
    { delay: 3000, apply: () => { r.status = 'grabando'; r.steps.push({ kind: 'accion', description: 'goto /schedulings' }); } },
    { delay: 5000, apply: () => { r.steps.push({ kind: 'accion', description: 'click tab "Lista"' }); } },
    { delay: 7000, apply: () => { r.steps.push({ kind: 'verificacion', description: 'expect grid "Agendamientos" visible' }); } },
    { delay: 10_000, apply: () => { r.status = 'validando'; } },
    {
      delay: 12_500,
      apply: () => {
        r.status = 'pr_abierto';
        r.branch = `grabacion/${r.caseRef.toLowerCase()}-${r.id.slice(0, 6)}`;
        r.prUrl = 'https://github.com/deltax/qa-tests/pull/84';
        r.commit = db.MAIN_COMMIT_SHA;
      },
    },
  ];
  for (const s of steps) {
    setTimeout(() => {
      if (r.status === 'cancelada') return;
      s.apply();
      r.updatedAt = new Date().toISOString();
      emit('recording.updated', 'recording_session', r.id, Date.now(), null, { ownerId: r.createdBy, status: r.status });
    }, s.delay);
  }
}
