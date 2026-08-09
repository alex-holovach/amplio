import type { LogRecord, Sink } from "@useamplio/amplio";

export const consoleSink: Sink = (record: LogRecord) => {
  console.log(JSON.stringify(record));
};
