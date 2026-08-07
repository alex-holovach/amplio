import Fastify from "fastify";
import { logcnPlugin, useRequestLogger } from "../telemetry/middleware/fastify";
import "../telemetry/logger.js";

const app = Fastify();

await app.register(logcnPlugin);

app.get("/health", async (request) => {
  useRequestLogger(request)?.set({ route: { name: "health" } });
  return { ok: true };
});

const port = Number(process.env.PORT ?? 3002);
await app.listen({ port, host: "127.0.0.1" });
console.log(`fastify-smoke listening on http://127.0.0.1:${port}`);
