import {
  createRequestLogger,
  flush,
  runWithLogger,
  useLogger,
  type Logger,
} from "@amplio/core";
import type { NextRequest, NextResponse } from "next/server";

export interface WithAmplioOptions {
  waitUntil?: (promise: Promise<unknown>) => void;
}

let warnedNoWaitUntil = false;

function scheduleFlush(options?: WithAmplioOptions): void {
  if (options?.waitUntil) {
    options.waitUntil(flush());
    return;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { after } = require("next/server") as typeof import("next/server");
    if (typeof after === "function") {
      after(() => flush());
      return;
    }
  } catch {
    // next/server not available
  }

  void flush();

  const env = globalThis.process?.env?.NODE_ENV;
  if ((env === undefined || env === "development") && !warnedNoWaitUntil) {
    warnedNoWaitUntil = true;
    console.warn(
      "[amplio] async sinks may be cut off without waitUntil/after; pass waitUntil to withAmplio or call flush()",
    );
  }
}

export function withAmplio<T extends (request: NextRequest, ...args: never[]) => Promise<NextResponse>>(
  handler: T,
  options?: WithAmplioOptions,
): T {
  const wrapped = (async (request: NextRequest, ...rest: never[]) => {
    const requestLogger = createRequestLogger({
      method: request.method,
      path: request.nextUrl.pathname,
    }).set({
      http: {
        method: request.method,
        path: request.nextUrl.pathname,
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
