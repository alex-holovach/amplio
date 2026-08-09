import { init, logger } from "@useamplio/amplio";
import { consoleSink } from "./sinks/console";

init({
  service: process.env.SERVICE_NAME ?? "my-app",
  env: process.env.NODE_ENV ?? "development",
  enrichers: [],
  // sampling: { rate: 0.1, keep: [{ field: "success", equals: false }] },
  // see @useamplio/amplio README ## Sampling
  sinks: [consoleSink],
});

export { logger };
