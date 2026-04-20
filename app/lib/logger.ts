/**
 * Tiny structured logger inspired by pino. Emits `{level, time, evt, ...}`
 * JSON-ish objects to the console so devs can filter by `evt` in the
 * browser console. Not designed for high volume — we call it from code
 * paths that today use bare `console.warn` / `console.error`.
 *
 * Example:
 *   const log = logger.child({ module: "osd" });
 *   log.warn({ evt: "osd_failed", err: String(e) });
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_METHOD: Record<Level, "debug" | "info" | "warn" | "error"> = {
  debug: "debug",
  info: "info",
  warn: "warn",
  error: "error",
};

interface LogEntry {
  level: Level;
  time: number;
  [key: string]: unknown;
}

function emit(level: Level, base: Record<string, unknown>, fields: Record<string, unknown>) {
  const entry: LogEntry = {
    level,
    time: Date.now(),
    ...base,
    ...fields,
  };
  // eslint-disable-next-line no-console
  console[LEVEL_METHOD[level]](entry);
}

export interface Logger {
  debug: (fields: Record<string, unknown>) => void;
  info: (fields: Record<string, unknown>) => void;
  warn: (fields: Record<string, unknown>) => void;
  error: (fields: Record<string, unknown>) => void;
  child: (bindings: Record<string, unknown>) => Logger;
}

function make(base: Record<string, unknown>): Logger {
  return {
    debug: (fields) => emit("debug", base, fields),
    info: (fields) => emit("info", base, fields),
    warn: (fields) => emit("warn", base, fields),
    error: (fields) => emit("error", base, fields),
    child: (bindings) => make({ ...base, ...bindings }),
  };
}

export const logger: Logger = make({});
