/**
 * Shell autenticado: sidebar fijo (240 px), topbar (62 px) y contenido con padding 32 px (ui-capturas §2).
 * Arranca el canal SSE único de la pestaña y configura el manejo uniforme 401/403/429 del cliente HTTP.
 */
import { useEffect, useState } from 'react';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  CalendarClock,
  CirclePlay,
  Gauge,
  Layers,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu,
  RefreshCw,
  ScrollText,
  Settings,
  X,
  type LucideIcon,
} from 'lucide-react';
import { roleAtLeast } from '@katalyst/shared/rbac';
import type { PanelRole } from '@katalyst/shared/enums';
import { BrandLogo } from '@/components/common/brand-logo';
import { Tip } from '@/components/ui/popover';
import { configureClient, errorMessage } from '@/lib/api/client';
import { clearClientState, logout, useSession } from '@/lib/auth/session';
import { startSse } from '@/lib/sse/manager';
import { ROLE_LABEL } from '@/lib/labels';
import { cn, initials } from '@/lib/utils';
import { Topbar } from './topbar';

interface NavItem {
  to: '/' | '/catalogo' | '/suites' | '/ejecuciones' | '/programaciones' | '/rendimiento' | '/testrail' | '/auditoria' | '/configuracion';
  label: string;
  icon: LucideIcon;
  minRole: PanelRole;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: 'Inicio', icon: LayoutDashboard, minRole: 'qa' },
  { to: '/catalogo', label: 'Catálogo', icon: ListChecks, minRole: 'qa' },
  { to: '/suites', label: 'Suites', icon: Layers, minRole: 'qa' },
  { to: '/ejecuciones', label: 'Ejecuciones', icon: CirclePlay, minRole: 'qa' },
  { to: '/programaciones', label: 'Programaciones', icon: CalendarClock, minRole: 'qa' },
  { to: '/rendimiento', label: 'Rendimiento', icon: Gauge, minRole: 'qa' },
  { to: '/testrail', label: 'TestRail', icon: RefreshCw, minRole: 'qa' },
  { to: '/auditoria', label: 'Auditoría', icon: ScrollText, minRole: 'admin' },
  { to: '/configuracion', label: 'Configuración', icon: Settings, minRole: 'admin' },
];

export function AppShell() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    configureClient({
      onUnauthorized: () => {
        clearClientState(qc);
        qc.setQueryData(['session'], null);
        void navigate({ to: '/ingresar', search: { redirect: window.location.pathname + window.location.search, motivo: 'expirada' }, replace: true });
      },
      onRateLimited: (e) => toast.warning(errorMessage(e), { id: 'rate-limit' }),
    });
    const mgr = startSse({
      queryClient: qc,
      onUnauthorized: () => {
        clearClientState(qc);
        qc.setQueryData(['session'], null);
        void navigate({ to: '/ingresar', search: { motivo: 'expirada' }, replace: true });
      },
    });
    return () => mgr.stop();
  }, [qc, navigate]);

  useEffect(() => setMobileOpen(false), [pathname]);

  return (
    <div className="flex min-h-screen bg-background">
      <a href="#contenido" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2">
        Saltar al contenido
      </a>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-sidebar flex-col bg-sidebar lg:flex" aria-label="Navegación principal">
        <Sidebar />
      </aside>
      {mobileOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menú">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMobileOpen(false)} />
          <aside className="relative flex h-full w-sidebar flex-col bg-sidebar">
            <button className="absolute top-3 right-3 text-sidebar-foreground" aria-label="Cerrar menú" onClick={() => setMobileOpen(false)}>
              <X className="size-5" />
            </button>
            <Sidebar />
          </aside>
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col lg:pl-sidebar">
        <Topbar
          menuButton={
            <button className="mr-2 rounded-md p-1.5 hover:bg-muted lg:hidden" aria-label="Abrir menú" onClick={() => setMobileOpen(true)}>
              <Menu className="size-5" />
            </button>
          }
        />
        <main id="contenido" className="flex-1 px-4 py-8 sm:px-8" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function Sidebar() {
  const me = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const role = me?.user.role ?? 'qa';
  const items = NAV_ITEMS.filter((i) => roleAtLeast(role, i.minRole));

  return (
    <>
      <div className="px-6 pt-[26px] pb-7">
        <Link to="/" aria-label="Inicio de Katalyst">
          <BrandLogo />
        </Link>
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 px-3">
        {items.map((item) => {
          const active = item.to === '/' ? pathname === '/' : pathname === item.to || pathname.startsWith(`${item.to}/`);
          const Icon = item.icon;
          return (
            <Link
              key={item.to}
              to={item.to}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex h-9 items-center gap-3 rounded-md px-3 text-[15px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring',
                active ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-sidebar-foreground hover:bg-white/5 hover:text-sidebar-user',
              )}
            >
              <Icon className="size-4" aria-hidden />
              {item.label}
            </Link>
          );
        })}
      </nav>
      {me ? (
        <div className="flex items-center gap-3 border-t border-sidebar-border px-4 py-4">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sidebar-avatar text-[12px] font-semibold text-sidebar-user" aria-hidden>
            {initials(me.user.name)}
          </span>
          <Link to="/preferencias" className="min-w-0 flex-1 rounded outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring" title="Mis notificaciones">
            <div className="truncate text-[13px] font-semibold text-sidebar-user">{me.user.name}</div>
            <div className="text-[12px] text-sidebar-user-muted">{ROLE_LABEL[me.user.role]}</div>
          </Link>
          <Tip label="Cerrar sesión" side="right">
            <button
              type="button"
              aria-label="Cerrar sesión"
              className="rounded-md p-1.5 text-sidebar-foreground outline-none hover:bg-white/5 hover:text-sidebar-user focus-visible:ring-2 focus-visible:ring-sidebar-ring"
              onClick={async () => {
                await logout(qc);
                void navigate({ to: '/ingresar', search: { motivo: 'salida' }, replace: true });
              }}
            >
              <LogOut className="size-4" />
            </button>
          </Tip>
        </div>
      ) : null}
    </>
  );
}
