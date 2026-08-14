import "../runtime.js";

import { openEvent, type EventScope } from "@useamplio/amplio/plugin";
import type { ErrorRequestHandler, RequestHandler } from "express";
import { HttpRequest, resolveRequestId } from "../events/http-request.js";

interface PendingRequest {
  readonly scope: EventScope<typeof HttpRequest>;
  error?: unknown;
  settled: boolean;
}

/**
 * Put the boundary first by spreading every returned route layer.
 * All supplied middleware and the final response lifecycle stay in one Event.
 */
export function withAmplioRoute(
  route: string,
  ...handlers: RequestHandler[]
): Array<RequestHandler | ErrorRequestHandler> {
  const pending = new WeakMap<object, PendingRequest>();

  const boundary: RequestHandler = (request, response, next) => {
    const scope = openEvent(HttpRequest, {
      request_id: resolveRequestId(request.get("x-request-id")),
      http: { method: request.method, route },
    });
    const state: PendingRequest = { scope, settled: false };
    pending.set(request, state);

    const settle = (closedEarly: boolean) => {
      if (state.settled) return;
      state.settled = true;
      response.off("finish", onFinish);
      response.off("close", onClose);
      pending.delete(request);
      const output = {
        http: { route, status: response.statusCode },
      };
      if (state.error !== undefined) {
        scope.fail(state.error, output);
      } else if (closedEarly && !response.writableFinished) {
        scope.update(output);
        scope.cancel("response_closed");
      } else {
        scope.finish(output, { success: response.statusCode < 400 });
      }
    };
    const onFinish = scope.bind(() => settle(false));
    const onClose = scope.bind(() => settle(true));
    response.once("finish", onFinish);
    response.once("close", onClose);

    scope.run(() => {
      try {
        next();
      } catch (error) {
        state.error = error;
        next(error);
      }
    });
    if (response.writableFinished || response.destroyed) {
      settle(response.destroyed && !response.writableFinished);
    }
  };

  const captureError: ErrorRequestHandler = (
    error,
    request,
    _response,
    next,
  ) => {
    const state = pending.get(request);
    if (state && error !== "route" && error !== "router") {
      state.error = error;
    }
    next(error);
  };

  return [boundary, ...handlers, captureError];
}
