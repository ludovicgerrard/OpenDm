import { createPortal } from "react-dom";
import { useState } from "react";

/* Minimal toasts: App keeps one message at a time; auto-expiring. */
export function Toast({ toast }) {
  if (!toast) return null;
  return createPortal(
    <div className="fixed bottom-4 right-4 z-[60] toast-in rounded-lg border border-white/10 bg-zinc-900/95 px-3.5 py-2.5 text-[12px] text-zinc-100 shadow-xl backdrop-blur">
      {toast.msg}
    </div>,
    document.body,
  );
}

export function useToast() {
  const [toast, setToast] = useState(null);
  const notify = (msg) => {
    setToast({ msg, at: Date.now() });
    setTimeout(() => setToast((t) => (Date.now() - t.at >= 2300 ? null : t)), 2400);
  };
  return [toast, notify];
}
