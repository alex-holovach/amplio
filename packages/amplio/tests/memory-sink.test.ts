import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createLogger,
  defineEvent,
  init,
  memorySink,
  resetConfigForTests,
} from "../src/legacy.js";

const PostCreated = defineEvent(
  "post.created",
  z.object({ post: z.object({ id: z.string() }) }),
);

describe("memorySink", () => {
  beforeEach(() => {
    resetConfigForTests();
  });

  it("captures delivered records in emit order", () => {
    const sink = memorySink();
    init({ service: "test", env: "test", sinks: [sink] });

    createLogger().set({ a: 1 }).emit();
    createLogger().event(PostCreated).set({ post: { id: "p1" } }).emit();

    expect(sink.records).toHaveLength(2);
    expect(sink.records[0]).toMatchObject({ a: 1, service: "test" });
    expect(sink.records[1]).toMatchObject({
      "@event": "post.created",
      post: { id: "p1" },
    });
  });

  it("clear() empties the buffer without breaking the sink reference", () => {
    const sink = memorySink();
    init({ service: "test", env: "test", sinks: [sink] });

    createLogger().set({ a: 1 }).emit();
    expect(sink.records).toHaveLength(1);

    sink.clear();
    expect(sink.records).toHaveLength(0);

    createLogger().set({ b: 2 }).emit();
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({ b: 2 });
  });

  it("records reflect the post-redaction pipeline output", () => {
    const sink = memorySink();
    init({ service: "test", env: "test", sinks: [sink] });

    createLogger().set({ password: "hunter2" }).emit();

    expect(sink.records[0]!.password).toBe("[REDACTED]");
  });
});
