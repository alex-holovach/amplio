import "../runtime.js";

import { openEvent, type EventScope } from "@useamplio/amplio/plugin";
import type { FastifyError, FastifyPluginAsync, FastifyRequest } from "fastify";
import { HttpRequest, resolveRequestId } from "../events/http-request.js";

interface PendingRequest {
  readonly scope: EventScope<typeof HttpRequest>;
  error?: FastifyError;
}

/** Register once before routes; ordinary Fastify handlers remain untouched. */
const implementation: FastifyPluginAsync = async (app) => {
  const pending = new WeakMap<FastifyRequest, PendingRequest>();

  app.addHook("onRequest", (request, _reply, done) => {
    const scope = openEvent(HttpRequest, {
      request_id: resolveRequestId(request.headers["x-request-id"]),
      http: { method: request.method },
    });
    pending.set(request, { scope });
    scope.run(done);
  });

  app.addHook("onError", (request, _reply, error, done) => {
    const state = pending.get(request);
    if (state) state.error = error;
    done();
  });

  app.addHook("onResponse", (request, reply, done) => {
    const state = pending.get(request);
    pending.delete(request);
    if (state) {
      const output = {
        http: {
          route: request.routeOptions.url,
          status: reply.statusCode,
        },
      };
      if (state.error) state.scope.fail(state.error, output);
      else {
        state.scope.finish(output, { success: reply.statusCode < 400 });
      }
    }
    done();
  });

  app.addHook("onRequestAbort", (request, done) => {
    const state = pending.get(request);
    pending.delete(request);
    if (state) {
      state.scope.update({
        http: { route: request.routeOptions.url },
      });
      state.scope.cancel("request_aborted");
    }
    done();
  });
};

Object.defineProperties(implementation, {
  [Symbol.for("skip-override")]: { value: true },
  [Symbol.for("fastify.display-name")]: { value: "amplio-fastify" },
});

export const FastifyPlugin = implementation;
