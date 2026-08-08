import { init, logger } from "@amplio/core";
import { consoleJsonSink } from "./sinks/json";

init({
  service: process.env.SERVICE_NAME ?? "next-smoke",
  env: process.env.NODE_ENV ?? "development",
  enrichers: [],
  sinks: [consoleJsonSink],
});

export { logger };
