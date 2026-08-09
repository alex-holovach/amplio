// Side-effect import: ensures init() from telemetry/logger runs in every module
// graph that uses this middleware (next dev --turbo compiles instrumentation.ts
// and route bundles separately, which would otherwise drop events silently).
import "../logger";

import {
  createRequestLogger,
  getLogger,
  runWithLogger,
  scheduleFlush,
  type Logger,
} from "@useamplio/amplio";
import type { NextRequest } from "next/server";

export interface WithAmplioOptions {
  waitUntil?: (promise: Promise<unknown>) => void;
}

// The `never[]` rest constraint accepts any handler shape (route context params
// included) without resorting to `any`, which trips lint/suspicious/noExplicitAny.
export function withAmplio<
  T extends (request: NextRequest, ...args: never[]) => Promise<Response>,
>(handler: T, options?: WithAmplioOptions): T {
  const wrapped = (async (request: NextRequest, ...rest: never[]) => {
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

// Server-side accessor for the ambient request logger. Named get*, not use*:
// this is not a React hook and never runs on the client.
export function getRequestLogger(): Logger {
  return getLogger();
}

/** @deprecated Use getRequestLogger() — same behavior, non-hook name. */
export const useRequestLogger = getRequestLogger;
