/**
 * Amplio tRPC middleware. Like create-t3-app's own trpc.ts, you likely never
 * need to read or modify this file — wire amplioTrpcMiddleware() into your
 * procedure bases and you're done.
 *
 * Product stance:
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

  // A batch has no single path — null the scalar fields so dashboards that
  // group by trpc.path never mix "the request was for X" with "X happened to
  // be first in a batch". The full list lives in trpc.procedures; a failing
  // procedure lands in trpc.failed_path (see annotateTrpcError).
  logger.set({
    trpc: {
      path: null,
      type: null,
      batched: true,
      batch_size: updated.length,
      procedures: updated.map((item) => `${item.type} ${item.path}`),
    },
  });
}

function isBatchedRequest(logger: Logger): boolean {
  return (batchedProcedures.get(logger)?.length ?? 0) > 1;
}

type ValidationIssue = { path: Array<string | number>; message: string };

// TRPCError wraps input-validation failures in a ZodError cause whose message
// is the full pretty-printed issue list — a multiline JSON blob that is hostile
// to columnar stores and log search. Detect that shape so the event can carry
// structured error.issues plus a short error.message instead.
function zodValidationIssues(error: unknown): ValidationIssue[] | null {
  if (error === null || typeof error !== "object") {
    return null;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (cause === null || typeof cause !== "object") {
    return null;
  }
  const issues = (cause as { issues?: unknown }).issues;
  if (!Array.isArray(issues) || issues.length === 0) {
    return null;
  }
  const mapped: ValidationIssue[] = [];
  for (const issue of issues) {
    if (issue === null || typeof issue !== "object") {
      return null;
    }
    const { path, message } = issue as { path?: unknown; message?: unknown };
    if (typeof message !== "string" || !Array.isArray(path)) {
      return null;
    }
    mapped.push({
      path: path.filter(
        (segment): segment is string | number =>
          typeof segment === "string" || typeof segment === "number",
      ),
      message,
    });
  }
  return mapped;
}

function shortValidationMessage(issues: ValidationIssue[]): string {
  const parts = issues
    .slice(0, 3)
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
    );
  const suffix = issues.length > 3 ? ` (+${issues.length - 3} more)` : "";
  return `input validation failed: ${parts.join("; ")}${suffix}`;
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
    const issues = zodValidationIssues(error);
    if (issues) {
      logger.set({ error: { message: shortValidationMessage(issues), issues } });
    }
    // On a batch, keep trpc.path null and record the failing procedure
    // separately — overwriting the batch path with the failer made group-bys
    // on trpc.path a half-truth.
    const trpcPatch = isBatchedRequest(logger)
      ? { failed_path: path, failed_type: type }
      : { path, type };
    const patch: Record<string, unknown> = {
      trpc: trpcPatch,
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
