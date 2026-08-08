import type { LogRecord, Sink } from "@amplio/core";

export const consoleSink: Sink = (record: LogRecord) => {
  console.log(JSON.stringify(record));
};
