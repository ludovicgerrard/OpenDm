import { cn } from "../../lib/cn";

const TONES = {
  zinc:    "bg-zinc-500/15 text-zinc-300 ring-white/10",
  blue:    "bg-blue-500/15 text-blue-300 ring-blue-400/20",
  amber:   "bg-amber-500/15 text-amber-300 ring-amber-400/20",
  emerald: "bg-emerald-500/15 text-emerald-300 ring-emerald-400/20",
  red:     "bg-red-500/15 text-red-300 ring-red-400/20",
};

export function Badge({ tone = "zinc", className, children, withDot = false }) {
  const dot = {
    zinc: "bg-zinc-400", blue: "bg-blue-400", amber: "bg-amber-400",
    emerald: "bg-emerald-400", red: "bg-red-400",
  }[tone] ?? "bg-zinc-400";
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide ring-1 ring-inset",
      TONES[tone] ?? TONES.zinc,
      className,
    )}>
      {withDot && <span className={cn("h-1.5 w-1.5 rounded-full", dot, tone === "blue" && "animate-pulse")} />}
      {children}
    </span>
  );
}
