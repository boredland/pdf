import { useEffect } from "react";
import { createPortal } from "react-dom";

interface Props {
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  testId?: string;
}

export function ConfirmModal({
  title,
  message,
  confirmLabel = "Continue",
  cancelLabel = "Cancel",
  destructive,
  onConfirm,
  onCancel,
  testId = "confirm-modal",
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const content = (
    <div
      data-testid={testId}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md space-y-4 rounded-lg border border-slate-700 bg-slate-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold" data-testid={`${testId}-title`}>
          {title}
        </h2>
        <div className="text-sm text-slate-300" data-testid={`${testId}-body`}>
          {message}
        </div>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            data-testid={`${testId}-cancel`}
            onClick={onCancel}
            className="rounded border border-slate-700 px-3 py-1 text-sm text-slate-300 hover:bg-slate-800"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            data-testid={`${testId}-confirm`}
            onClick={onConfirm}
            className={`rounded px-3 py-1 text-sm font-medium ${
              destructive
                ? "bg-red-500/20 text-red-200 hover:bg-red-500/30"
                : "bg-sky-500/20 text-sky-200 hover:bg-sky-500/30"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );

  if (typeof document === "undefined") return null;
  return createPortal(content, document.body);
}
