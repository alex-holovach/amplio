import { isInitialized, resolveAlwaysSample, resolveConfig } from "./config.js";
import { hasAmbientLogger } from "./context.js";
import { createError } from "./error.js";
import { isDevelopment, isTest } from "./env.js";
import { getGlobalState } from "./global-state.js";
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
  StructuredError,
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
  _rebindFrom?: string;
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

  if (config.canonicalKeyOnly === true && "@event" in record) {
    delete record.event;
  }

  return record;
};

const emitInternal = (logger: InternalLogger): LogRecord | null => {
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

  const delivered = resolveAlwaysSample() || shouldSample(record, config.sampling);
  if (!delivered) {
    return null;
  }

  runSinksSync(config.sinks, record);
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
  _rebindFrom?: string;

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
    _rebindFrom?: string;
  }) {
    this._data = state._data;
    this._ownsData = state._ownsData;
    this._startedAt = state._startedAt;
    this._seal = state._seal;
    this._event = state._event;
    this._shape = state._shape;
    this._skipValidation = state._skipValidation;
    this._rebindFrom = state._rebindFrom;
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
    let structuredError: StructuredError;
    if (err instanceof Error) {
      const input: StructuredError = { message: err.message, name: err.name };
      const code = (err as Error & { code?: unknown }).code;
      if (typeof code === "string" || typeof code === "number") {
        input.code = String(code);
      }
      structuredError = createError(input);
    } else if (isPlainObject(err) && typeof err.message === "string") {
      const input: StructuredError = { message: err.message };
      if (typeof err.name === "string") {
        input.name = err.name;
      }
      if (typeof err.why === "string") {
        input.why = err.why;
      }
      if (typeof err.fix === "string") {
        input.fix = err.fix;
      }
      if (typeof err.link === "string") {
        input.link = err.link;
      }
      const code = err.code;
      if (typeof code === "string" || typeof code === "number") {
        input.code = String(code);
      }
      structuredError = createError(input);
    } else {
      structuredError = createError({ message: String(err) });
    }
    return this.set({ error: structuredError, success: false, ...ctx });
  }

  emit(): LogRecord | null {
    if (this._seal.sealed) {
      warnSealed("emit");
      return null;
    }
    if (!isInitialized()) {
      if (isDevelopment()) {
        console.warn(
          '[amplio] emit() before init(): event dropped. Call init({ service, env, sinks }) once at startup — in Next.js, import your telemetry/logger from instrumentation.ts so it runs on boot. If init() already runs at boot but events still drop, a bundler may have loaded a separate copy of @useamplio/amplio into this module graph (e.g. next dev --turbo) — add a side-effect import "../logger" to the file that emits, and check that only one version of @useamplio/amplio is installed. See https://github.com/alex-holovach/amplio/blob/main/ALPHA.md.',
        );
      }
      return null;
    }
    if (this._rebindFrom && isDevelopment()) {
      console.warn(
        `[amplio] emitting .event("${this._event}") from a logger already bound to "${this._rebindFrom}" rebinds and seals it — no separate "${this._rebindFrom}" row will be emitted for this request. For a separate correlated domain event, use .child(EventDef) instead.`,
      );
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
      _startedAt: Date.now(),
      _seal: { sealed: false },
      _event: this._event,
      _shape: this._shape,
      _skipValidation: this._skipValidation,
    });
  }

  private bindEventLogger<T extends Record<string, unknown>>(
    def: EventDef<T>,
    options: {
      _data: Record<string, unknown>;
      _ownsData: boolean;
      _startedAt: number;
      _seal: SealState;
      _rebindFrom?: string;
    },
  ): EventLogger<T> {
    const bound = new InternalLoggerImpl({
      ...options,
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

  event<T extends Record<string, unknown>>(def: EventDef<T>): EventLogger<T> {
    if (this._seal.sealed) {
      return getSealedNoopLogger().event(def);
    }
    const parentEventName =
      this._event ??
      (typeof this._data["event"] === "string" ? this._data["event"] : undefined);
    const rebindFrom =
      parentEventName !== undefined && parentEventName !== def.name
        ? parentEventName
        : undefined;

    return this.bindEventLogger(def, {
      _data: this._data,
      _ownsData: false,
      _startedAt: this._startedAt,
      _seal: this._seal,
      _rebindFrom: rebindFrom,
    });
  }

  child<T extends Record<string, unknown>>(def: EventDef<T>): EventLogger<T> {
    const initial: Record<string, unknown> = {};
    const requestId = this._data.request_id;
    if (typeof requestId === "string") {
      initial.request_id = requestId;
    }

    return this.bindEventLogger(def, {
      _data: initial,
      _ownsData: true,
      _startedAt: Date.now(),
      _seal: { sealed: false },
    });
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
    let base: Record<string, unknown> = {};
    if (hasAmbientLogger()) {
      const store = getGlobalState().storage.getStore();
      if (store) {
        const data = (store as Partial<InternalLogger>)._data;
        if (data && typeof data.request_id === "string") {
          base = { request_id: data.request_id };
        }
      }
    }
    const bound = createLogger(base).event(def);
    return initial ? bound.set(initial) : bound;
  },
};
