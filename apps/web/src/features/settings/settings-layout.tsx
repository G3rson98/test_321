/** 22–26 · Configuración (solo administradores). Cada pestaña es una ruta (navegación compartible, ESP §17.1). */
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { PageHeader } from '@/components/common/page-header';
import { cn } from '@/lib/utils';

const TABS = [
  { to: '/configuracion/testrail', label: 'TestRail' },
  { to: '/configuracion/ambientes', label: 'Ambientes' },
  { to: '/configuracion/usuarios-prueba', label: 'Usuarios de prueba' },
  { to: '/configuracion/notificaciones', label: 'Notificaciones' },
  { to: '/configuracion/usuarios', label: 'Usuarios del panel' },
] as const;

export function SettingsLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <>
      <PageHeader title="Configuración" subtitle="Solo administradores" className="mb-8" />
      <nav aria-label="Secciones de configuración" className="mb-6 inline-flex max-w-full flex-wrap gap-1 rounded-lg bg-muted p-1">
        {TABS.map((t) => {
          const active = pathname.startsWith(t.to);
          return (
            <Link
              key={t.to}
              to={t.to}
              aria-current={active ? 'page' : undefined}
              className={cn('rounded-md px-3 py-1.5 text-[15px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50', active ? 'bg-secondary font-medium text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground')}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
      <Outlet />
    </>
  );
}
