import type { LogRecord, Sink } from "@amplio/core";

export const consoleJsonSink: Sink = (record: LogRecord) => {
  console.log(JSON.stringify(record));
};
