import type { LogRecord, Sink } from "@amplio/amplio";

export const consoleJsonSink: Sink = (record: LogRecord) => {
  console.log(JSON.stringify(record));
};
