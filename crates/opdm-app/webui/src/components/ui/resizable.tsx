import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { GripHorizontal } from 'lucide-react'
export const ResizablePanelGroup = PanelGroup
export const ResizablePanel = Panel
export const ResizableHandle = ({ withHandle }: { withHandle?: boolean }) => (
  <PanelResizeHandle className="relative flex h-px items-center justify-center bg-border transition-colors data-[resize-handle-state=drag]:bg-primary hover:bg-primary/60 after:absolute after:inset-x-0 after:-top-1 after:h-2">
    {withHandle && <div className="z-10 grid h-4 w-8 place-items-center rounded-sm border bg-card text-muted-foreground"><GripHorizontal className="size-3" /></div>}
  </PanelResizeHandle>)
