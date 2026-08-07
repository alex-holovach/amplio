import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import {createRequestLogger, runWithLogger, type Logger, useLogger} from "@logcn/core";


declare module "fastify" {
  interface FastifyRequest {
    logcn?: Logger;
  }
}


const plugin: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", (request, _reply, done) => {
    const requestLogger = createRequestLogger({
      method: request.method,
      path: request.url,
    }).set({
      http: {
        method: request.method,
        path: request.url,
        route: request.routeOptions?.url,
        ip: request.ip,
        user_agent: request.headers["user-agent"],
      },
    });

    request.logcn = requestLogger;
    runWithLogger(requestLogger, () => done());
  });

  app.addHook("onResponse", async (request, reply) => {
    const requestLogger = request.logcn;
    if (!requestLogger || requestLogger.sealed) {
      return;
    }

    requestLogger.set({
      http: { status: reply.statusCode },
      status: reply.statusCode,
    });
    requestLogger.emit();
  });

  app.addHook("onError", async (request, _reply, error) => {
    const requestLogger = request.logcn;
    if (!requestLogger || requestLogger.sealed) {
      return;
    }

    requestLogger.error(error, { status: 500 });
    requestLogger.emit();
  });
};

export const logcnPlugin = fp(plugin, { name: "logcn" });

export function useRequestLogger(request: FastifyRequest): Logger {
  return request.logcn ?? useLogger();
}
