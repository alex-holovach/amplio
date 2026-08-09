import { init, logger } from "@useamplio/amplio";
import { consoleJsonSink } from "./sinks/json";

init({
  service: process.env.SERVICE_NAME ?? "example-basic",
  env: process.env.NODE_ENV ?? "development",
  enrichers: [],
  sinks: [consoleJsonSink],
});

export { logger };
