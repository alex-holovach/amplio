import { init } from "@useamplio/amplio";
import { consoleSink } from "./sinks/console.js";

init({
  service: process.env.SERVICE_NAME ?? "my-app",
  env: process.env.NODE_ENV ?? "development",
  enrichers: [],
  // sampling: { rate: 0.1, keep: [{ field: "success", equals: false }] },
  // see @useamplio/amplio README ## Sampling
  sinks: [consoleSink],
});
