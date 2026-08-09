import type { LogRecord, Sink } from "@useamplio/amplio";

export const consoleJsonSink: Sink = (record: LogRecord) => {
  console.log(JSON.stringify(record));
};
