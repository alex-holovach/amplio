import type { RequestHandler } from "express";
import { createApp, delayedFailure, delegatedFailure, health } from "./app.js";
import { authenticate } from "../telemetry/plugins/auth.js";
import { withAmplioRoute } from "../telemetry/plugins/express.js";

const requireAuth: RequestHandler = (_request, _response, next) => {
  void authenticate().then(() => next(), next);
};

const app = createApp({
  health: withAmplioRoute("/health", requireAuth, health),
  delayedFailure: withAmplioRoute("/failure", requireAuth, delayedFailure),
  delegatedFailure: withAmplioRoute(
    "/delegated-failure",
    requireAuth,
    delegatedFailure,
  ),
});

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
  console.log(`express-smoke listening on http://127.0.0.1:${port}`);
});
