import type { NextFunction, Request, Response } from "express";
import {createRequestLogger, runWithLogger, type Logger, getLogger} from "@useamplio/amplio";


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
        method: req.method,
        path: req.path,
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

export function useRequestLogger(req: Request): Logger {
  return req.amplio ?? getLogger();
}
