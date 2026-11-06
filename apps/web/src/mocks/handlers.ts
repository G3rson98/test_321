/**
 * Handlers MSW tipados con los DTO de @katalyst/shared. Implementan filtros, orden y paginación por cursor como
 * lo haría la API (ESP §17.3), errores uniformes `{ error: { code, message, requestId } }`, CSRF en mutaciones e
 * Idempotency-Key en `POST /runs`. Incluyen los endpoints PENDIENTES del panel (marcados).
 */
import { http, HttpResponse, type DefaultBodyType, type StrictRequest } from 'msw';
import { decodeCursor, encodeCursor } from '@katalyst/shared/schemas';
import { previewOccurrences, nextOccurrence, buildCronExpressions, ScheduleBuildError, validateSchedule } from '@katalyst/shared/schedule';
import type { RunResultStatus } from '@katalyst/shared/enums';
import type {
  CaseRow,
  DashboardSummary,
  Me,
  PanelUser,
  PerfResponse,
  PerfSummaryRow,
  RunPreview,
  RunSummary,
  Schedule,
  Suite,
  ExportJob,
  GenerationRequest,
  RecordingSession,
  SyncRun,
  TestUser,
} from '@/lib/api/types';
import * as db from './data/seed';
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
    permissions: [],
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
  return { items: slice, nextCursor: hasNext ? encodeCursor({ o: offset + limit }) : null, hasNext, total: items.length };
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

