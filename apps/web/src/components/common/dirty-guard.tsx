import { useBlocker } from '@tanstack/react-router';
import { ConfirmDialog } from './confirm-dialog';

/** Guarda de navegación para formularios con cambios sin guardar (ESP §17.1/§17.4). */
export function DirtyGuard({ when }: { when: boolean }) {
  const blocker = useBlocker({ shouldBlockFn: () => when, withResolver: true, enableBeforeUnload: () => when });
  return (
    <ConfirmDialog
      open={blocker.status === 'blocked'}
      onOpenChange={(o) => {
        if (!o) blocker.reset?.();
      }}
      title="Hay cambios sin guardar"
      description="Si sales ahora, se perderán los cambios de este formulario."
      confirmLabel="Salir sin guardar"
      tone="danger"
      onConfirm={() => blocker.proceed?.()}
    />
  );
}
