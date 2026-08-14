import { createApp, failure, health } from "./app.js";
import { FastifyPlugin } from "../telemetry/plugins/fastify.js";

const app = createApp({
  requestBoundary: FastifyPlugin,
  health,
  failure,
});

const port = Number(process.env.PORT ?? 3002);
await app.listen({ port, host: "127.0.0.1" });
console.log(`fastify-smoke listening on http://127.0.0.1:${port}`);
