import * as L from '@radix-ui/react-label'
import { cn } from '@/lib/utils'
export const Label = ({ className, ...p }: React.ComponentProps<typeof L.Root>) => <L.Root className={cn('text-sm font-medium', className)} {...p} />
