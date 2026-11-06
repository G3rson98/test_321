import * as React from 'react';
import { Dialog as DialogPrimitive, AlertDialog as AlertPrimitive } from 'radix-ui';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { buttonVariants } from './button';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

const overlay =
  'fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0';
const content =
  'fixed top-[50%] left-[50%] z-50 grid max-h-[calc(100vh-2rem)] w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto rounded-lg border border-border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:max-w-lg';

export function DialogContent({
  className,
  children,
  showClose = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { showClose?: boolean }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={overlay} />
      <DialogPrimitive.Content className={cn(content, className)} {...props}>
        {children}
        {showClose ? (
          <DialogPrimitive.Close
            className="absolute top-4 right-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Cerrar"
          >
            <X className="size-4" />
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1.5 pr-6', className)} {...props} />;
}
export function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-wrap items-center justify-end gap-2', className)} {...props} />;
}
export function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn('text-lg font-semibold tracking-tight', className)} {...props} />;
}
export function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn('text-[14px] text-muted-foreground', className)} {...props} />;
}

/** Panel lateral (Sheet) sobre Dialog. */
export function SheetContent({ className, children, ...props }: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={overlay} />
      <DialogPrimitive.Content
        className={cn(
          'fixed inset-y-0 right-0 z-50 flex h-full w-full max-w-xl flex-col gap-4 overflow-y-auto border-l border-border bg-background p-6 shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right',
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="absolute top-4 right-4 rounded-sm opacity-70 hover:opacity-100" aria-label="Cerrar">
          <X className="size-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export const AlertDialog = AlertPrimitive.Root;
export const AlertDialogTrigger = AlertPrimitive.Trigger;
export function AlertDialogContent({ className, ...props }: React.ComponentProps<typeof AlertPrimitive.Content>) {
  return (
    <AlertPrimitive.Portal>
      <AlertPrimitive.Overlay className={overlay} />
      <AlertPrimitive.Content className={cn(content, className)} {...props} />
    </AlertPrimitive.Portal>
  );
}
export const AlertDialogTitle = ({ className, ...p }: React.ComponentProps<typeof AlertPrimitive.Title>) => (
  <AlertPrimitive.Title className={cn('text-lg font-semibold tracking-tight', className)} {...p} />
);
export const AlertDialogDescription = ({ className, ...p }: React.ComponentProps<typeof AlertPrimitive.Description>) => (
  <AlertPrimitive.Description className={cn('text-[14px] text-muted-foreground', className)} {...p} />
);
export const AlertDialogCancel = ({ className, ...p }: React.ComponentProps<typeof AlertPrimitive.Cancel>) => (
  <AlertPrimitive.Cancel className={cn(buttonVariants({ variant: 'ghost' }), className)} {...p} />
);
export const AlertDialogAction = AlertPrimitive.Action;
