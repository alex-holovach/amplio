import { init } from "@useamplio/amplio";
import { consoleSink } from "./sinks/console";

init({
  service: process.env.SERVICE_NAME ?? "next-smoke",
  env: process.env.NODE_ENV ?? "development",
  enrichers: [],
  sinks: [consoleSink],
});