function caseRow(c: db.MockCase): CaseRow {
  const { steps: _s, expected: _e, contentHash: _h, customFields: _c, links: _l, revisions: _r, testIds: _t, ...row } = c;
  void _s; void _e; void _h; void _c; void _l; void _r; void _t;
  return row;
}
function runSummary(r: db.MockRun): RunSummary {
  const { snapshot: _a, runtimeVersions: _b, shards: _c, targets: _d, problems: _e, evidenceIncomplete: _f, results: _g, attempts: _h, caseResults: _i, artifacts: _j, ...s } = r;
  void _a; void _b; void _c; void _d; void _e; void _f; void _g; void _h; void _i; void _j;
  return s;
}
function runDetail(r: db.MockRun) {
  const { results: _g, attempts: _h, caseResults: _i, artifacts: _j, ...d } = r;
  void _g; void _h; void _i; void _j;
  return d;
}
function scheduleOut(s: Schedule): Schedule {
  const next = s.enabled && !s.deletedAt ? nextOccurrence(s.cronExpressions, s.timezone, new Date()) : null;
  return { ...s, nextOccurrence: next ? next.toISOString() : null, environmentName: db.environments.find((e) => e.id === s.environmentId)?.name ?? '' };
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
  const workers = Math.max(1, Math.min(env.maxConcurrency, executableTests));
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
    workers: executableTests > 0 ? workers : 0,
    estimatedDurationMs: executableTests > 0 ? Math.round((executableTests * 25_000) / workers) + 20_000 : null,
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
  http.get(`${API}/auth/providers`, () => HttpResponse.json({ local: true, oidc: { enabled: true, displayName: 'SSO de la empresa', loginUrl: '/api/v1/auth/oidc/start' } })),
  http.post(`${API}/auth/login`, async ({ request }) => {
    const b = await body<{ email?: string; password?: string }>(request);
    const email = (b.email ?? '').trim().toLowerCase();
    if (!email || !b.password) return err(422, 'VALIDATION_FAILED', 'La solicitud no cumple el esquema.', { issues: [{ path: ['email'], code: 'required', message: 'Requerido' }] });
    if (b.password === 'demasiados') return err(429, 'RATE_LIMITED', 'Demasiados intentos; espera antes de reintentar.', { retryAfterSeconds: 30 });
    const u = db.userByEmail(email);
    if (!u || b.password !== DEMO_PASSWORD) return err(401, 'INVALID_CREDENTIALS', 'Correo o contraseña incorrectos.');
    if (u.disabledAt) return err(403, 'USER_DISABLED', 'El usuario está deshabilitado.');
    mockLogin(email);
    return HttpResponse.json(me(u));
  }),
  http.post(`${API}/auth/logout`, () => {
    mockLogout();
    return HttpResponse.json({ ok: true });
  }),
  http.get(`${API}/auth/me`, () => {
    const u = currentUser();
    return u ? HttpResponse.json(me(u)) : err(401, 'UNAUTHENTICATED', 'Se requiere autenticación.');
  }),
  http.get(`${API}/auth/tokens`, ({ request }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    return HttpResponse.json(page(db.apiTokens, new URL(request.url)));
  }),
  http.post(`${API}/auth/tokens`, async ({ request }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    const b = await body<{ name: string; scopes: string[]; expiresAt: string }>(request);
    const t = { id: db.uuid(), name: b.name, kind: 'token_api' as const, principalId: g.id, scopes: b.scopes as never, hint: 'Ab12', expiresAt: b.expiresAt, revokedAt: null, lastUsedAt: null, createdAt: new Date().toISOString() };
    db.apiTokens.push(t);
    return HttpResponse.json({ credential: t, token: `kat_${crypto.randomUUID().replace(/-/g, '')}` }, { status: 201 });
  }),
  http.delete(`${API}/auth/tokens/:id`, ({ request, params }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    const t = db.apiTokens.find((x) => x.id === params.id);
    if (!t) return err(404, 'NOT_FOUND', 'Recurso inexistente o no visible.');
    t.revokedAt = new Date().toISOString();
    return new HttpResponse(null, { status: 204 });
  }),

  // ---------------- PENDIENTE: dashboard
  http.get(`${API}/dashboard/summary`, ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const today = db.startOfToday();
    const week = db.runs.filter((r) => Date.parse(r.createdAt) > Date.now() - 7 * DAY && r.outcome);
    const prev = db.runs.filter((r) => Date.parse(r.createdAt) <= Date.now() - 7 * DAY && Date.parse(r.createdAt) > Date.now() - 14 * DAY && r.outcome);
    const rate = (rs: db.MockRun[]) => (rs.length ? rs.filter((r) => r.outcome === 'pasado' || r.outcome === 'inestable').length / rs.length : null);
    const upcoming = db.schedules
      .filter((s) => s.enabled && !s.deletedAt)
      .map((s) => ({ s, at: nextOccurrence(s.cronExpressions, s.timezone, new Date()) }))
      .filter((x) => x.at)
      .sort((a, b) => a.at!.getTime() - b.at!.getTime())
      .slice(0, 3)
      .map(({ s, at }) => ({ scheduleId: s.id, name: s.name, environmentName: db.environments.find((e) => e.id === s.environmentId)!.name, at: at!.toISOString() }));
    const fixed = db.cases.filter((c) => c.trCaseId < 2000);
    const out: DashboardSummary = {
      successRate7d: rate(week),
      successRatePrev7d: rate(prev),
      runsToday: db.runs.filter((r) => Date.parse(r.createdAt) >= today).length,
      runningNow: db.runs.filter((r) => ['corriendo', 'preparando', 'finalizando'].includes(r.status)).length,
      coverage: { automated: fixed.filter((c) => c.automated).length, total: fixed.length },
      activeAlerts: db.alerts.filter((a) => a.status === 'activa').length,
      upcoming,
    };
    return HttpResponse.json(out);
  }),

  // ---------------- TestRail / catálogo
  http.get(`${API}/testrail/sections`, ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    return HttpResponse.json({
      items: db.sections.map((s) => ({ ...s, caseCount: db.cases.filter((c) => c.sectionId === s.id).length })),
      nextCursor: null,
      hasNext: false,
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
    if (lr) list = list.filter((c) => (lr === 'sin_ejecutar' ? !c.lastResult : c.lastResult?.status === lr));
    const ids = all(url, 'ids');
    if (ids.length) list = list.filter((c) => ids.includes(c.id));
    list = sortBy(list, url.searchParams.get('sort') ?? 'trCaseId', { title: (c) => c.title, trCaseId: (c) => c.trCaseId, syncedAt: (c) => c.syncedAt }, (c) => c.id);
    const p = page(list, url);
    return HttpResponse.json({ ...p, items: p.items.map(caseRow) });
  }),
  http.get(`${API}/testrail/cases/:id`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const c = db.caseById(String(params.id)) ?? db.caseByRef(String(params.id));
    if (!c) return err(404, 'NOT_FOUND', 'Caso no encontrado.');
    const { testIds: _t, ...detail } = c;
    void _t;
    return HttpResponse.json(detail);
  }),
  http.get(`${API}/testrail/cases/:id/history`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const c = db.caseById(String(params.id));
    if (!c) return err(404, 'NOT_FOUND', 'Caso no encontrado.');
    const items = db.runs
      .filter((r) => r.results.some((x) => x.caseIds.includes(c.id)) && r.finishedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 20)
      .map((r) => {
        const rr = r.results.find((x) => x.caseIds.includes(c.id))!;
        return { runId: r.id, environmentId: r.environment.id, status: rr.status, durationMs: rr.durationMs, retryCount: rr.retryCount, finishedAt: r.finishedAt };
      });
    const done = items.filter((i) => ['pasado', 'inestable', 'fallido'].includes(i.status));
    return HttpResponse.json({
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
    if (db.syncRuns[0]?.status === 'en_curso') return err(409, 'TESTRAIL_SYNC_IN_PROGRESS', 'Ya hay una sincronización en curso.');
    const s: SyncRun = { ...db.syncRuns[0]!, id: db.uuid(), status: 'en_curso', trigger: 'manual', startedAt: new Date().toISOString(), finishedAt: null, createdBy: g.id };
    db.syncRuns.unshift(s);
    emit('testrail.sync', 'testrail_sync_run', s.id, 1, null, {});
    setTimeout(() => {
      s.status = 'exitosa';
      s.finishedAt = new Date().toISOString();
      db.connection.lastSyncAt = s.finishedAt;
      emit('testrail.sync', 'testrail_sync_run', s.id, 2, null, {});
    }, 4000);
    return HttpResponse.json(s, { status: 202 });
  }),
  http.get(`${API}/testrail/sync-runs`, ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    return HttpResponse.json(page(db.syncRuns, new URL(request.url)));
  }),
  http.get(`${API}/testrail/connection`, ({ request }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    return HttpResponse.json(db.connection);
  }),
  http.put(`${API}/testrail/connection`, async ({ request }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    const b = await body<Partial<typeof db.connection>>(request);
    if (b.version !== undefined && b.version !== db.connection.version) return err(409, 'VERSION_CONFLICT', 'El recurso cambió desde que lo leíste; recarga antes de guardar.');
    if (b.baseUrl && !b.baseUrl.startsWith('https://')) return err(422, 'HOST_NOT_ALLOWED', 'El host o esquema de la URL no está permitido.', { issues: [{ path: ['baseUrl'], code: 'HOST_NOT_ALLOWED', message: 'Usa una URL HTTPS permitida.' }] });
    Object.assign(db.connection, b, { version: db.connection.version + 1, updatedAt: new Date().toISOString() });
    return HttpResponse.json(db.connection);
  }),
  http.post(`${API}/testrail/connection/test`, async ({ request }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    const b = await body<{ baseUrl?: string }>(request);
    const ok = !b.baseUrl || b.baseUrl.includes('testrail');
    return HttpResponse.json({
      ok,
      errorCode: ok ? null : 'HOST_NOT_ALLOWED',
      message: ok ? 'Conexión correcta: TestRail 9.1, proyecto encontrado, permisos de lectura y escritura de resultados.' : 'El host no está en la lista permitida.',
      testrailVersion: ok ? '9.1.2' : null,
      projects: ok ? [{ externalId: 7, name: 'FMS DeltaX' }, { externalId: 9, name: 'Portal clientes' }] : [],
      latencyMs: ok ? 184 : null,
    });
  }),
  http.get(`${API}/tests/:id`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const t = db.testById(String(params.id));
    return t ? HttpResponse.json(t) : err(404, 'NOT_FOUND', 'Test no encontrado.');
  }),
  // PENDIENTE [WEB→API-A]
  http.get(`${API}/tests/:id/source`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const t = db.testById(String(params.id));
    if (!t) return err(404, 'NOT_FOUND', 'Test no encontrado.');
    const code = t.title.startsWith('C1501') || t.title.startsWith('C1312')
      ? db.TEST_SOURCE
      : `test('${t.title}', {\n  tag: ${JSON.stringify(t.tags)},\n  annotation: { type: 'clasificacion', description: '${t.classification}' },\n}, async ({ page }) => {\n  await page.goto('/');\n  await expect(page.getByRole('main')).toBeVisible();\n});`;
    return HttpResponse.json({ testId: t.id, filePath: t.filePath, commit: `main@${db.MAIN_COMMIT_SHA.slice(0, 7)}`, code });
  }),
  // PENDIENTE [WEB→API-A]
  http.get(`${API}/catalog/tags`, ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    return HttpResponse.json({ items: ['@humo', '@oc', '@agendamiento', '@arranque', '@rendimiento'] });
  }),
  http.put(`${API}/tests/:id/case-links/:caseId/review`, async ({ request, params }) => {
    const g = guard(request, 'dev');
    if (isResp(g)) return g;
    const t = db.testById(String(params.id));
    const c = db.caseById(String(params.caseId));
    if (!t || !c) return err(404, 'NOT_FOUND', 'Vínculo inexistente.');
    const b = await body<{ caseRevision: number }>(request);
    if (b.caseRevision !== c.revision) return err(409, 'VERSION_CONFLICT', 'La revisión del caso cambió; recarga.');
    const l = t.caseLinks.find((x) => x.caseId === c.id);
    if (l) Object.assign(l, { reviewStatus: 'vigente', reviewedCaseRevision: c.revision, reviewedBy: g.id, reviewedAt: new Date().toISOString() });
    const cl = c.links.find((x) => x.automatedTestId === t.id);
    if (cl) Object.assign(cl, { reviewStatus: 'vigente', reviewedCaseRevision: c.revision });
    c.linksRequiringReview = 0;
    emit('catalog.updated', 'catalog_revision', c.id, Date.now(), null, {});
    return HttpResponse.json(l ?? {});
  }),

  // ---------------- Suites
  http.get(`${API}/suites`, ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const url = new URL(request.url);
    const q = url.searchParams.get('q')?.toLowerCase();
    let list = db.suites.filter((s) => !s.deletedAt);
    if (q) list = list.filter((s) => s.name.toLowerCase().includes(q));
    return HttpResponse.json(page(list, url));
  }),
  http.get(`${API}/suites/:id`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const s = db.suiteById(String(params.id));
    return s && !s.deletedAt ? HttpResponse.json(s) : err(404, 'NOT_FOUND', 'Suite no encontrada.');
  }),
  http.post(`${API}/suites`, async ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const b = await body<{ name: string; description?: string; selector: Suite['selector'] }>(request);
    if (db.suites.some((s) => !s.deletedAt && s.name.toLowerCase() === b.name?.trim().toLowerCase())) {
      return err(409, 'CONFLICT', 'Ya existe una suite con ese nombre.', { issues: [{ path: ['name'], code: 'CONFLICT', message: 'Ya existe una suite con ese nombre.' }] });
    }
    const resolved = db.resolveSelector(b.selector);
    const s: Suite = { id: db.uuid(), name: b.name, description: b.description ?? null, selector: b.selector, createdBy: g.id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null, version: 1, resolved: { cases: resolved.length, tests: resolved.filter((c) => c.automated).length }, lastOutcome: null, scheduleLabels: [] };
    db.suites.push(s);
    return HttpResponse.json(s, { status: 201 });
  }),
  http.put(`${API}/suites/:id`, async ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const s = db.suiteById(String(params.id));
    if (!s) return err(404, 'NOT_FOUND', 'Suite no encontrada.');
    const b = await body<{ name: string; description?: string; selector: Suite['selector']; version: number }>(request);
    if (b.version !== s.version) return err(409, 'VERSION_CONFLICT', 'La suite cambió desde que la abriste; recarga antes de guardar.');
    const resolved = db.resolveSelector(b.selector);
    Object.assign(s, { name: b.name, description: b.description ?? null, selector: b.selector, version: s.version + 1, updatedAt: new Date().toISOString(), resolved: { cases: resolved.length, tests: resolved.filter((c) => c.automated).length } });
    return HttpResponse.json(s);
  }),
  http.delete(`${API}/suites/:id`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const s = db.suiteById(String(params.id));
    if (!s) return err(404, 'NOT_FOUND', 'Suite no encontrada.');
    s.deletedAt = new Date().toISOString();
    return new HttpResponse(null, { status: 204 });
  }),

  // ---------------- Ambientes
  http.get(`${API}/environments`, ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const items = g.role === 'admin' ? db.environments : db.environments.map((e) => ({ ...db.envSummary(e), appUrl: e.appUrl }));
    return HttpResponse.json({ items, nextCursor: null, hasNext: false });
  }),
  http.get(`${API}/environments/:id`, ({ request, params }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    const e = db.environments.find((x) => x.id === params.id);
    return e ? HttpResponse.json(e) : err(404, 'NOT_FOUND', 'Ambiente no encontrado.');
  }),
  http.post(`${API}/environments`, async ({ request }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    const b = await body<Partial<(typeof db.environments)[number]>>(request);
    if (!b.appUrl?.startsWith('https://')) return err(422, 'HOST_NOT_ALLOWED', 'La URL debe ser HTTPS.', { issues: [{ path: ['appUrl'], code: 'HOST_NOT_ALLOWED', message: 'La URL debe ser HTTPS.' }] });
    const e = { ...db.environments[0]!, ...b, id: db.uuid(), version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), disabledAt: null } as (typeof db.environments)[number];
    db.environments.push(e);
    return HttpResponse.json(e, { status: 201 });
  }),
  http.put(`${API}/environments/:id`, async ({ request, params }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    const e = db.environments.find((x) => x.id === params.id);
    if (!e) return err(404, 'NOT_FOUND', 'Ambiente no encontrado.');
    const b = await body<Partial<typeof e>>(request);
    if (b.version !== e.version) return err(409, 'VERSION_CONFLICT', 'El ambiente cambió; recarga antes de guardar.');
    Object.assign(e, b, { version: e.version + 1, updatedAt: new Date().toISOString() });
    return HttpResponse.json(e);
  }),
  http.get(`${API}/environments/:id/users`, ({ request, params }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    return HttpResponse.json({ items: db.testUsers.filter((u) => u.environmentId === params.id), nextCursor: null, hasNext: false });
  }),
  http.post(`${API}/environments/:id/users`, async ({ request, params }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    const env = db.environments.find((x) => x.id === params.id);
    if (!env) return err(404, 'NOT_FOUND', 'Ambiente no encontrado.');
    const b = await body<Partial<TestUser>>(request);
    if (env.isProduction && !b.readOnly) return err(422, 'PRODUCTION_BLOCKED', 'Producción solo admite usuarios de solo lectura.', { issues: [{ path: ['readOnly'], code: 'PRODUCTION_BLOCKED', message: 'Producción solo admite usuarios de solo lectura.' }] });
    const u: TestUser = { id: db.uuid(), environmentId: env.id, label: b.label ?? '', username: b.username ?? '', secretRef: b.secretRef ?? '', readOnly: !!b.readOnly, allowsConcurrency: !!b.allowsConcurrency, enabled: b.enabled ?? true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: 1 };
    db.testUsers.push(u);
    return HttpResponse.json(u, { status: 201 });
  }),
  http.put(`${API}/environments/:id/users/:userId`, async ({ request, params }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    const u = db.testUsers.find((x) => x.id === params.userId);
    if (!u) return err(404, 'NOT_FOUND', 'Usuario no encontrado.');
    const b = await body<Partial<TestUser>>(request);
    Object.assign(u, b, { version: u.version + 1, updatedAt: new Date().toISOString() });
    return HttpResponse.json(u);
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
    list = sortBy(list, url.searchParams.get('sort') ?? '-createdAt', { createdAt: (r) => r.createdAt, finishedAt: (r) => r.finishedAt }, (r) => r.id);
    const p = page(list, url);
    return HttpResponse.json({ ...p, items: p.items.map(runSummary) });
  }),
  http.get(`${API}/runs/:id`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const r = db.runById(String(params.id));
    return r ? HttpResponse.json(runDetail(r)) : err(404, 'NOT_FOUND', 'Ejecución no encontrada.');
  }),
  http.get(`${API}/runs/:id/results`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const r = db.runById(String(params.id));
    if (!r) return err(404, 'NOT_FOUND', 'Ejecución no encontrada.');
    const url = new URL(request.url);
    const st = all(url, 'status');
    const list = st.length ? r.results.filter((x) => st.includes(x.status)) : r.results;
    return HttpResponse.json(page(list, url));
  }),
  http.get(`${API}/runs/:id/results/:resultId/attempts`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const r = db.runById(String(params.id));
    if (!r) return err(404, 'NOT_FOUND', 'Ejecución no encontrada.');
    return HttpResponse.json({ items: r.attempts.filter((a) => a.runResultId === params.resultId), nextCursor: null, hasNext: false });
  }),
  http.get(`${API}/runs/:id/case-results`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const r = db.runById(String(params.id));
    if (!r) return err(404, 'NOT_FOUND', 'Ejecución no encontrada.');
    return HttpResponse.json(page(r.caseResults, new URL(request.url)));
  }),
  http.get(`${API}/runs/:id/targets`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const r = db.runById(String(params.id));
    return r ? HttpResponse.json({ items: r.targets, nextCursor: null, hasNext: false }) : err(404, 'NOT_FOUND', 'Ejecución no encontrada.');
  }),
  http.get(`${API}/runs/:id/artifacts`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const r = db.runById(String(params.id));
    if (!r) return err(404, 'NOT_FOUND', 'Ejecución no encontrada.');
    const url = new URL(request.url);
    const rid = url.searchParams.get('resultId');
    return HttpResponse.json({ items: rid ? r.artifacts.filter((a) => a.runResultId === rid) : r.artifacts, nextCursor: null, hasNext: false });
  }),
  http.get(`${API}/runs/:id/artifacts/:artifactId`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const r = db.runById(String(params.id));
    const a = r?.artifacts.find((x) => x.id === params.artifactId);
    if (!a) return err(404, 'NOT_FOUND', 'Artefacto no encontrado.');
    if (a.sanitizationStatus !== 'sanitizado') return err(422, 'ARTIFACT_NOT_PUBLISHABLE', a.sanitizationReason ?? 'El artefacto no está disponible.');
    return HttpResponse.json({ artifact: a, url: `http://localhost:3001/visor/${a.id}?ticket=${crypto.randomUUID()}`, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), disposition: a.kind === 'reporte' || a.kind === 'traza' ? 'viewer' : 'download' });
  }),
  http.post(`${API}/runs/preview`, async ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const b = await body<RunBody>(request);
    const cs = selectedCases(b);
    if (isResp(cs)) return cs;
    const p = buildPreview(b, cs);
    return isResp(p) ? p : HttpResponse.json(p);
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
      return HttpResponse.json(runSummary(db.runById(prev.runId)!), { status: 200 });
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
    return HttpResponse.json(runSummary(run), { status: 201 });
  }),
  http.post(`${API}/runs/:id/cancel`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const r = db.runById(String(params.id));
    if (!r) return err(404, 'NOT_FOUND', 'Ejecución no encontrada.');
    if (['terminada', 'cancelada', 'interrumpida', 'omitida'].includes(r.status)) return err(409, 'RUN_NOT_CANCELLABLE', 'La ejecución ya terminó y no puede cancelarse.');
    if (r.status !== 'cancelando') {
      r.status = 'cancelando';
      r.cancelRequestedAt = new Date().toISOString();
      r.version += 1;
      emit('run.updated', 'run', r.id, r.version, r.id, { status: r.status, outcome: r.outcome, syncStatus: r.syncStatus, counts: r.counts, startedAt: r.startedAt, finishedAt: r.finishedAt, cancelRequestedAt: r.cancelRequestedAt });
    }
    return HttpResponse.json({ run: runSummary(r), stopConfirmed: false });
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
    const p = page(list, url);
    return HttpResponse.json({ ...p, items: p.items.map(scheduleOut) });
  }),
  http.get(`${API}/schedules/:id`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const s = db.scheduleById(String(params.id));
    return s && !s.deletedAt ? HttpResponse.json(scheduleOut(s)) : err(404, 'NOT_FOUND', 'Programación no encontrada.');
  }),
  http.post(`${API}/schedules/preview`, async ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const b = await body<{ editor?: Parameters<typeof buildCronExpressions>[0]; cronExpressions?: string[]; timezone?: string; count?: number }>(request);
    const tz = b.timezone ?? 'America/La_Paz';
    try {
      const built = b.editor ? buildCronExpressions(b.editor) : { cronExpressions: b.cronExpressions ?? [], description: null };
      const v = validateSchedule(built.cronExpressions, tz);
      if (!v.ok) return err(422, v.issues[0]?.code ?? 'CRON_INVALID', v.issues[0]?.message ?? 'Expresión cron inválida.');
      const occurrences = previewOccurrences(built.cronExpressions, tz, new Date(), Math.min(b.count ?? 5, 50));
      return HttpResponse.json({ cronExpressions: built.cronExpressions, description: built.description, timezone: tz, occurrences, issues: [] });
    } catch (e) {
      if (e instanceof ScheduleBuildError) return err(422, e.code, e.message, { issues: [{ path: ['editor'], code: e.code, message: e.message }] });
      return err(422, 'CRON_INVALID', 'Expresión cron inválida.');
    }
  }),
  http.post(`${API}/schedules`, async ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const b = await body<Record<string, unknown> & { name: string; editor?: Parameters<typeof buildCronExpressions>[0]; environmentId: string; timezone?: string; retries?: number; suiteId?: string; caseIds?: string[]; tags?: string[] }>(request);
    if (db.schedules.some((s) => !s.deletedAt && s.name.toLowerCase() === b.name?.toLowerCase())) {
      return err(409, 'CONFLICT', 'Ya existe una programación con ese nombre.', { issues: [{ path: ['name'], code: 'CONFLICT', message: 'Ya existe una programación con ese nombre.' }] });
    }
    try {
      const built = buildCronExpressions(b.editor!);
      const selector: Schedule['selector'] = b.suiteId ? { kind: 'suite', suiteId: b.suiteId } : b.caseIds ? { kind: 'cases', caseIds: b.caseIds } : { kind: 'tags', tags: b.tags ?? [] };
      const s: Schedule = { ...db.schedules[0]!, id: db.uuid(), name: b.name, selector, suiteId: b.suiteId ?? null, environmentId: b.environmentId, editor: b.editor ?? null, cronExpressions: built.cronExpressions, description: built.description, windowStart: built.windowStart, windowEnd: built.windowEnd, timezone: b.timezone ?? 'America/La_Paz', retries: b.retries ?? 0, enabled: true, pausedAt: null, revision: 1, createdBy: { id: g.id, kind: 'panel_user', displayName: g.name }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), targetLabel: b.suiteId ? db.suiteById(b.suiteId)?.name ?? '' : b.tags?.join(' ') ?? `${b.caseIds?.length ?? 0} casos` };
      db.schedules.push(s);
      emit('schedule.updated', 'schedule', s.id, 1, null, {});
      return HttpResponse.json(scheduleOut(s), { status: 201 });
    } catch (e) {
      if (e instanceof ScheduleBuildError) return err(422, e.code, e.message, { issues: [{ path: ['editor'], code: e.code, message: e.message }] });
      throw e;
    }
  }),
  http.put(`${API}/schedules/:id`, async ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const s = db.scheduleById(String(params.id));
    if (!s) return err(404, 'NOT_FOUND', 'Programación no encontrada.');
    const b = await body<Record<string, unknown> & { revision: number; name: string; editor?: Parameters<typeof buildCronExpressions>[0]; environmentId: string; timezone?: string; retries?: number }>(request);
    if (b.revision !== s.revision) return err(409, 'VERSION_CONFLICT', 'La programación cambió desde que la abriste; recarga antes de guardar.');
    try {
      const built = buildCronExpressions(b.editor!);
      Object.assign(s, { name: b.name, editor: b.editor, environmentId: b.environmentId, timezone: b.timezone ?? s.timezone, retries: b.retries ?? s.retries, cronExpressions: built.cronExpressions, description: built.description, revision: s.revision + 1, updatedAt: new Date().toISOString() });
      emit('schedule.updated', 'schedule', s.id, s.revision, null, {});
      return HttpResponse.json(scheduleOut(s));
    } catch (e) {
      if (e instanceof ScheduleBuildError) return err(422, e.code, e.message, { issues: [{ path: ['editor'], code: e.code, message: e.message }] });
      throw e;
    }
  }),
  http.delete(`${API}/schedules/:id`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const s = db.scheduleById(String(params.id));
    if (!s) return err(404, 'NOT_FOUND', 'Programación no encontrada.');
    s.deletedAt = new Date().toISOString();
    s.revision += 1;
    emit('schedule.updated', 'schedule', s.id, s.revision, null, {});
    return new HttpResponse(null, { status: 204 });
  }),
  ...(['pause', 'resume'] as const).map((op) =>
    http.post(`${API}/schedules/:id/${op}`, ({ request, params }) => {
      const g = guard(request);
      if (isResp(g)) return g;
      const s = db.scheduleById(String(params.id));
      if (!s) return err(404, 'NOT_FOUND', 'Programación no encontrada.');
      s.enabled = op === 'resume';
      s.pausedAt = op === 'pause' ? new Date().toISOString() : null;
      s.revision += 1;
      emit('schedule.updated', 'schedule', s.id, s.revision, null, {});
      return HttpResponse.json(scheduleOut(s));
    }),
  ),
  http.post(`${API}/schedules/:id/duplicate`, async ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const s = db.scheduleById(String(params.id));
    if (!s) return err(404, 'NOT_FOUND', 'Programación no encontrada.');
    const b = await body<{ name?: string }>(request);
    const copy: Schedule = { ...s, id: db.uuid(), name: b.name ?? `${s.name} (copia)`, enabled: false, pausedAt: new Date().toISOString(), revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    db.schedules.push(copy);
    return HttpResponse.json(scheduleOut(copy), { status: 201 });
  }),
  http.get(`${API}/schedules/:id/next`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const s = db.scheduleById(String(params.id));
    if (!s) return err(404, 'NOT_FOUND', 'Programación no encontrada.');
    const count = Number(new URL(request.url).searchParams.get('count') ?? 5);
    return HttpResponse.json({ timezone: s.timezone, revision: s.revision, occurrences: previewOccurrences(s.cronExpressions, s.timezone, new Date(), count) });
  }),
  http.get(`${API}/schedules/:id/revisions`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const s = db.scheduleById(String(params.id));
    if (!s) return err(404, 'NOT_FOUND', 'Programación no encontrada.');
    const items = Array.from({ length: s.revision }, (_, i) => ({
      scheduleId: s.id,
      revision: s.revision - i,
      changedBy: i === s.revision - 1 ? s.createdBy : { id: db.users[2]!.id, kind: 'panel_user' as const, displayName: db.users[2]!.name },
      changedAt: new Date(Date.now() - i * 3 * DAY).toISOString(),
      action: (i === s.revision - 1 ? 'create' : s.enabled ? 'update' : 'pause') as 'create' | 'update' | 'pause',
      diff: i === s.revision - 1 ? {} : { cronExpressions: { from: ['0 9 * * 1-5'], to: s.cronExpressions } },
    }));
    return HttpResponse.json({ items, nextCursor: null, hasNext: false });
  }),
  http.get(`${API}/schedules/:id/occurrences`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const s = db.scheduleById(String(params.id));
    if (!s) return err(404, 'NOT_FOUND', 'Programación no encontrada.');
    const items = Array.from({ length: 12 }, (_, i) => {
      const skipped = i % 5 === 2;
      return {
        id: db.uuid(),
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
    return HttpResponse.json(page(items, new URL(request.url)));
  }),

  // ---------------- Rendimiento
  http.get(`${API}/perf`, ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const url = new URL(request.url);
    const from = Date.parse(url.searchParams.get('from') ?? '');
    const to = Date.parse(url.searchParams.get('to') ?? '');
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return err(422, 'VALIDATION_FAILED', 'Rango inválido.');
    const by = (url.searchParams.get('by') ?? 'hour') as 'hour' | 'day';
    const compare = url.searchParams.get('compare') === 'previous_period';
    const envId = url.searchParams.get('environmentId') ?? db.PROD.id;
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
    return HttpResponse.json(out);
  }),
  // PENDIENTE [WEB→API-C]
  http.get(`${API}/perf/summary`, ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const url = new URL(request.url);
    const rows: PerfSummaryRow[] = db.PERF_SERIES.map((s, i) => {
      const insufficient = s.screen === 'Instalaciones';
      const p95 = i === 0 ? 14_200 : Math.round(s.base * 1.3);
      return {
        seriesKey: { endpointKey: s.endpointKey, provenance: 'dxmon', source: s.source, metricKind: s.metricKind, cacheMode: 'desconocida', workerProfile: null },
        screen: s.screen,
        meanMs: i === 0 ? 8_900 : Math.round(s.base * 1.05),
        p95Ms: insufficient ? null : p95,
        p95Status: insufficient ? 'muestra_insuficiente' : 'ok',
        maxMs: i === 0 ? 61_000 : i === 2 ? 20_000 : Math.round(s.base * 2),
        bytesWire: s.wire,
        bytesBody: s.body,
        completed: insufficient ? 12 : 24 + i,
        started: insufficient ? 12 : 25 + i,
        httpErrors: i === 0 ? 3 : 0,
        timeouts: i === 2 ? 1 : 0,
        over29s: i === 0 ? 1 : 0,
        thresholdId: db.thresholds[i]?.id ?? null,
        thresholdLimitMs: db.thresholds[i]?.limit ?? null,
      };
    });
    return HttpResponse.json({ from: url.searchParams.get('from') ?? '', to: url.searchParams.get('to') ?? '', rows });
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
      .map((x) => ({ id: db.uuid(), ts: new Date(base + x.t).toISOString(), runId: db.runs[0]!.id, endpointKey: x.ep, provenance: 'dxmon' as const, source: 'ui' as const, kind: x.kind as 'http_error', statusCode: x.code, totalMs: x.ms, censoredAtMs: x.kind === 'timeout' ? 20_000 : null }));
    return HttpResponse.json(page(items, new URL(request.url)));
  }),
  http.get(`${API}/perf/thresholds`, ({ request }) => {
    const g = guard(request, 'dev');
    if (isResp(g)) return g;
    return HttpResponse.json(page(db.thresholds, new URL(request.url)));
  }),
  http.post(`${API}/perf/thresholds`, async ({ request }) => {
    const g = guard(request, 'dev');
    if (isResp(g)) return g;
    const b = await body<(typeof db.thresholds)[number]>(request);
    const t = { ...b, id: db.uuid(), unit: 'ms' as const, label: b.label ?? null, lastEvaluation: null, createdBy: { id: g.id, kind: 'panel_user' as const, displayName: g.name }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: 1 };
    db.thresholds.push(t);
    return HttpResponse.json(t, { status: 201 });
  }),
  http.put(`${API}/perf/thresholds/:id`, async ({ request, params }) => {
    const g = guard(request, 'dev');
    if (isResp(g)) return g;
    const t = db.thresholds.find((x) => x.id === params.id);
    if (!t) return err(404, 'NOT_FOUND', 'Umbral no encontrado.');
    const b = await body<Partial<typeof t>>(request);
    if (b.version !== t.version) return err(409, 'VERSION_CONFLICT', 'El umbral cambió; recarga antes de guardar.');
    if (b.minSamples !== undefined && b.minSamples < 20) return err(422, 'THRESHOLD_MIN_SAMPLES', 'min_samples no puede ser menor al piso de la métrica.', { issues: [{ path: ['minSamples'], code: 'THRESHOLD_MIN_SAMPLES', message: 'El mínimo para p95 es 20 muestras.' }] });
    Object.assign(t, b, { version: t.version + 1, updatedAt: new Date().toISOString() });
    return HttpResponse.json(t);
  }),
  http.get(`${API}/events`, ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    return HttpResponse.json(page(db.marks, new URL(request.url)));
  }),
  http.post(`${API}/events`, async ({ request }) => {
    const g = guard(request, 'dev');
    if (isResp(g)) return g;
    const b = await body<{ ts: string; label: string; environmentId: string }>(request);
    const m = { id: db.uuid(), ts: b.ts, label: b.label, environmentId: b.environmentId, frontendVersion: null, backendVersion: null, createdBy: { id: g.id, kind: 'panel_user' as const, displayName: g.name }, createdAt: new Date().toISOString() };
    db.marks.push(m);
    return HttpResponse.json(m, { status: 201 });
  }),

  // ---------------- Alertas, entregas, auditoría, usuarios
  http.get(`${API}/alerts`, ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const url = new URL(request.url);
    const st = url.searchParams.get('status');
    return HttpResponse.json(page(st ? db.alerts.filter((a) => a.status === st) : db.alerts, url));
  }),
  http.get(`${API}/integrations/testrail/deliveries`, ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const url = new URL(request.url);
    const st = all(url, 'status');
    const list = st.length ? db.deliveries.filter((d) => st.includes(d.status)) : db.deliveries;
    return HttpResponse.json(page(list, url));
  }),
  http.post(`${API}/integrations/testrail/deliveries/:id/retry`, ({ request, params }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    const d = db.deliveries.find((x) => x.id === params.id);
    if (!d) return err(404, 'NOT_FOUND', 'Entrega no encontrada.');
    if (d.status === 'entregada') return err(409, 'DELIVERY_NOT_RETRYABLE', 'La entrega no está en un estado reintentable.');
    Object.assign(d, { status: 'en_proceso', attempts: d.attempts + 1, updatedAt: new Date().toISOString() });
    setTimeout(() => {
      Object.assign(d, { status: 'entregada', lastError: null, lastHttpStatus: 200, nextAttemptAt: null });
      emit('sync.updated', 'run_testrail_target', d.targetId ?? d.id, Date.now(), d.runId, {});
    }, 2500);
    return HttpResponse.json({ delivery: d, reconciliation: 'no_aplicada' });
  }),
  http.get(`${API}/audit-log`, ({ request }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    const url = new URL(request.url);
    let list = db.audit;
    const action = url.searchParams.get('action');
    if (action) list = list.filter((a) => a.action === action);
    const entity = url.searchParams.get('entity');
    if (entity) list = list.filter((a) => a.entity === entity);
    const from = url.searchParams.get('from');
    if (from) list = list.filter((a) => a.createdAt >= from);
    const to = url.searchParams.get('to');
    if (to) list = list.filter((a) => a.createdAt < to);
    return HttpResponse.json(page(list, url));
  }),
  http.get(`${API}/users`, ({ request }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    return HttpResponse.json(page(db.users, new URL(request.url)));
  }),
  http.post(`${API}/users`, async ({ request }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    const b = await body<{ email: string; name: string; role: PanelUser['role'] }>(request);
    if (db.userByEmail(b.email)) return err(409, 'EMAIL_TAKEN', 'Ya existe un usuario con ese correo.', { issues: [{ path: ['email'], code: 'EMAIL_TAKEN', message: 'Ya existe un usuario con ese correo.' }] });
    const u: PanelUser = { id: db.uuid(), email: b.email.toLowerCase(), name: b.name, role: b.role, hasLocalPassword: false, authSubject: null, disabledAt: null, lastLoginAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: 1 };
    db.users.push(u);
    return HttpResponse.json(u, { status: 201 });
  }),
  http.put(`${API}/users/:id`, async ({ request, params }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    const u = db.users.find((x) => x.id === params.id);
    if (!u) return err(404, 'NOT_FOUND', 'Usuario no encontrado.');
    const b = await body<{ role?: PanelUser['role']; disabled?: boolean; name?: string; version: number }>(request);
    if (b.version !== u.version) return err(409, 'VERSION_CONFLICT', 'El usuario cambió; recarga antes de guardar.');
    const admins = db.users.filter((x) => x.role === 'admin' && !x.disabledAt);
    if (u.role === 'admin' && admins.length === 1 && ((b.role && b.role !== 'admin') || b.disabled)) return err(409, 'LAST_ADMIN', 'No puede quitarse el último administrador activo.');
    if (b.role) u.role = b.role;
    if (b.name) u.name = b.name;
    if (b.disabled !== undefined) u.disabledAt = b.disabled ? new Date().toISOString() : null;
    u.version += 1;
    u.updatedAt = new Date().toISOString();
    return HttpResponse.json(u);
  }),

  // ---------------- Notificaciones
  http.get(`${API}/notifications/channels`, ({ request }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    return HttpResponse.json({ items: db.channels, nextCursor: null, hasNext: false });
  }),
  http.put(`${API}/notifications/channels/:kind`, async ({ request, params }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    const c = db.channels.find((x) => x.kind === params.kind);
    if (!c) return err(404, 'NOT_FOUND', 'Canal no encontrado.');
    const b = await body<Partial<typeof c>>(request);
    if (b.enabled && !(b.secretRef ?? c.secretRef) && c.kind !== 'correo') return err(422, 'CHANNEL_NOT_CONFIGURED', 'El canal de notificación no está configurado.', { issues: [{ path: ['secretRef'], code: 'CHANNEL_NOT_CONFIGURED', message: 'Indica la referencia del webhook antes de habilitar.' }] });
    Object.assign(c, b, { version: c.version + 1, updatedAt: new Date().toISOString() });
    return HttpResponse.json(c);
  }),
  http.post(`${API}/notifications/channels/:kind/test`, ({ request, params }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    const c = db.channels.find((x) => x.kind === params.kind);
    if (!c) return err(404, 'NOT_FOUND', 'Canal no encontrado.');
    const ok = !!c.secretRef || c.kind === 'correo';
    c.lastTestAt = new Date().toISOString();
    c.lastTestOk = ok;
    return HttpResponse.json({ ok, ambiguous: false, message: ok ? 'Mensaje de prueba enviado.' : 'El canal no tiene destino configurado.' });
  }),
  http.get(`${API}/notifications/preferences`, ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const p = db.preferences.get(g.id) ?? { userId: g.id, channels: ['slack'], events: ['corrida_con_fallas', 'umbral_superado'], scheduleIds: [], allSchedules: true, thresholdIds: [], allThresholds: true, updatedAt: new Date().toISOString(), version: 0 };
    return HttpResponse.json(p);
  }),
  http.put(`${API}/notifications/preferences`, async ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const b = await body<Record<string, unknown>>(request);
    const prev = db.preferences.get(g.id);
    const p = { userId: g.id, ...(b as object), updatedAt: new Date().toISOString(), version: (prev?.version ?? 0) + 1 } as never;
    db.preferences.set(g.id, p);
    return HttpResponse.json(p);
  }),
  // Ajustes "Avisar cuando" (PENDIENTE [WEB→API-C]: reglas globales de notificación por evento)
  http.get(`${API}/notifications/rules`, ({ request }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    return HttpResponse.json(db.notifySettings);
  }),
  http.put(`${API}/notifications/rules`, async ({ request }) => {
    const g = guard(request, 'admin');
    if (isResp(g)) return g;
    Object.assign(db.notifySettings, await body<Record<string, boolean>>(request));
    return HttpResponse.json(db.notifySettings);
  }),

  // ---------------- Exportaciones
  http.post(`${API}/exports`, async ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const b = await body<{ format: 'csv' | 'pdf'; scope: string; extent: 'pagina' | 'completo' }>(request);
    const job: ExportJob = { id: db.uuid(), format: b.format, scope: b.scope, extent: b.extent, status: 'en_proceso', rowCount: null, sizeBytes: null, error: null, expiresAt: null, createdAt: new Date().toISOString(), finishedAt: null };
    exportsDb.set(job.id, job);
    setTimeout(() => {
      Object.assign(job, { status: 'listo', rowCount: b.extent === 'pagina' ? 25 : db.runs.length, sizeBytes: 18_432, finishedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + DAY).toISOString() });
      emit('export.updated', 'export_job', job.id, 2, null, {});
    }, 1500);
    return HttpResponse.json(job, { status: 202 });
  }),
  http.get(`${API}/exports/:id`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const j = exportsDb.get(String(params.id));
    return j ? HttpResponse.json(j) : err(404, 'NOT_FOUND', 'Exportación no encontrada.');
  }),
  http.get(`${API}/exports/:id/download`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const j = exportsDb.get(String(params.id));
    if (!j || j.status !== 'listo') return err(409, 'CONFLICT', 'La exportación aún no está lista.');
    return HttpResponse.json({ url: `data:text/csv;charset=utf-8,${encodeURIComponent('id,estado\n')}`, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() });
  }),

  // ---------------- Grabación y dispositivos
  http.post(`${API}/recordings`, async ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const b = await body<{ caseId: string; environmentId: string; tags: string[] }>(request);
    const env = db.environments.find((e) => e.id === b.environmentId);
    if (env?.isProduction) return err(422, 'RECORDING_PRODUCTION_BLOCKED', 'No se permite grabar en producción.');
    const c = db.caseById(b.caseId);
    if (!c) return err(422, 'SELECTION_FOREIGN_IDS', 'Caso inexistente.');
    const r: RecordingSession = { id: db.uuid(), caseId: c.id, caseRef: c.ref, environmentId: b.environmentId, createdBy: g.id, deviceId: null, status: 'creada', tags: b.tags ?? [], expiresAt: new Date(Date.now() + 2 * HOUR).toISOString(), branch: null, prUrl: null, commit: null, rejectionReasons: [], steps: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    db.recordings.push(r);
    if (db.deviceState.linked) simulateRecording(r);
    return HttpResponse.json({ recording: r, assistantLink: `katalyst://recording/${r.id}`, assistant: { linked: db.deviceState.linked, online: db.deviceState.online, installUrl: 'https://descargas.deltax.la/katalyst-asistente-setup.exe' } }, { status: 201 });
  }),
  http.get(`${API}/recordings/:id`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const r = db.recordings.find((x) => x.id === params.id);
    if (!r || r.createdBy !== g.id) return err(404, 'NOT_FOUND', 'Grabación no encontrada.');
    return HttpResponse.json(r);
  }),
  http.post(`${API}/recordings/:id/cancel`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const r = db.recordings.find((x) => x.id === params.id);
    if (!r) return err(404, 'NOT_FOUND', 'Grabación no encontrada.');
    if (['pr_abierto', 'rechazada', 'vencida'].includes(r.status)) return err(409, 'RECORDING_INVALID_STATE', 'La grabación no admite esta transición.');
    r.status = 'cancelada';
    r.updatedAt = new Date().toISOString();
    emit('recording.updated', 'recording_session', r.id, Date.now(), null, {});
    return HttpResponse.json(r);
  }),
  // PENDIENTE [WEB→API-C]
  http.post(`${API}/recordings/:id/commands`, async ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const r = db.recordings.find((x) => x.id === params.id);
    if (!r) return err(404, 'NOT_FOUND', 'Grabación no encontrada.');
    const b = await body<{ command: string }>(request);
    if (!db.deviceState.online) return err(409, 'RECORDING_INVALID_STATE', 'El asistente local no está conectado.');
    if (b.command === 'agregar_verificacion') r.steps.push({ kind: 'verificacion', description: 'expect grid "Agendamientos" visible' });
    if (b.command === 'detener') r.status = 'validando';
    if (b.command === 'enviar_pr') {
      r.status = 'validando';
      setTimeout(() => {
        if (r.steps.some((s) => s.kind === 'no_soportada')) {
          r.status = 'rechazada';
          r.rejectionReasons = [{ code: 'VERIFICATION_PENDING', message: 'Falta la verificación del paso 3.', line: 6 }];
        } else {
          r.status = 'pr_abierto';
          r.branch = `grabacion/${r.caseRef.toLowerCase()}-${r.id.slice(0, 6)}`;
          r.prUrl = 'https://github.com/deltax/qa-tests/pull/84';
        }
        r.updatedAt = new Date().toISOString();
        emit('recording.updated', 'recording_session', r.id, Date.now(), null, {});
      }, 2500);
    }
    r.updatedAt = new Date().toISOString();
    emit('recording.updated', 'recording_session', r.id, Date.now(), null, {});
    return HttpResponse.json(r);
  }),
  http.get(`${API}/devices/status`, ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    return HttpResponse.json({ linked: db.deviceState.linked, online: db.deviceState.online, lastSeenAt: db.deviceState.online ? new Date().toISOString() : null, clientVersion: db.deviceState.linked ? '0.1.0' : null, installUrl: 'https://descargas.deltax.la/katalyst-asistente-setup.exe' });
  }),
  http.get(`${API}/devices`, ({ request }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    return HttpResponse.json({ items: db.devices, nextCursor: null, hasNext: false });
  }),
  http.delete(`${API}/devices/:id`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const d = db.devices.find((x) => x.id === params.id);
    if (!d) return err(404, 'NOT_FOUND', 'Dispositivo no encontrado.');
    d.revokedAt = new Date().toISOString();
    db.deviceState.linked = db.devices.some((x) => !x.revokedAt);
    db.deviceState.online = db.deviceState.linked;
    return new HttpResponse(null, { status: 204 });
  }),
  http.get(`${API}/devices/authorizations/:userCode`, ({ request, params }) => {
    const g = guard(request);
    if (isResp(g)) return g;
    const a = db.deviceAuthorizations.get(String(params.userCode));
    return a ? HttpResponse.json(a) : err(404, 'NOT_FOUND', 'Código inexistente o vencido.');
  }),
  ...(['approve', 'deny'] as const).map((op) =>
    http.post(`${API}/devices/${op}`, async ({ request }) => {
      const g = guard(request);
      if (isResp(g)) return g;
      const b = await body<{ userCode: string }>(request);
      const a = db.deviceAuthorizations.get(b.userCode);
      if (!a || a.status !== 'pendiente') return err(409, 'DEVICE_CODE_EXPIRED', 'El código de dispositivo venció o ya fue usado.');
      a.status = op === 'approve' ? 'aprobada' : 'denegada';
      if (op === 'approve') {
        db.devices.push({ id: db.uuid(), name: `${a.clientName} (${a.platform})`, platform: a.platform, clientVersion: a.clientVersion, createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 90 * DAY).toISOString(), revokedAt: null });
        db.deviceState.linked = true;
        db.deviceState.online = true;
      }
      return HttpResponse.json({ ok: true });
    }),
  ),

  // ---------------- IA
  http.post(`${API}/generate`, async ({ request }) => {
    const g = guard(request, 'dev');
    if (isResp(g)) return g;
    const b = await body<{ caseId: string }>(request);
    const c = db.caseById(b.caseId);
    const gen: GenerationRequest = { id: db.uuid(), kind: 'borrador_desde_caso', status: 'en_proceso', caseId: b.caseId, recordingId: null, provider: 'anthropic', model: 'claude', promptVersion: 'v1', inputTokens: null, outputTokens: null, costUsd: null, result: null, error: null, createdBy: g.id, createdAt: new Date().toISOString(), finishedAt: null };
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
        },
      });
      emit('generation.updated', 'generation_request', gen.id, 2, null, {});
    }, 2000);
    return HttpResponse.json(gen, { status: 202 });
  }),
  http.get(`${API}/generate/:id`, ({ request, params }) => {
    const g = guard(request, 'dev');
    if (isResp(g)) return g;
    const x = genDb.get(String(params.id));
    return x ? HttpResponse.json(x) : err(404, 'NOT_FOUND', 'Solicitud no encontrada.');
  }),

  // ---------------- SSE
  http.get(`${API}/events/stream`, ({ request }) => {
    const u = currentUser();
    if (!u) return err(401, 'UNAUTHENTICATED', 'Se requiere autenticación.');
    void currentSeq;
    return new HttpResponse(sseStream(request.headers.get('Last-Event-ID')), {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' },
    });
  }),
];

const exportsDb = new Map<string, ExportJob>();
const genDb = new Map<string, GenerationRequest>();

function simulateRecording(r: RecordingSession) {
  const steps: { delay: number; apply: () => void }[] = [
    { delay: 1500, apply: () => { r.status = 'vinculada'; r.deviceId = db.devices[0]?.id ?? null; } },
    { delay: 3000, apply: () => { r.status = 'grabando'; r.steps.push({ kind: 'accion', description: 'goto /schedulings' }); } },
    { delay: 5000, apply: () => { r.steps.push({ kind: 'accion', description: 'click tab "Lista"' }); } },
    { delay: 7000, apply: () => { r.steps.push({ kind: 'no_soportada', description: 'Falta verificación del paso 3' }); } },
  ];
  for (const s of steps) {
    setTimeout(() => {
      if (r.status === 'cancelada') return;
      s.apply();
      r.updatedAt = new Date().toISOString();
      emit('recording.updated', 'recording_session', r.id, Date.now(), null, {});
    }, s.delay);
  }
}
