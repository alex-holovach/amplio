import { resolveAlwaysSample, resolveConfig } from "./config.js";
import { createError } from "./error.js";
import { isDevelopment, isTest } from "./env.js";
import { getSealedNoopLogger } from "./noop-logger.js";
import { AmplioValidationError } from "./validation-error.js";
import { deepMerge } from "./deep-merge.js";
import { validateShape } from "./schema.js";
import { shouldSample } from "./sampling.js";
import { getCompiledRedact, redactRecord } from "./redact.js";
import { runSinksSync } from "./sinks.js";
import type {
  DeepPartial,
  EventDef,
  EventLogger,
  LogRecord,
  Logger,
  AmplioConfig,
} from "./types.js";

type SealState = { sealed: boolean };

type InternalLogger = Logger & {
  _data: Record<string, unknown>;
  _ownsData: boolean;
  _event?: string;
  _shape?: EventDef["shape"];
  _skipValidation?: boolean;
  _startedAt: number;
  _seal: SealState;
};

const warnSealed = (action: "set" | "error" | "emit" | "create" | "event"): void => {
  if (isDevelopment()) {
    console.warn(`[amplio] logger.${action}() ignored: logger is sealed after emit()`);
  }
};

let lastTimestampMs = 0;
let lastTimestampIso = "";

