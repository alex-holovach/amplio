/**
 * Amplio tRPC middleware — product stance:
 * ONE wide event per unit of work: the HTTP wrapper (withAmplio) owns the request
 * wide event (the spine). This middleware ANNOTATES that event with trpc.* fields
 * instead of emitting a sibling record. Domain events emitted in procedures are
 * intentionally separate rows — do not duplicate fields across them.
 */
// Side-effect import: ensures init() from telemetry/logger runs in every module
// graph that uses this middleware (next dev --turbo compiles instrumentation.ts
// and route bundles separately, which would otherwise drop events silently).
import "../logger";

import {
  createLogger,
  createRequestId,
  getLogger,
  hasAmbientLogger,
  runWithLogger,
  scheduleFlush,
  trpcErrorHttpStatus,
  type Logger,
} from "@useamplio/amplio";

type TrpcProcedureType = "query" | "mutation" | "subscription";

type TrpcProcedureRef = { path: string; type: TrpcProcedureType };

const batchedProcedures = new WeakMap<Logger, TrpcProcedureRef[]>();

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

  // Count every invocation — a batch of two calls to the SAME procedure is two
  // units of work and must not be deduplicated away.
  const entry: TrpcProcedureRef = { path, type };
  const seen = batchedProcedures.get(logger) ?? [];
  const updated = [...seen, entry];
  batchedProcedures.set(logger, updated);

  if (updated.length === 1) {
    logger.set({ trpc: { path, type } });
    return;
  }

  const first = updated[0] ?? entry;
  logger.set({
    trpc: {
      path: first.path,
      type: first.type,
      batched: true,
      batch_size: updated.length,
      procedures: updated.map((item) => `${item.type} ${item.path}`),
    },
  });
}

function annotateTrpcError(
  logger: Logger,
  path: string,
  type: TrpcProcedureType,
  error: unknown,
  includeHttp: boolean,
): void {
  const status = trpcErrorHttpStatus(error);
  if (!logger.sealed) {
    logger.error(error, { status });
    const patch: Record<string, unknown> = {
      trpc: { path, type },
      status,
    };
    if (includeHttp) {
      patch.http = { status };
    }
    logger.set(patch);
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
    annotateTrpcError(logger, path, type, result.error, false);
  } else {
    logger.set({
      trpc: { path, type },
      status: 200,
    });
  }

  logger.emit();
  scheduleFlush();
}

export function amplioTrpcMiddleware() {
  return async <TResult>(opts: {
    path: string;
    type: TrpcProcedureType;
    next: () => Promise<TResult>;
  } & Record<string, unknown>): Promise<TResult> => {
    const { path, type, next } = opts;

    if (hasAmbientLogger()) {
      const logger = getLogger();
      annotateTrpcProcedure(logger, path, type);

      try {
        const result = await next();
        if (isFailedMiddlewareResult(result)) {
          annotateTrpcError(logger, path, type, result.error, true);
        }
        return result;
      } catch (error) {
        annotateTrpcError(logger, path, type, error, true);
        throw error;
      }
    }

    const requestLogger = createLogger({
      event: "trpc.request",
      "@event": "trpc.request",
      request_id: createRequestId(),
      transport: "server-caller",
    });

    return runWithLogger(requestLogger, async () => {
      annotateTrpcProcedure(requestLogger, path, type);

      try {
        const result = await next();
        finalizeStandaloneRequest(requestLogger, path, type, result);
        return result;
      } catch (error) {
        if (!requestLogger.sealed) {
          annotateTrpcError(requestLogger, path, type, error, false);
          requestLogger.emit();
          scheduleFlush();
        }
        throw error;
      }
    });
  };
}
