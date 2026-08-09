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
  return async ({
    path,
    type,
    next,
  }: {
    path: string;
    type: "query" | "mutation" | "subscription";
    next: () => Promise<unknown>;
  }) => {
    if (hasAmbientLogger()) {
      const logger = useLogger();
      logger.set({ trpc: { path, type } });

      try {
        return await next();
      } catch (error) {
        const status = trpcErrorStatus(error);
        if (!logger.sealed) {
          logger.error(error, { status });
          logger.set({
            trpc: { path, type },
            status,
            http: { status },
          });
        }
        throw error;
      }
    }

    const requestLogger = createRequestLogger({ method: "TRPC", path });

    return runWithLogger(requestLogger, async () => {
      requestLogger.set({ trpc: { path, type } });

      try {
        const result = await next();
        if (!requestLogger.sealed) {
          requestLogger.set({
            trpc: { path, type },
            status: 200,
            http: { status: 200 },
          });
          requestLogger.emit();
          scheduleFlush();
        }
        return result;
      } catch (error) {
        const status = trpcErrorStatus(error);
        if (!requestLogger.sealed) {
          requestLogger.error(error, { status });
          requestLogger.set({
            trpc: { path, type },
            status,
            http: { status },
          });
          requestLogger.emit();
          scheduleFlush();
        }
        throw error;
      }
    });
  };
}
