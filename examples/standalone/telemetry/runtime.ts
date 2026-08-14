import { init } from "@useamplio/amplio";
import { consoleSink } from "./sinks/console.js";

init({
  service: process.env.SERVICE_NAME ?? "example-standalone",
  env: process.env.NODE_ENV ?? "development",
  enrichers: [],
  sinks: [consoleSink],
});
