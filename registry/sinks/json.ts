/**
 * Dev-grade JSONL sink — appendFileSync blocks the event loop.
 * Use sink-otlp for production. Path from AMPLIO_JSON_SINK_PATH env or option;
 * defaults to amplio.<env>.jsonl (e.g. amplio.development.jsonl) so dev rows
 * and build/production rows never interleave in one file. Add amplio*.jsonl
 * to .gitignore (amplio add sink json does this).
 */
import fs from "node:fs";
import path from "node:path";
import type { Sink, SinkRecord } from "@useamplio/amplio";

export interface JsonFileSinkOptions {
  path?: string;
}

export function jsonFileSink(options: JsonFileSinkOptions = {}): Sink {
  const explicitPath =
    options.path ?? (process.env.AMPLIO_JSON_SINK_PATH?.trim() || undefined);

  return (record: SinkRecord) => {
    const env = typeof record.env === "string" && record.env ? record.env : "dev";
    const filePath = explicitPath ?? `amplio.${env}.jsonl`;
    const dir = path.dirname(filePath);
    if (dir && dir !== ".") {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
  };
}
