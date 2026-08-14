import { Hono, type MiddlewareHandler } from "hono";
import type { SignUpInput } from "./signup.js";

export function createApp(dependencies: {
  signUp(input: SignUpInput): Promise<unknown>;
  requestPlugin: MiddlewareHandler;
}) {
  const app = new Hono();
  app.use("*", dependencies.requestPlugin);
  app.onError((error, context) =>
    context.json({ ok: false, message: error.message }, 418),
  );

  app.get("/health", (context) => context.json({ ok: true }));
  app.get("/returned-failure", (context) => context.json({ ok: false }, 503));
  app.get("/failure", () => {
    throw new Error("teapot");
  });

  app.post("/signup", async (context) => {
    await dependencies.signUp({
      id: "user_demo",
      email: "demo@example.com",
      method: "email",
    });
    return context.json({ created: true });
  });

  return app;
}
