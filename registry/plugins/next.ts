import "../runtime.js";

import type { NextRequest } from "next/server";
import { HttpRequest, resolveRequestId } from "../events/http-request.js";

type NextHandler = (
  request: NextRequest,
  ...args: any[]
) => Response | Promise<Response>;

export function withAmplio<F extends NextHandler>(
  route: string,
  handler: F,
): F {
  return HttpRequest.handle(handler, {
    input: ({ args: [request] }) => ({
      request_id: resolveRequestId(request.headers.get("x-request-id")),
      http: {
        method: request.method,
        route,
      },
    }),
    result: ({ result }) => ({
      http: { status: result.status },
    }),
    success: ({ result }) => result.status < 400,
  });
}
