import type { NextFunction, Request, Response } from "express";
import { createRequestLogger, getLogger, runWithLogger, type Logger } from "@useamplio/amplio";

declare global {
  namespace Express {
    interface Request {
      amplio?: Logger;
    }
  }
}

export function amplioMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const requestLogger = createRequestLogger({
      method: req.method,
      path: req.path,
    }).set({
      http: {
        route: req.route?.path,
        ip: req.ip,
        user_agent: req.get("user-agent") ?? undefined,
      },
    });

    req.amplio = requestLogger;

    runWithLogger(requestLogger, () => {
      res.on("finish", () => {
        if (requestLogger.sealed) {
          return;
        }
        requestLogger.set({
          http: { status: res.statusCode },
          status: res.statusCode,
        });
        requestLogger.emit();
      });

      next();
    });
  };
}

// Accessor for the request logger. Named get*, not use*: this is not a React hook.
export function getRequestLogger(req: Request): Logger {
  return req.amplio ?? getLogger();
}

/** @deprecated Use getRequestLogger() — same behavior, non-hook name. */
export const useRequestLogger = getRequestLogger;
