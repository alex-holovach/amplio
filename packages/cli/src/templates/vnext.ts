export function renderHttpRequestEventTemplate(): string {
  return `import { event } from "@useamplio/amplio";
import { z } from "zod";
// amplio:plugin-imports

export const HttpRequest = event({
  id: "http.request",
  version: 1,
  schema: z.object({
    request_id: z.string(),
    http: z.object({
      method: z.string(),
      route: z.string().optional(),
      status: z.number().int().optional(),
    }),
  }),
  tree: {
    // amplio:plugins
  },
});

export function resolveRequestId(value: unknown): string {
  if (typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    return value;
  }
  return crypto.randomUUID();
}
`;
}

export function renderHonoPluginTemplate(): string {
  return `import "../runtime.js";

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
`;
}
