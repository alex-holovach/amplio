/**
 * Amplio tRPC middleware — product stance:
 * ONE wide event per unit of work: the HTTP wrapper (withAmplio) owns the request
 * wide event (the spine). This middleware ANNOTATES that event with trpc.* fields
 * instead of emitting a sibling record. Domain events emitted in procedures are
 * intentionally separate rows — do not duplicate fields across them.
 */
import {
  createRequestLogger,
  flush,
  hasAmbientLogger,
  runWithLogger,
  useLogger,
  type Logger,
} from "@useamplio/amplio";

const TRPC_HTTP_STATUS: Record<string, number> = {
  PARSE_ERROR: 400,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_SUPPORTED: 405,
  TIMEOUT: 408,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  UNPROCESSABLE_CONTENT: 422,
  TOO_MANY_REQUESTS: 429,
  CLIENT_CLOSED_REQUEST: 499,
  INTERNAL_SERVER_ERROR: 500,
  NOT_IMPLEMENTED: 501,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
};

type TrpcProcedureType = "query" | "mutation" | "subscription";

type TrpcProcedureRef = { path: string; type: TrpcProcedureType };

const batchedProcedures = new WeakMap<Logger, TrpcProcedureRef[]>();

function trpcErrorStatus(error: unknown): number {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  ) {
    return TRPC_HTTP_STATUS[(error as { code: string }).code] ?? 500;
  }
  return 500;
}

function isFailedMiddlewareResult(
  result: unknown,
): result is { ok: false; error: unknown } {
  return (
    result !== null &&
    typeof result === "object" &&
    "ok" in result &&
    (result as { ok: unknown }).ok === false &&
    "error" in result
  );
}

function annotateTrpcProcedure(
  logger: Logger,
  path: string,
  type: TrpcProcedureType,
): void {
  if (logger.sealed) {
    return;
  }

  const entry: TrpcProcedureRef = { path, type };
  const seen = batchedProcedures.get(logger) ?? [];

  if (seen.length === 0) {
    batchedProcedures.set(logger, [entry]);
    logger.set({ trpc: { path, type } });
    return;
  }

  const isDuplicate = seen.some((item) => item.path === path && item.type === type);
  if (isDuplicate) {
    return;
  }

  const updated = [...seen, entry];
  batchedProcedures.set(logger, updated);
  const first = seen[0]!;
  logger.set({
    trpc: {
      path: first.path,
      type: first.type,
      batched: true,
      procedures: updated.map((item) => `${item.type} ${item.path}`),
    },
  });
}

function annotateTrpcError(
  logger: Logger,
  path: string,
  type: TrpcProcedureType,
  error: unknown,
): void {
  const status = trpcErrorStatus(error);
  if (!logger.sealed) {
    logger.error(error, { status });
    logger.set({
      trpc: { path, type },
      status,
      http: { status },
    });
  }
}

function finalizeStandaloneRequest(
  logger: Logger,
  path: string,
  type: TrpcProcedureType,
  result: unknown,
): void {
  if (logger.sealed) {
    return;
  }

  if (isFailedMiddlewareResult(result)) {
    annotateTrpcError(logger, path, type, result.error);
  } else {
    logger.set({
      trpc: { path, type },
      status: 200,
      http: { status: 200 },
    });
  }

  logger.emit();
  scheduleFlush();
}

let afterFn: ((task: () => unknown) => void) | undefined;
void import("next/server")
  .then((m) => {
    const a = (m as { after?: unknown }).after;
    if (typeof a === "function") {
      afterFn = a as typeof afterFn;
    }
  })
  .catch(() => {});

function scheduleFlush(): void {
  if (afterFn) {
    afterFn(() => flush());
    return;
  }
  void flush();
}

export function amplioTrpcMiddleware() {
  return async <TResult>(opts: {
    path: string;
    type: TrpcProcedureType;
    next: () => Promise<TResult>;
  } & Record<string, unknown>): Promise<TResult> => {
    const { path, type, next } = opts;

    if (hasAmbientLogger()) {
      const logger = useLogger();
      annotateTrpcProcedure(logger, path, type);

      try {
        const result = await next();
        if (isFailedMiddlewareResult(result)) {
          annotateTrpcError(logger, path, type, result.error);
        }
        return result;
      } catch (error) {
        annotateTrpcError(logger, path, type, error);
        throw error;
      }
    }

    const requestLogger = createRequestLogger({ method: "TRPC", path });

    return runWithLogger(requestLogger, async () => {
      annotateTrpcProcedure(requestLogger, path, type);

      try {
        const result = await next();
        finalizeStandaloneRequest(requestLogger, path, type, result);
        return result;
      } catch (error) {
        if (!requestLogger.sealed) {
          annotateTrpcError(requestLogger, path, type, error);
          requestLogger.emit();
          scheduleFlush();
        }
        throw error;
      }
    });
  };
}
