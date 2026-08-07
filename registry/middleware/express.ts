import type { NextFunction, Request, Response } from "express";
import { createError, createRequestLogger, runWithLogger, type Logger } from "@logcn/core";

declare global {
  namespace Express {
    interface Request {
      logcn?: Logger;
    }
  }
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return createError({ message: error.message, code: error.name });
  }
  return createError({ message: String(error) });
}

export function logcnMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const requestLogger = createRequestLogger({
      method: req.method,
      path: req.path,
    }).set({
      http: {
        method: req.method,
        path: req.path,
        route: req.route?.path,
        ip: req.ip,
        user_agent: req.get("user-agent") ?? undefined,
      },
    });

    req.logcn = requestLogger;

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

export function useRequestLogger(req: Request): Logger | undefined {
  return req.logcn;
}
