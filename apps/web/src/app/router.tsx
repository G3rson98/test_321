/**
 * Rutas del panel (ui-capturas §5), code-based con TanStack Router. Las páginas se cargan con import dinámico
 * (chunks diferidos, RNF-OPT-03); el shell, el cliente HTTP, Query y el router viven en el chunk inicial.
 */
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import type { PanelRole } from '@katalyst/shared/enums';
import { sessionQuery } from '@/lib/auth/session';
import { AppShell } from '@/components/layout/app-shell';
import { NotFoundPage, RouteErrorPage } from '@/components/layout/error-pages';
import { RoleGate } from '@/components/layout/role-gate';
import {
  auditSearch,
  caseSearch,
  catalogSearch,
  deviceLinkSearch,
  loginSearch,
  newRunSearch,
  newScheduleSearch,
  perfSearch,
  runDetailSearch,
  runsSearch,
  schedulesSearch,
  testrailSearch,
  testUsersSearch,
} from './search';

export interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
  notFoundComponent: NotFoundPage,
  errorComponent: RouteErrorPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/ingresar',
  validateSearch: loginSearch,
  beforeLoad: async ({ context, search }) => {
    const me = await context.queryClient.ensureQueryData(sessionQuery).catch(() => null);
    if (me) throw redirect({ to: search.redirect ?? '/', replace: true });
  },
  component: lazyRouteComponent(() => import('@/features/auth/login-page'), 'LoginPage'),
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_app',
  beforeLoad: async ({ context, location }) => {
    const me = await context.queryClient.ensureQueryData(sessionQuery);
    if (!me) {
      throw redirect({ to: '/ingresar', search: { redirect: location.href }, replace: true });
    }
    return { me };
  },
  component: AppShell,
});

const page = <M extends Record<string, unknown>, K extends keyof M & string>(loader: () => Promise<M>, name: K) =>
  lazyRouteComponent(loader, name);

/** Envuelve una página que exige un rol mínimo (403 en la misma URL; la API también responde 403). */
function gated(min: PanelRole, Comp: ReturnType<typeof lazyRouteComponent>) {
  return function Gated() {
    return (
      <RoleGate min={min}>
        <Comp />
      </RoleGate>
    );
  };
}

const homeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  component: page(() => import('@/features/home/home-page'), 'HomePage'),
});

const catalogRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/catalogo',
  validateSearch: catalogSearch,
  component: page(() => import('@/features/catalog/catalog-page'), 'CatalogPage'),
});

const caseRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/catalogo/$caseId',
  validateSearch: caseSearch,
  component: page(() => import('@/features/catalog/case-page'), 'CasePage'),
});

const suitesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/suites',
  component: page(() => import('@/features/suites/suites-page'), 'SuitesPage'),
});
const suiteNewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/suites/nueva',
  component: page(() => import('@/features/suites/suite-form-page'), 'SuiteNewPage'),
});
const suiteEditRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/suites/$suiteId',
  component: page(() => import('@/features/suites/suite-form-page'), 'SuiteEditPage'),
});

const runsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/ejecuciones',
  validateSearch: runsSearch,
  component: page(() => import('@/features/runs/runs-page'), 'RunsPage'),
});
const runNewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/ejecuciones/nueva',
  validateSearch: newRunSearch,
  component: page(() => import('@/features/runs/new-run-page'), 'NewRunPage'),
});
const runDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/ejecuciones/$runId',
  validateSearch: runDetailSearch,
  component: page(() => import('@/features/runs/run-detail-page'), 'RunDetailPage'),
});

const schedulesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/programaciones',
  validateSearch: schedulesSearch,
  component: page(() => import('@/features/schedules/schedules-page'), 'SchedulesPage'),
});
const scheduleNewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/programaciones/nueva',
  validateSearch: newScheduleSearch,
  component: page(() => import('@/features/schedules/schedule-form-page'), 'ScheduleNewPage'),
});
const scheduleDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/programaciones/$scheduleId',
  component: page(() => import('@/features/schedules/schedule-detail-page'), 'ScheduleDetailPage'),
});
const scheduleEditRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/programaciones/$scheduleId/editar',
  component: page(() => import('@/features/schedules/schedule-form-page'), 'ScheduleEditPage'),
});

const perfRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/rendimiento',
  validateSearch: perfSearch,
  component: page(() => import('@/features/perf/perf-page'), 'PerfPage'),
});

const testrailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/testrail',
  validateSearch: testrailSearch,
  component: page(() => import('@/features/testrail/testrail-page'), 'TestRailPage'),
});

const auditRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/auditoria',
  validateSearch: auditSearch,
  component: gated('admin', page(() => import('@/features/audit/audit-page'), 'AuditPage')),
});

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/configuracion',
  component: gated('admin', page(() => import('@/features/settings/settings-layout'), 'SettingsLayout')),
});
const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/configuracion/testrail', replace: true });
  },
});
const settingsTestrailRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/testrail',
  component: page(() => import('@/features/settings/testrail-settings'), 'TestRailSettings'),
});
const settingsEnvRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/ambientes',
  component: page(() => import('@/features/settings/environments-settings'), 'EnvironmentsSettings'),
});
const settingsTestUsersRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/usuarios-prueba',
  validateSearch: testUsersSearch,
  component: page(() => import('@/features/settings/test-users-settings'), 'TestUsersSettings'),
});
const settingsNotifRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/notificaciones',
  component: page(() => import('@/features/settings/notifications-settings'), 'NotificationsSettings'),
});
const settingsUsersRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/usuarios',
  component: page(() => import('@/features/settings/users-settings'), 'UsersSettings'),
});

const preferencesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/preferencias',
  component: page(() => import('@/features/settings/my-preferences-page'), 'MyPreferencesPage'),
});

const assistantRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/asistente',
  component: page(() => import('@/features/recording/assistant-page'), 'AssistantPage'),
});
const deviceLinkRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/dispositivos/vincular',
  validateSearch: deviceLinkSearch,
  component: page(() => import('@/features/recording/device-link-page'), 'DeviceLinkPage'),
});

const forbiddenRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/sin-permiso',
  component: page(() => import('@/components/layout/error-pages'), 'ForbiddenPage'),
});

export const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([
    homeRoute,
    catalogRoute,
    caseRoute,
    suitesRoute,
    suiteNewRoute,
    suiteEditRoute,
    runsRoute,
    runNewRoute,
    runDetailRoute,
    schedulesRoute,
    scheduleNewRoute,
    scheduleDetailRoute,
    scheduleEditRoute,
    perfRoute,
    testrailRoute,
    auditRoute,
    settingsRoute.addChildren([
      settingsIndexRoute,
      settingsTestrailRoute,
      settingsEnvRoute,
      settingsTestUsersRoute,
      settingsNotifRoute,
      settingsUsersRoute,
    ]),
    preferencesRoute,
    assistantRoute,
    deviceLinkRoute,
    forbiddenRoute,
  ]),
]);

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    // Solo precarga código en intención de navegación; los datos los pide cada página con Query.
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
    defaultNotFoundComponent: NotFoundPage,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
