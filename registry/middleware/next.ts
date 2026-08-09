// Side-effect import: ensures init() from telemetry/logger runs in every module
// graph that uses this middleware (next dev --turbo compiles instrumentation.ts
// and route bundles separately, which would otherwise drop events silently).
import "../logger";

import {
  createLogger,
  createRequestId,
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

// Next throws for control flow (redirect(), notFound()); those errors carry a
// digest and are not render failures.
function nextControlFlowDigest(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "digest" in error) {
    const digest = (error as { digest?: unknown }).digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_")) {
      return digest;
    }
  }
  return undefined;
}

/**
 * RSC render spine. Server components do not pass through withAmplio, so a
 * page render otherwise produces uncorrelated rows: standalone trpc.request
 * spines per server-caller call and request_id-less facade events. Wrapping
 * the page establishes an ambient `page.render` spine — amplioTrpcMiddleware
 * annotates it instead of creating standalone spines, and logger.event(Def)
 * rows emitted during the render share its request_id.
 *
 *   // src/app/page.tsx
 *   export default withAmplioRender("home", async function Home() { … });
 *
 * Note: `next build` static generation also runs the render — those rows are
 * tagged `build_phase: true` by the runtime.
 */
export function withAmplioRender<A extends never[], R>(
  page: string,
  render: (...args: A) => R | Promise<R>,
  options?: WithAmplioOptions,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    const renderLogger = createLogger({
      event: "page.render",
      "@event": "page.render",
      request_id: createRequestId(),
      page: { name: page },
    });

    return runWithLogger(renderLogger, async () => {
      try {
        const result = await render(...args);
        if (!renderLogger.sealed) {
          renderLogger.set({ success: true });
          renderLogger.emit();
          scheduleFlush(options);
        }
        return result;
      } catch (error) {
        if (!renderLogger.sealed) {
          const digest = nextControlFlowDigest(error);
          if (digest) {
            // redirect()/notFound() — record the outcome, not a failure.
            renderLogger.set({ page: { interrupted: digest } });
          } else {
            renderLogger.error(error);
          }
          renderLogger.emit();
          scheduleFlush(options);
        }
        throw error;
      }
    });
  };
}
