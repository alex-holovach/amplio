// Next dev --turbo compiles instrumentation and route bundles separately.
import "../runtime";

import type { NextRequest } from "next/server";
import { HttpRequest, resolveRequestId } from "../events/http-request";
import { PageRender } from "../events/page-render";

type RouteResult = Response | Promise<Response>;
type RouteHandler<A extends unknown[], R extends RouteResult> = (
  request: NextRequest,
  ...args: A
) => R;

export function withAmplio<A extends unknown[], R extends RouteResult>(
  route: string,
  handler: RouteHandler<A, R>,
): RouteHandler<A, R> {
  return HttpRequest.handle(handler, {
    input: ({ args: [request] }) => ({
      request_id: resolveRequestId(request.headers.get("x-request-id")),
      http: {
        method: request.method,
        route,
      },
    }),
    result: ({ result }) => ({
      http: { status: (result as Response).status },
    }),
    success: ({ result }) => (result as Response).status < 400,
  });
}

/** RSC render Plugin. The page implementation remains an ordinary function. */
export function withAmplioRender<A extends unknown[], R>(
  page: string,
  render: (...args: A) => R,
): (...args: A) => R {
  return PageRender.handle(render, {
    input: () => ({ page: { name: page } }),
  });
}
