import { cn } from "../../lib/cn";

export function Input({ className, ...props }) {
  return (
    <input
      className={cn(
        "h-8 w-full rounded-lg border border-white/10 bg-black/30 px-2.5 text-[13px] text-zinc-100",
        "placeholder:text-zinc-500 outline-none transition focus:border-blue-500/60 focus:ring-2 focus:ring-blue-500/30",
        className,
      )}
      {...props}
    />
  );
}

export function Field({ label, children }) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">{label}</span>
      {children}
    </label>
  );
}
