import type { LogRecord, Sink } from "./types.js";

export interface MemorySink extends Sink {
  /** Records delivered to this sink, in emit order (post enrich/redact/sample). */
  records: LogRecord[];
  /** Empty the buffer — call between tests. */
  clear(): void;
}

/**
 * In-memory sink for tests: wire it into init() and assert on `sink.records`.
 *
 *   const sink = memorySink();
 *   init({ service: "api", env: "test", sinks: [sink] });
 *   // …exercise code…
 *   expect(sink.records[0]).toMatchObject({ "@event": "post.created" });
 *
 * Under NODE_ENV=test schema validation hard-throws (instead of soft-tagging
 * the record), so a payload that violates its event schema fails the test.
 */
export function memorySink(): MemorySink {
  const records: LogRecord[] = [];
  const sink = ((record: LogRecord): void => {
    records.push(record);
  }) as MemorySink;
  sink.records = records;
  sink.clear = () => {
    records.length = 0;
  };
  return sink;
}
