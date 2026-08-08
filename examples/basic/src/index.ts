import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { AuthUserSignedUp } from "../telemetry/events/auth/user-signed-up";
import { logger } from "../telemetry/logger";
import { amplioMiddleware, useRequestLogger } from "../telemetry/middleware/hono";

const app = new Hono();

app.use("*", amplioMiddleware());

app.get("/health", (c) => {
  useRequestLogger(c).set({ route: { name: "health" } });
  return c.json({ ok: true });
});

app.post("/signup", (c) => {
  logger
    .event(AuthUserSignedUp)
    .set({
      user: { id: "user_demo" },
      signup: { method: "email" },
    })
    .emit();

  useRequestLogger(c).set({ route: { name: "signup" } });
  return c.json({ created: true });
});

const port = Number(process.env.PORT ?? 3000);
console.log(`example-basic listening on http://127.0.0.1:${port}`);
serve({ fetch: app.fetch, port });
