import Fastify, {
  type FastifyInstance,
  type FastifyPluginAsync,
  type RouteHandlerMethod,
} from "fastify";

export function createApp(routes: {
  requestBoundary: FastifyPluginAsync;
  health: RouteHandlerMethod;
  failure: RouteHandlerMethod;
}): FastifyInstance {
  const app = Fastify();
  app.register(routes.requestBoundary);
  app.addHook("onSend", (request, reply, payload, done) => {
    if (request.url.startsWith("/failure")) reply.code(503);
    done(null, payload);
  });
  app.get("/health", routes.health);
  app.get("/failure", routes.failure);
  return app;
}

export const health: RouteHandlerMethod = async () => ({ ok: true });
export const failure: RouteHandlerMethod = async () => ({ ok: false });
