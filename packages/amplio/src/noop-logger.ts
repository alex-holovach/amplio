import { isDevelopment } from "./env.js";
import type { EventDef, EventLogger, LogRecord, Logger } from "./types.js";

type NoopReason = "sealed" | "no-context";

const warnNoop = (
  action: "set" | "error" | "emit" | "create" | "event",
  reason: NoopReason,
): void => {
  if (!isDevelopment() || reason !== "sealed") {
    return;
  }
  console.warn(`[amplio] logger.${action}() ignored: logger is sealed after emit()`);
};

const createNoopEventLogger = <T extends Record<string, unknown>>(
  reason: NoopReason,
): EventLogger<T> => {
  const eventLogger: EventLogger<T> = {
    get sealed() {
      return true;
    },
    set() {
      warnNoop("set", reason);
      return eventLogger;
    },
    error() {
      warnNoop("error", reason);
      return eventLogger;
    },
    emit(): LogRecord | null {
      warnNoop("emit", reason);
      return null;
    },
  };
  return eventLogger;
};

const createNoopLogger = (reason: NoopReason): Logger => {
  const logger: Logger = {
    get sealed() {
      return true;
    },
    set() {
      warnNoop("set", reason);
      return logger;
    },
    error() {
      warnNoop("error", reason);
      return logger;
    },
    emit(): LogRecord | null {
      warnNoop("emit", reason);
      return null;
    },
    create() {
      warnNoop("create", reason);
      return logger;
    },
    event<T extends Record<string, unknown>>(_def: EventDef<T>): EventLogger<T> {
      warnNoop("event", reason);
      return createNoopEventLogger<T>(reason);
    },
  };
  return logger;
};

let sealedNoop: Logger | undefined;
let contextNoop: Logger | undefined;

export function getSealedNoopLogger(): Logger {
  sealedNoop ??= createNoopLogger("sealed");
  return sealedNoop;
}

export function getContextNoopLogger(): Logger {
  contextNoop ??= createNoopLogger("no-context");
  return contextNoop;
}
