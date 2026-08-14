import { init } from "@useamplio/amplio";
import { consoleSink } from "./sinks/console.js";

init({
  service: process.env.SERVICE_NAME ?? "express-smoke",
  env: process.env.NODE_ENV ?? "development",
  enrichers: [],
  sinks: [consoleSink],
});
