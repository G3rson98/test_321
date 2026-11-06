import * as React from 'react';
import { Slot } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-[15px] font-medium transition-[color,background-color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90',
        outline: 'border border-border bg-secondary text-foreground shadow-xs hover:bg-muted',
        outlineCard: 'border border-border bg-card text-foreground shadow-xs hover:bg-muted',
        secondary: 'bg-secondary text-secondary-foreground shadow-xs hover:bg-muted',
        ghost: 'text-foreground hover:bg-muted',
        destructive: 'bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90',
        soft: 'bg-primary-soft text-primary-soft-foreground hover:bg-primary-soft/80',
        link: 'h-auto px-0 text-[13px] text-primary hover:underline',
      },
      size: {
        default: 'h-9 px-4',
        sm: 'h-8 px-3 text-[14px]',
        lg: 'h-10 px-6',
        icon: 'size-8 p-0',
        iconSm: 'size-7 p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps extends React.ComponentProps<'button'>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild = false, type, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button';
  return (
    <Comp
      data-slot="button"
      type={asChild ? undefined : (type ?? 'button')}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}
