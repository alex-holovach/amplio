import type { LogRecord, Sink } from "@logcn/core";

export const consoleSink: Sink = (record: LogRecord) => {
  console.log(JSON.stringify(record));
};
