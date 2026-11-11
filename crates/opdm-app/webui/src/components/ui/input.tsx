import * as React from 'react'
import { cn } from '@/lib/utils'
export const Input = ({ className, ...p }: React.ComponentProps<'input'>) => <input className={cn('h-9 w-full min-w-0 rounded-md border bg-card px-3 text-sm outline-none transition-[box-shadow,border-color] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30', className)} {...p} />
