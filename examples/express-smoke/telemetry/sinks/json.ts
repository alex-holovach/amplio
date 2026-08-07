import type { LogRecord, Sink } from "@logcn/core";

export const consoleJsonSink: Sink = (record: LogRecord) => {
  console.log(JSON.stringify(record));
};
