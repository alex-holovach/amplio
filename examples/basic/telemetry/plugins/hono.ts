import "../runtime.js";

import type { Context, MiddlewareHandler, Next } from "hono";
import { HttpRequest, resolveRequestId } from "../events/http-request.js";

const handleRequest = HttpRequest.handle(
  async (context: Context, next: Next) => {
    await next();
  },
  {
    input: ({ args: [context] }) => ({
      request_id: resolveRequestId(context.req.header("x-request-id")),
      http: { method: context.req.method },
    }),
    result: ({ args: [context] }) => ({
      http: {
        route: context.req.routePath || undefined,
        status: context.res.status,
      },
    }),
    success: ({ args: [context] }) => context.res.status < 400,
    error: ({ args: [context] }) => ({
      http: {
        route: context.req.routePath || undefined,
      },
    }),
  },
);

/** Hono boundary Plugin: application handlers remain ordinary Hono handlers. */
export function HonoPlugin(): MiddlewareHandler {
  return handleRequest;
}
