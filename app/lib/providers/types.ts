export interface OcrWord {
  text: string;
  bbox: { x: number; y: number; width: number; height: number };
  confidence: number;
}

export interface OcrLine {
  text: string;
  bbox: { x: number; y: number; width: number; height: number };
  words: OcrWord[];
}

export interface OcrResult {
  providerId: string;
  pageSize: { width: number; height: number };
  text: string;
  hocr: string;
  words: OcrWord[];
  lines: OcrLine[];
}

export interface ProviderCapabilities {
  layout: boolean;
  tables: boolean;
  handwriting: boolean;
}

export interface ProviderProgress {
  /** fractional progress 0-1 */
  ratio: number;
  /** raw status string (provider-specific) */
  label: string;
}

export interface RecognizeInput {
  /** the preprocessed page PNG as bytes */
  pngBytes: ArrayBuffer;
  pageIndex: number;
  language: string;
  signal?: AbortSignal;
  onProgress?: (p: ProviderProgress) => void;
}

export interface OcrProvider {
  id: string;
  label: string;
  kind: "local" | "hosted";
  capabilities: ProviderCapabilities;
  /**
   * Returns true if the provider can be used right now (e.g. hosted providers
   * with a valid API key). Local providers should always return true once
   * assets are cached.
   */
  isAvailable(): Promise<boolean>;
  recognize(input: RecognizeInput): Promise<OcrResult>;
  /** release any long-lived resources (workers, etc.). */
  dispose?(): Promise<void>;
}
