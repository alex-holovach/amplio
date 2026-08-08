import express from "express";
import { amplioMiddleware, useRequestLogger } from "../telemetry/middleware/express";
import "../telemetry/logger.js";

const app = express();

app.use(amplioMiddleware());

app.get("/health", (req, res) => {
  useRequestLogger(req).set({ route: { name: "health" } });
  res.json({ ok: true });
});

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
  console.log(`express-smoke listening on http://127.0.0.1:${port}`);
});
