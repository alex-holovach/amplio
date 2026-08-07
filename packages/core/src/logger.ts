import { resolveConfig } from "./config.js";
import { isDevelopment } from "./env.js";
import { deepMerge } from "./deep-merge.js";
import { validateShape } from "./schema.js";
import { shouldSample } from "./sampling.js";
import { redactRecord } from "./redact.js";
import { runSinksSync } from "./sinks.js";
import type {
  EventDef,
  EventLogger,
  LogRecord,
  Logger,
} from "./types.js";

type SealState = { sealed: boolean };

type InternalLogger = Logger & {
  _data: Record<string, unknown>;
  readonly _event?: string;
  readonly _shape?: EventDef["shape"];
  readonly _skipValidation?: boolean;
  readonly _startedAt: number;
  readonly _seal: SealState;
};

const warnSealed = (action: "set" | "emit" | "create" | "event"): void => {
  if (isDevelopment()) {
    console.warn(`[logcn] logger.${action}() ignored: logger is sealed after emit()`);
  }
};

const buildBaseFields = (): Record<string, unknown> => {
  const config = resolveConfig();
  return {
    service: config.service,
    env: config.env,
    timestamp: new Date().toISOString(),
  };
};

const finalizeRecord = (
  logger: InternalLogger,
  payload: Record<string, unknown>,
): LogRecord => {
  const config = resolveConfig();
  const record: LogRecord = {
    ...(buildBaseFields() as LogRecord),
    ...(payload as LogRecord),
  };

  record.duration_ms = Date.now() - logger._startedAt;

  if (record.success === undefined && record.status !== undefined) {
    const status = record.status;
    if (typeof status === "number") {
      record.success = status >= 200 && status < 400;
    } else if (typeof status === "string") {
      const code = Number(status);
      record.success = Number.isFinite(code) ? code >= 200 && code < 400 : status === "ok";
    }
  }

  if (record.success === undefined) {
    record.success = true;
  }

  return redactRecord(record, config.redact);
};

const emitInternal = (logger: InternalLogger): LogRecord => {
  const config = resolveConfig();

  let payload: Record<string, unknown> = { ...logger._data };

  for (const enricher of config.enrichers ?? []) {
    try {
      const next = enricher(payload as LogRecord);
      if (next == null || typeof next !== "object" || Array.isArray(next)) {
        if (isDevelopment()) {
          console.warn("[logcn] enricher failed: must return a plain object record");
        }
        continue;
      }
      payload = next as Record<string, unknown>;
    } catch (error) {
      if (isDevelopment()) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[logcn] enricher failed: ${message}`);
      }
    }
  }

  if (!logger._skipValidation && logger._shape) {
    const validated = validateShape(logger._shape, payload);
    // Keep enricher-added fields; validated shape fields win on overlap.
    payload = { ...payload, ...validated };
  }

  if (logger._event) {
    payload.event = logger._event;
    payload["@event"] = logger._event;
  }

  const record = finalizeRecord(logger, payload);

  if (shouldSample(record, config.sampling)) {
    runSinksSync(config.sinks, record);
  }

  return record;
};

const createInternalLogger = (
  state: Pick<InternalLogger, "_data" | "_startedAt" | "_seal"> &
    Partial<Pick<InternalLogger, "_event" | "_shape" | "_skipValidation">>,
): InternalLogger => {
  const logger = {
    _data: state._data,
    _startedAt: state._startedAt,
    _seal: state._seal,
    ...(state._event !== undefined ? { _event: state._event } : {}),
    ...(state._shape !== undefined ? { _shape: state._shape } : {}),
    ...(state._skipValidation !== undefined ? { _skipValidation: state._skipValidation } : {}),
    set(partial: Record<string, unknown>): Logger {
      if (logger._seal.sealed) {
        warnSealed("set");
        return logger;
      }
      logger._data = deepMerge(logger._data, partial);
      return logger;
    },
    emit(): LogRecord | null {
      if (logger._seal.sealed) {
        warnSealed("emit");
        return null;
      }
      const record = emitInternal(logger as InternalLogger);
      logger._seal.sealed = true;
      return record;
    },
    create(initial: Record<string, unknown> = {}): Logger | null {
      if (logger._seal.sealed) {
        warnSealed("create");
        return null;
      }
      return createInternalLogger({
        _data: deepMerge(logger._data, initial),
        _startedAt: logger._startedAt,
        _seal: { sealed: false },
        ...(logger._event !== undefined ? { _event: logger._event } : {}),
        ...(logger._shape !== undefined ? { _shape: logger._shape } : {}),
        ...(logger._skipValidation !== undefined ? { _skipValidation: logger._skipValidation } : {}),
      });
    },
    event<T extends Record<string, unknown>>(def: EventDef<T>): EventLogger<T> | null {
      if (logger._seal.sealed) {
        warnSealed("event");
        return null;
      }
      const bound = createInternalLogger({
        _data: deepMerge(logger._data, {}),
        _startedAt: logger._startedAt,
        _seal: logger._seal,
        _event: def.name,
        _shape: def.shape,
        _skipValidation: def.skipValidation,
      });

      const eventLogger: EventLogger<T> = {
        get sealed() {
          return bound.sealed;
        },
        set(partial: Partial<T>) {
          bound.set(partial as Record<string, unknown>);
          return eventLogger;
        },
        emit() {
          return bound.emit();
        },
      };

      return eventLogger;
    },
  } as InternalLogger;

  Object.defineProperty(logger, "sealed", {
    enumerable: true,
    get(): boolean {
      return logger._seal.sealed;
    },
  });

  return logger;
};

export function createLogger(initial: Record<string, unknown> = {}): Logger {
  return createInternalLogger({
    _data: deepMerge(buildBaseFields(), initial),
    _startedAt: Date.now(),
    _seal: { sealed: false },
  });
}

export interface LoggerFacade {
  create(initial?: Record<string, unknown>): Logger;
  event<T extends Record<string, unknown>>(
    def: EventDef<T>,
    initial?: Partial<T>,
  ): EventLogger<T>;
}

// Note: Logger.create/event soft-seal to null when the instance is sealed; facade always starts fresh.

export const logger: LoggerFacade = {
  create(initial = {}) {
    return createLogger(initial);
  },
  event(def, initial) {
    // Fresh logger is never sealed; non-null assertion keeps facade return type stable.
    const bound = createLogger().event(def)!;
    return initial ? bound.set(initial) : bound;
  },
};
