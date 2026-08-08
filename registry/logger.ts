import { init, logger, type LogRecord, type Sink } from "@amplio/core";
import { consoleSink } from "./sinks/console";

type Enricher = (record: LogRecord) => LogRecord;

function composeSinks(enrichers: Enricher[], sinks: Sink[]): Sink[] {
  if (enrichers.length === 0) {
    return sinks;
  }

  return sinks.map((sink) => (record) => sink(enrichers.reduce((acc, enrich) => enrich(acc), record)));
}

init({
  service: process.env.SERVICE_NAME ?? "my-app",
  env: process.env.NODE_ENV ?? "development",
  sinks: composeSinks([], [consoleSink]),
});

export { logger };
