import type { ReactNode } from 'react';
import { roleAtLeast } from '@katalyst/shared/rbac';
import type { PanelRole } from '@katalyst/shared/enums';
import { useRole } from '@/lib/auth/session';
import { ForbiddenPage } from './error-pages';

/** Página que exige rol mínimo: muestra 403 en la misma URL. El servidor sigue siendo la autoridad. */
export function RoleGate({ min, children }: { min: PanelRole; children: ReactNode }) {
  const role = useRole();
  if (!role || !roleAtLeast(role, min)) return <ForbiddenPage />;
  return <>{children}</>;
}
