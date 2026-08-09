import { beforeEach, describe, expect, it } from "vitest";
import { createLogger, init, resetConfigForTests } from "../src/index.js";

const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T.*Z$/;

beforeEach(() => {
  resetConfigForTests();
});

describe("emit timestamp", () => {
  it("record.timestamp matches ISO-8601 UTC (YYYY-MM-DDTHH:mm:ss.sssZ)", () => {
    init({ service: "api", env: "test", sinks: [() => {}] });

    const record = createLogger().set({ route: "/health" }).emit();

    expect(record).not.toBeNull();
    expect(record!.timestamp).toMatch(ISO_8601_UTC);
    expect(() => new Date(record!.timestamp!).toISOString()).not.toThrow();
    expect(new Date(record!.timestamp!).toISOString()).toBe(record!.timestamp);
  });
});
