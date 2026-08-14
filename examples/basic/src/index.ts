import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { HonoPlugin } from "../telemetry/plugins/hono.js";
import { signUp } from "../telemetry/plugins/signup.js";

const app = createApp({ signUp, requestPlugin: HonoPlugin() });

const port = Number(process.env.PORT ?? 3000);
console.log(`example-basic listening on http://127.0.0.1:${port}`);
serve({ fetch: app.fetch, port });
