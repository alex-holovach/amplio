import fs from "node:fs";
import path from "node:path";
import type { LogRecord, Sink } from "@useamplio/core";

export interface JsonFileSinkOptions {
  path?: string;
}

export function jsonFileSink(options: JsonFileSinkOptions = {}): Sink {
  const filePath =
    options.path ?? (process.env.AMPLIO_JSON_SINK_PATH?.trim() || undefined) ?? "amplio.jsonl";

  return (record: LogRecord) => {
    const dir = path.dirname(filePath);
    if (dir && dir !== ".") {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
  };
}
