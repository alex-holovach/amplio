import type { Context, MiddlewareHandler, Next } from "hono";
import { createRequestLogger, getLogger, runWithLogger, type Logger } from "@useamplio/amplio";

const AMPLIO_KEY = "amplio";

export function amplioMiddleware(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const requestLogger = createRequestLogger({
      method: c.req.method,
      path: c.req.path,
    }).set({
      http: {
        route: c.req.routePath,
      },
    });

    c.set(AMPLIO_KEY, requestLogger);

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
          requestLogger.error(error, { status: 500 });
          requestLogger.emit();
        }
        throw error;
      }
    });
  };
}

// Accessor for the request logger. Named get*, not use*: this is not a React hook.
export function getRequestLogger(c: Context): Logger {
  return (c.get(AMPLIO_KEY) as Logger | undefined) ?? getLogger();
}

