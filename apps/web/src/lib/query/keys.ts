/**
 * Factory de query keys tipada por recurso, filtros e identidad (ESP §17.2). El último elemento es el ámbito de
 * identidad (`u:<id>:<rol>`) para que dos identidades nunca compartan caché; la invalidación por prefijo de recurso
 * (`['runs']`) sigue funcionando. Logout además vacía la QueryClient.
 */
let scope = 'anon';
export function setQueryScope(userId: string | null, role: string | null): void {
  scope = userId ? `u:${userId}:${role ?? ''}` : 'anon';
}
export function getQueryScope(): string {
  return scope;
}

type Filters = Record<string, unknown>;
const k = <const T extends readonly unknown[]>(...parts: T) => [...parts, scope] as const;

export const qk = {
  session: () => ['session'] as const,
  authProviders: () => ['auth', 'providers'] as const,
  home: {
    successRate: (f: Filters) => k('runs', 'home-success', f),
    counts: (f: Filters) => k('runs', 'home-counts', f),
    coverage: () => k('catalog', 'home-coverage'),
    upcoming: () => k('schedules', 'home-upcoming'),
  },
  catalog: {
    all: ['catalog'] as const,
    cases: (f: Filters) => k('catalog', 'cases', f),
    case: (id: string) => k('catalog', 'case', id),
    caseHistory: (id: string, f: Filters) => k('catalog', 'case-history', id, f),
    sections: () => k('catalog', 'sections'),
    tags: () => k('catalog', 'tags'),
    test: (id: string) => k('catalog', 'test', id),
    tests: (f: Filters) => k('catalog', 'tests', f),
    testHistory: (id: string, f: Filters) => k('catalog', 'test-history', id, f),
    search: (q: string) => k('catalog', 'search', q),
  },
  suites: {
    all: ['suites'] as const,
    list: (f: Filters) => k('suites', 'list', f),
    detail: (id: string) => k('suites', 'detail', id),
  },
  environments: {
    all: ['config', 'environments'] as const,
    list: () => k('config', 'environments', 'list'),
    detail: (id: string) => k('config', 'environments', 'detail', id),
    users: (id: string) => k('config', 'environments', 'users', id),
  },
  runs: {
    all: ['runs'] as const,
    list: (f: Filters) => k('runs', 'list', f),
    detail: (id: string) => k('runs', 'detail', id),
    results: (id: string, f: Filters) => k('runs', 'results', id, f),
    attempts: (id: string, resultId: string) => k('runs', 'attempts', id, resultId),
    caseResults: (id: string) => k('runs', 'case-results', id),
    targets: (id: string) => k('runs', 'targets', id),
    artifacts: (id: string, resultId: string | null) => k('runs', 'artifacts', id, resultId),
    preview: (body: unknown) => k('runs', 'preview', body),
  },
  schedules: {
    all: ['schedules'] as const,
    list: (f: Filters) => k('schedules', 'list', f),
    detail: (id: string) => k('schedules', 'detail', id),
    next: (id: string) => k('schedules', 'next', id),
    preview: (body: unknown) => k('schedules', 'preview', body),
    revisions: (id: string) => k('schedules', 'revisions', id),
    occurrences: (id: string, f: Filters) => k('schedules', 'occurrences', id, f),
  },
  perf: {
    all: ['perf'] as const,
    aggregates: (f: Filters) => k('perf', 'aggregates', f),
    series: (f: Filters) => k('perf', 'series', f),
    marks: (f: Filters) => k('perf', 'marks', f),
    errors: (f: Filters) => k('perf', 'errors', f),
    thresholds: (f: Filters) => k('perf', 'thresholds', f),
  },
  alerts: {
    all: ['alerts'] as const,
    list: (f: Filters) => k('alerts', 'list', f),
  },
  testrail: {
    all: ['testrail'] as const,
    syncRuns: (f: Filters) => k('testrail', 'sync-runs', f),
    deliveries: (f: Filters) => k('testrail', 'deliveries', f),
    connection: () => k('config', 'testrail-connection'),
  },
  audit: { list: (f: Filters) => k('audit', 'list', f) },
  users: { all: ['config', 'users'] as const, list: (f: Filters) => k('config', 'users', f) },
  tokens: { list: () => k('config', 'tokens') },
  notifications: {
    channels: () => k('config', 'notification-channels'),
    preferences: () => k('notifications', 'preferences'),
  },
  exports: { detail: (id: string) => k('exports', id) },
  recordings: { detail: (id: string) => k('recordings', id) },
  devices: {
    status: () => k('devices', 'status'),
    list: () => k('devices', 'list'),
    authorization: (code: string) => k('devices', 'authorization', code),
  },
  generation: { detail: (id: string) => k('generation', id) },
};
