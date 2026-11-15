import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'
const v = cva('inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all active:scale-[.97] disabled:pointer-events-none disabled:opacity-50 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 [&_svg]:size-4 [&_svg]:shrink-0', {
  variants: { variant: { default: 'bg-primary text-primary-foreground hover:bg-primary/90', outline: 'border bg-card hover:bg-accent', ghost: 'hover:bg-accent', destructive: 'bg-destructive text-white hover:bg-destructive/90' },
    size: { default: 'h-9 px-4', sm: 'h-8 px-3 text-xs', lg: 'h-10 px-6', icon: 'size-9' } }, defaultVariants: { variant: 'default', size: 'default' } })
export const Button = ({ className, variant, size, ...p }: React.ComponentProps<'button'> & VariantProps<typeof v>) => <button className={cn(v({ variant, size }), className)} {...p} />
