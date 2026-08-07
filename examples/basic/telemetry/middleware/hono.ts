import type { Context, MiddlewareHandler, Next } from "hono";
import { createError, createRequestLogger, runWithLogger, useLogger, type Logger } from "@logcn/core";

const LOGCN_KEY = "logcn";

function formatError(error: unknown) {
  if (error instanceof Error) {
    return createError({ message: error.message, code: error.name });
  }
  return createError({ message: String(error) });
}

export function logcnMiddleware(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const requestLogger = createRequestLogger({
      method: c.req.method,
      path: c.req.path,
    }).set({
      http: {
        method: c.req.method,
        path: c.req.path,
        route: c.req.routePath,
      },
    });

    c.set(LOGCN_KEY, requestLogger);

    return runWithLogger(requestLogger, async () => {
      try {
        await next();
        if (!requestLogger.sealed) {
          requestLogger.set({
            http: { status: c.res.status },
            status: c.res.status,
          });
          requestLogger.emit();
        }
      } catch (error) {
        if (!requestLogger.sealed) {
          requestLogger.set({
            error: formatError(error),
            status: 500,
            success: false,
          });
          requestLogger.emit();
        }
        throw error;
      }
    });
  };
}

export function useRequestLogger(c: Context): Logger | undefined {
  return (c.get(LOGCN_KEY) as Logger | undefined) ?? useLogger();
}
