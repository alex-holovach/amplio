import { createError, createRequestLogger, runWithLogger, type Logger } from "@logcn/core";
import type { NextRequest, NextResponse } from "next/server";

let activeLogger: Logger | undefined;

function formatError(error: unknown) {
  if (error instanceof Error) {
    return createError({ message: error.message, code: error.name });
  }
  return createError({ message: String(error) });
}

export function withLogcn<T extends (request: NextRequest, ...args: never[]) => Promise<NextResponse>>(
  handler: T,
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
      activeLogger = requestLogger;
      try {
        const response = await handler(request, ...rest);
        if (!requestLogger.sealed) {
          requestLogger.set({
            http: { status: response.status },
            status: response.status,
          });
          requestLogger.emit();
        }
        return response;
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
      } finally {
        activeLogger = undefined;
      }
    });
  }) as T;

  return wrapped;
}

export function useRequestLogger(): Logger | undefined {
  return activeLogger;
}
