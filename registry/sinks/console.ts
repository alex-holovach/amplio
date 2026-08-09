import type { LogRecord, Sink } from "@useamplio/core";

export const consoleSink: Sink = (record: LogRecord) => {
  console.log(JSON.stringify(record));
};
