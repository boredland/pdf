import { useEffect } from "react";
import { createPortal } from "react-dom";

interface Props {
  title: string;
  imageUrl: string | null;
  onClose: () => void;
  body?: React.ReactNode;
}

export function ImageModal({ title, imageUrl, onClose, body }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const content = (
    <div
      data-testid="image-modal"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4"
      onClick={onClose}
    >
      <div
        className="relative flex max-h-full max-w-6xl flex-col overflow-hidden rounded-lg border border-slate-700 bg-slate-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-slate-800 px-4 py-2">
          <h2 className="text-sm font-semibold" data-testid="image-modal-title">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            data-testid="image-modal-close"
            className="rounded px-2 py-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
            aria-label="Close"
          >
            Close
          </button>
        </header>
        <div className="flex min-h-0 flex-1 overflow-auto">
          {imageUrl && (
            <img
              src={imageUrl}
              alt={title}
              data-testid="image-modal-image"
              className="block h-auto max-h-[85vh] w-auto max-w-full object-contain"
            />
          )}
          {body}
        </div>
      </div>
    </div>
  );

  if (typeof document === "undefined") return null;
  return createPortal(content, document.body);
}
