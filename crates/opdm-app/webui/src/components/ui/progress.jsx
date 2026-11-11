import { cn } from "../../lib/cn";

/** Slim progress bar. 300ms width transition (ticker cadence). */
export function Progress({ value = 0, indeterminate = false, className }) {
  const w = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-white/10", className)}>
      <div
        className={cn(
          "h-full rounded-full bg-gradient-to-r from-blue-500 to-blue-400 transition-[width] duration-300 ease-out",
          indeterminate && "indeterminate",
        )}
        style={{ width: indeterminate ? "30%" : `${w}%` }}
      />
    </div>
  );
}
