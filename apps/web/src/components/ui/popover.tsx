import * as React from 'react';
import { Popover as PopoverPrimitive, Tooltip as TooltipPrimitive, DropdownMenu as MenuPrimitive } from 'radix-ui';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export function PopoverContent({ className, align = 'center', sideOffset = 6, ...props }: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-50 w-72 rounded-md border border-border bg-popover p-4 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

export const TooltipProvider = TooltipPrimitive.Provider;
/** Tooltip simple: `<Tip label="...">{trigger}</Tip>`. */
export function Tip({ label, children, side = 'top' }: { label: React.ReactNode; children: React.ReactElement; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <TooltipPrimitive.Root delayDuration={200}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={4}
          className="z-50 max-w-xs rounded-md bg-brand-ink px-2.5 py-1.5 text-[12.5px] text-[#eaebef] shadow-md data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0"
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;
export function DropdownMenuContent({ className, sideOffset = 4, ...props }: React.ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        sideOffset={sideOffset}
        className={cn('z-50 min-w-[10rem] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md', className)}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}
export function DropdownMenuItem({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.Item>) {
  return (
    <MenuPrimitive.Item
      className={cn('relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-[14px] outline-none select-none focus:bg-muted data-[disabled]:opacity-50', className)}
      {...props}
    />
  );
}
export function DropdownMenuCheckboxItem({ className, children, ...props }: React.ComponentProps<typeof MenuPrimitive.CheckboxItem>) {
  return (
    <MenuPrimitive.CheckboxItem
      className={cn('relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-[14px] outline-none select-none focus:bg-muted', className)}
      {...props}
    >
      <span className="absolute left-2 flex size-3.5 items-center justify-center">
        <MenuPrimitive.ItemIndicator>
          <Check className="size-4" />
        </MenuPrimitive.ItemIndicator>
      </span>
      {children}
    </MenuPrimitive.CheckboxItem>
  );
}
export function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.Label>) {
  return <MenuPrimitive.Label className={cn('px-2 py-1.5 label-mono', className)} {...props} />;
}
export const DropdownMenuSeparator = ({ className, ...p }: React.ComponentProps<typeof MenuPrimitive.Separator>) => (
  <MenuPrimitive.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...p} />
);
