import * as S from '@radix-ui/react-switch'
import { cn } from '@/lib/utils'
export const Switch = ({ className, ...p }: React.ComponentProps<typeof S.Root>) => (
  <S.Root className={cn('inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-input transition-colors data-[state=checked]:bg-primary outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40', className)} {...p}>
    <S.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px]" /></S.Root>)
