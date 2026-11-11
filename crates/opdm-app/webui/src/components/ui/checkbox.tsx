import * as C from '@radix-ui/react-checkbox'
import { Check, Minus } from 'lucide-react'
import { cn } from '@/lib/utils'
export const Checkbox = ({ className, ...p }: React.ComponentProps<typeof C.Root>) => (
  <C.Root className={cn('grid size-4 shrink-0 place-items-center rounded-[4px] border border-muted-foreground/50 bg-card transition-all data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary focus-visible:ring-[3px] focus-visible:ring-ring/40 outline-none', className)} {...p}>
    <C.Indicator className="text-primary-foreground animate-in zoom-in-50 duration-150">{p.checked === 'indeterminate' ? <Minus className="size-3" /> : <Check className="size-3" />}</C.Indicator>
  </C.Root>)
