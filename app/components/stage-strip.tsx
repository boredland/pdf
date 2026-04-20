import { useEffect, useState } from "react";
import type { Page, Stage } from "~/lib/storage/db";
import { readBlob } from "~/lib/storage/opfs";
import { readOcrResult } from "~/lib/pipeline/ocr-pipeline";
import { readMrcManifest } from "~/lib/pipeline/mrc-pipeline";
import { ImageModal } from "./image-modal";

interface Slot {
  stage: Stage;
  label: string;
  thumbDataUrl?: string;
  ready: boolean;
  getModal: () => Promise<ModalContent | null>;
}

interface ModalContent {
  title: string;
  imageUrl?: string;
  body?: React.ReactNode;
}

async function blobUrl(path: string | undefined): Promise<string | null> {
  if (!path) return null;
  const blob = await readBlob(path);
  if (!blob) return null;
  return URL.createObjectURL(blob);
}

function buildSlots(page: Page): Slot[] {
  const slots: Slot[] = [
    {
      stage: "render",
      label: "Render",
      thumbDataUrl: page.thumbnails?.render,
      ready: !!page.status.render,
      async getModal() {
        const url = await blobUrl(page.status.render?.artifactPath);
        return url ? { title: "Render", imageUrl: url } : null;
      },
    },
    {
      stage: "preprocess",
      label: "Preprocess",
      thumbDataUrl: page.thumbnails?.preprocess,
      ready: !!page.status.preprocess,
      async getModal() {
        const url = await blobUrl(page.status.preprocess?.artifactPath);
        return url ? { title: "Preprocess", imageUrl: url } : null;
      },
    },
    {
      stage: "detect",
      label: "Detect",
      thumbDataUrl: page.thumbnails?.detect,
      ready: !!page.status.detect,
      async getModal() {
        const overlayPath = page.status.detect?.overlayPath;
        const url = await blobUrl(overlayPath);
        return url ? { title: "Detect overlay", imageUrl: url } : null;
      },
    },
    {
      stage: "ocr",
      label: "OCR",
      thumbDataUrl: page.thumbnails?.ocr ?? page.thumbnails?.preprocess,
      ready: !!page.status.ocr,
      async getModal() {
        const result = await readOcrResult(page.projectId, page.index);
        if (!result) return null;
        const imageUrl = await blobUrl(page.status.preprocess?.artifactPath);
        const body = (
          <div
            data-testid="image-modal-ocr-text"
            className="max-h-[85vh] min-w-[20rem] overflow-auto border-l border-slate-800 bg-slate-950 p-4 text-xs text-slate-200"
          >
            <p className="mb-2 text-[10px] uppercase tracking-wide text-slate-500">
              {result.words.length} words · {result.providerId}
            </p>
            <pre className="whitespace-pre-wrap break-words">{result.text}</pre>
          </div>
        );
        return {
          title: `OCR — ${result.providerId}`,
          imageUrl: imageUrl ?? undefined,
          body,
        };
      },
    },
    {
      stage: "mrc",
      label: "MRC",
      thumbDataUrl: page.thumbnails?.mrc,
      ready: !!page.status.mrc,
      async getModal() {
        const manifest = await readMrcManifest(page.projectId, page.index);
        if (!manifest) return null;
        const url = await blobUrl(manifest.composedPath);
        return url
          ? {
              title: `MRC composed · ${(
                (manifest.maskBytes + manifest.bgBytes) /
                1024
              ).toFixed(0)} KB`,
              imageUrl: url,
            }
          : null;
      },
    },
  ];
  return slots;
}

export function StageStrip({ page }: { page: Page }) {
  const [modal, setModal] = useState<ModalContent | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const slots = buildSlots(page);

  useEffect(() => {
    if (!modalOpen) {
      // Revoke any blob URL on close.
      if (modal?.imageUrl && modal.imageUrl.startsWith("blob:")) {
        URL.revokeObjectURL(modal.imageUrl);
      }
      setModal(null);
    }
  }, [modalOpen, modal]);

  async function onOpen(slot: Slot) {
    const content = await slot.getModal();
    if (!content) return;
    setModal(content);
    setModalOpen(true);
  }

  return (
    <>
      <ul
        className="mt-2 grid grid-cols-5 gap-1"
        data-testid={`stage-strip-${page.index}`}
      >
        {slots.map((slot) => (
          <li key={slot.stage}>
            <button
              type="button"
              onClick={() => void onOpen(slot)}
              disabled={!slot.ready}
              data-testid={`stage-thumb-${page.index}-${slot.stage}`}
              className={`group relative block aspect-square w-full overflow-hidden rounded border text-left transition ${
                slot.ready
                  ? "border-slate-700 hover:border-sky-400"
                  : "border-slate-800 opacity-40"
              }`}
              title={`${slot.label}${slot.ready ? "" : " (not yet)"}`}
              aria-label={`Open ${slot.label}`}
            >
              {slot.thumbDataUrl ? (
                <img
                  src={slot.thumbDataUrl}
                  alt={slot.label}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full items-center justify-center text-[9px] uppercase tracking-wide text-slate-600">
                  {slot.label}
                </div>
              )}
              <span className="absolute inset-x-0 bottom-0 bg-slate-950/70 py-0.5 text-center text-[9px] font-medium uppercase tracking-wide text-slate-300">
                {slot.label}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {modalOpen && modal && (
        <ImageModal
          title={modal.title}
          imageUrl={modal.imageUrl ?? null}
          body={modal.body}
          onClose={() => setModalOpen(false)}
        />
      )}
    </>
  );
}
