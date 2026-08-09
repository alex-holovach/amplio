// Side-effect import: ensures init() from telemetry/logger runs in every module
// graph that uses this middleware (next dev --turbo compiles instrumentation.ts
// and route bundles separately, which would otherwise drop events silently).
import "../logger";

import {
  createRequestLogger,
  runWithLogger,
  scheduleFlush,
  useLogger,
  type Logger,
} from "@useamplio/amplio";
import type { NextRequest } from "next/server";

export interface WithAmplioOptions {
  waitUntil?: (promise: Promise<unknown>) => void;
}

export function withAmplio<T extends (request: NextRequest, ...args: any[]) => Promise<Response>>(
  handler: T,
  options?: WithAmplioOptions,
): T {
  const wrapped = (async (request: NextRequest, ...rest: any[]) => {
    const requestLogger = createRequestLogger({
      method: request.method,
      path: request.nextUrl.pathname,
    }).set({
      http: {
        search: request.nextUrl.search || undefined,
      },
    });

    return runWithLogger(requestLogger, async () => {
      try {
        const response = await handler(request, ...rest);
        if (!requestLogger.sealed) {
          requestLogger.set({
            http: { status: response.status },
            status: response.status,
          });
          requestLogger.emit();
          scheduleFlush(options);
        }
        return response;
      } catch (error) {
        if (!requestLogger.sealed) {
          requestLogger.error(error, { status: 500 });
          requestLogger.emit();
          scheduleFlush(options);
        }
        throw error;
      }
    });
  }) as T;

  return wrapped;
}

export function useRequestLogger(): Logger {
  return useLogger();
}
