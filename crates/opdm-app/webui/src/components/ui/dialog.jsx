import { cn } from "../../lib/cn";

export function Dialog({ open, onClose, title, children, footer, width = "w-[430px]" }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px] fade-in" onClick={onClose} />
      <div className={cn("relative rounded-xl border border-white/10 bg-zinc-900 text-zinc-100 shadow-2xl pop-in", width)}>
        <div className="border-b border-white/10 px-4 py-3 text-sm font-semibold">{title}</div>
        <div className="space-y-3 px-4 py-3">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-white/10 px-4 py-3">{footer}</div>
        )}
      </div>
    </div>
  );
}