const getTimestampIso = (now: number): string => {
  if (now === lastTimestampMs) {
    return lastTimestampIso;
  }
  lastTimestampMs = now;
  lastTimestampIso = new Date(now).toISOString();
  return lastTimestampIso;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const ensureOwnership = (logger: InternalLogger): void => {
  if (!logger._ownsData) {
    logger._data = { ...logger._data };
    logger._ownsData = true;
  }
};

const finalizeRecord = (
  logger: InternalLogger,
  payload: Record<string, unknown>,
  config: AmplioConfig,
  now: number,
): LogRecord => {
  const compiledRedact = getCompiledRedact();
  const record =
    compiledRedact === false
      ? (payload as LogRecord)
      : redactRecord(payload as LogRecord);

  record.service = config.service;
  record.env = config.env;
  record.timestamp = getTimestampIso(now);
  record.duration_ms = now - logger._startedAt;

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

  return record;
};

const emitInternal = (logger: InternalLogger): LogRecord => {
  const config = resolveConfig();
  const enrichers = config.enrichers;
  let payload: Record<string, unknown>;
  let ownsPayload = logger._ownsData;

  if (enrichers && enrichers.length > 0) {
    if (!ownsPayload) {
      payload = { ...logger._data };
      ownsPayload = true;
    } else {
      payload = logger._data;
    }

    for (const enricher of enrichers) {
      try {
        const next = enricher(payload as LogRecord);
        if (next == null || typeof next !== "object" || Array.isArray(next)) {
          if (isDevelopment()) {
            console.warn("[amplio] enricher failed: must return a plain object record");
          }
          continue;
        }
        payload = next as Record<string, unknown>;
      } catch (error) {
        if (isDevelopment()) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[amplio] enricher failed: ${message}`);
        }
      }
    }
  } else {
    payload = logger._data;
  }

  if (!logger._skipValidation && logger._shape) {
    if (!ownsPayload) {
      payload = { ...payload };
      ownsPayload = true;
    }
    try {
      const validated = validateShape(logger._shape, payload);
      payload = { ...payload, ...validated };
    } catch (error) {
      if (!(error instanceof AmplioValidationError)) {
        throw error;
      }
      const throwOnFailure = isTest() || config.strict === true;
      if (throwOnFailure) {
        throw error;
      }
      payload = {
        ...payload,
        validation: {
          ok: false,
          issues: error.issues.map((issue) => ({
            message: issue.message,
            path: issue.path.map(String),
          })),
        },
        success: false,
      };
      if (isDevelopment()) {
        console.warn(`[amplio] emit() schema validation failed (soft): ${error.message}`);
      }
    }
  }

  if (logger._event) {
    if (!ownsPayload) {
      payload = { ...payload };
      ownsPayload = true;
    }
    payload.event = logger._event;
    payload["@event"] = logger._event;
  }

  if (!ownsPayload) {
    payload = { ...payload };
  }

  const now = Date.now();
  const record = finalizeRecord(logger, payload, config, now);

  if (resolveAlwaysSample() || shouldSample(record, config.sampling)) {
    runSinksSync(config.sinks, record);
  }

  return record;
};

class InternalLoggerImpl implements InternalLogger {
  _data: Record<string, unknown>;
  _ownsData: boolean;
  _startedAt: number;
  _seal: SealState;
  _event?: string;
  _shape?: EventDef["shape"];
  _skipValidation?: boolean;

  get sealed(): boolean {
    return this._seal.sealed;
  }

  constructor(state: {
    _data: Record<string, unknown>;
    _ownsData: boolean;
    _startedAt: number;
    _seal: SealState;
    _event?: string;
    _shape?: EventDef["shape"];
    _skipValidation?: boolean;
  }) {
    this._data = state._data;
    this._ownsData = state._ownsData;
    this._startedAt = state._startedAt;
    this._seal = state._seal;
    this._event = state._event;
    this._shape = state._shape;
    this._skipValidation = state._skipValidation;
  }

  set(partial: Record<string, unknown>): Logger {
    if (this._seal.sealed) {
      warnSealed("set");
      return this;
    }

    for (const key of Object.keys(partial)) {
      const value = partial[key];
      if (value === undefined) {
        continue;
      }
      if (isPlainObject(value)) {
        ensureOwnership(this);
        this._data = deepMerge(this._data, partial);
        return this;
      }
      if (this._ownsData) {
        if (!Object.is(this._data[key], value)) {
          this._data[key] = value;
        }
      } else if (!Object.is(this._data[key], value)) {
        ensureOwnership(this);
        this._data[key] = value;
      }
    }

    return this;
  }

  error(err: unknown, ctx?: Record<string, unknown>): Logger {
    if (this._seal.sealed) {
      warnSealed("error");
      return this;
    }
    const structuredError =
      err instanceof Error
        ? createError({ message: err.message, code: err.name })
        : createError({ message: String(err) });
    return this.set({ error: structuredError, success: false, ...ctx });
  }

  emit(): LogRecord | null {
    if (this._seal.sealed) {
      warnSealed("emit");
      return null;
    }
    const record = emitInternal(this);
    this._seal.sealed = true;
    return record;
  }

  create(initial: Record<string, unknown> = {}): Logger {
    if (this._seal.sealed) {
      return getSealedNoopLogger();
    }
    const merged = deepMerge(this._data, initial);
    return new InternalLoggerImpl({
      _data: merged,
      _ownsData: merged !== this._data,
      _startedAt: this._startedAt,
      _seal: { sealed: false },
      _event: this._event,
      _shape: this._shape,
      _skipValidation: this._skipValidation,
    });
  }

  event<T extends Record<string, unknown>>(def: EventDef<T>): EventLogger<T> {
    if (this._seal.sealed) {
      return getSealedNoopLogger().event(def);
    }
    const bound = new InternalLoggerImpl({
      _data: this._data,
      _ownsData: false,
      _startedAt: this._startedAt,
      _seal: this._seal,
      _event: def.name,
      _shape: def.shape,
      _skipValidation: def.skipValidation,
    });

    const eventLogger: EventLogger<T> = {
      get sealed() {
        return bound.sealed;
      },
      set(partial: DeepPartial<T>) {
        bound.set(partial as Record<string, unknown>);
        return eventLogger;
      },
      error(err: unknown, ctx?: Record<string, unknown>) {
        bound.error(err, ctx);
        return eventLogger;
      },
      emit() {
        return bound.emit();
      },
    };

    return eventLogger;
  }
}

export function createLogger(initial: Record<string, unknown> = {}): Logger {
  return new InternalLoggerImpl({
    _data: Object.keys(initial).length === 0 ? {} : { ...initial },
    _ownsData: true,
    _startedAt: Date.now(),
    _seal: { sealed: false },
  });
}

export interface LoggerFacade {
  create(initial?: Record<string, unknown>): Logger;
  event<T extends Record<string, unknown>>(
    def: EventDef<T>,
    initial?: DeepPartial<T>,
  ): EventLogger<T>;
}

export const logger: LoggerFacade = {
  create(initial = {}) {
    return createLogger(initial);
  },
  event(def, initial) {
    const bound = createLogger().event(def);
    return initial ? bound.set(initial) : bound;
  },
};
