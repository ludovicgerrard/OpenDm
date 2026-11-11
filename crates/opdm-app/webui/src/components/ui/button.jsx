import { cn } from "../../lib/cn";

const BASE = "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors outline-none select-none focus-visible:ring-2 focus-visible:ring-blue-500/60 disabled:opacity-50 disabled:pointer-events-none";

const VARIANTS = {
  default: "bg-blue-600 text-white shadow-sm hover:bg-blue-500 active:bg-blue-700",
  outline: "border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10",
  ghost: "text-zinc-300 hover:bg-white/10 hover:text-zinc-100",
  danger: "text-red-400 hover:bg-red-500/10 hover:text-red-300",
};

const SIZES = {
  sm: "h-7 px-2.5 text-xs",
  md: "h-8 px-3 text-[13px]",
  icon: "h-7 w-7 p-0 text-[15px]",
};

export function Button({ className, variant = "ghost", size = "md", ...props }) {
  return <button className={cn(BASE, VARIANTS[variant] ?? VARIANTS.ghost, SIZES[size] ?? SIZES.md, className)} {...props} />;
}
