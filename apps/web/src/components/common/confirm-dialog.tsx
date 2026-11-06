import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

/** Confirmación explícita para acciones irreversibles o críticas (sin éxito optimista). */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  tone = 'default',
  pending,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  tone?: 'default' | 'danger';
  pending?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => (!pending ? onOpenChange(o) : undefined)}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogTitle>{title}</AlertDialogTitle>
        {description ? <AlertDialogDescription asChild><div>{description}</div></AlertDialogDescription> : null}
        {children}
        <div className="flex flex-wrap justify-end gap-2">
          <AlertDialogCancel disabled={pending}>Volver</AlertDialogCancel>
          <Button variant={tone === 'danger' ? 'destructive' : 'default'} disabled={pending} onClick={onConfirm}>
            {pending ? <Loader2 className="animate-spin" /> : null}
            {confirmLabel}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
