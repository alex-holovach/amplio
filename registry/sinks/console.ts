import type { LogRecord, Sink } from "@amplio/amplio";

export const consoleSink: Sink = (record: LogRecord) => {
  console.log(JSON.stringify(record));
};
