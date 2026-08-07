import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { AuthUserSignedUp } from "../telemetry/events/auth/user-signed-up";
import { logger } from "../telemetry/logger";
import { logcnMiddleware, useRequestLogger } from "../telemetry/middleware/hono";

const app = new Hono();

app.use("*", logcnMiddleware());

app.get("/health", (c) => {
  useRequestLogger(c).set({ route: { name: "health" } });
  return c.json({ ok: true });
});

app.post("/signup", async (c) => {
  const body = await c.req.json<{ email: string }>();

  logger
    .event(AuthUserSignedUp)
    .set({
      user: { id: "user_demo", email: body.email },
      signup: { method: "email" },
    })
    .emit();

  useRequestLogger(c).set({ route: { name: "signup" }, user: { email: body.email } });
  return c.json({ created: true });
});

const port = Number(process.env.PORT ?? 3000);
console.log(`example-basic listening on http://127.0.0.1:${port}`);
serve({ fetch: app.fetch, port });
