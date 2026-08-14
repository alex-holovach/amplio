import express, {
  type ErrorRequestHandler,
  type Express,
  type RequestHandler,
} from "express";

export function createApp(routes: {
  health: Array<RequestHandler | ErrorRequestHandler>;
  delayedFailure: Array<RequestHandler | ErrorRequestHandler>;
  delegatedFailure: Array<RequestHandler | ErrorRequestHandler>;
}): Express {
  const app = express();
  app.get("/health", ...routes.health);
  app.get("/failure", ...routes.delayedFailure);
  app.get("/delegated-failure", ...routes.delegatedFailure);
  const errorHandler: ErrorRequestHandler = (
    error,
    _request,
    response,
    _next,
  ) => {
    response.status(418).json({ ok: false, message: String(error?.message) });
  };
  app.use(errorHandler);
  return app;
}

export const health: RequestHandler = (_request, response) => {
  response.json({ ok: true });
};

export const delayedFailure: RequestHandler = (_request, response) => {
  setTimeout(() => response.status(503).json({ ok: false }), 20);
};

export const delegatedFailure: RequestHandler = (_request, _response, next) => {
  next(new Error("delegated"));
};
