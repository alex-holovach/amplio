import { beforeEach, describe, expect, it } from "vitest";
import { init, resetConfigForTests, type AmplioConfig } from "../src/index.js";

beforeEach(() => {
  resetConfigForTests();
});

describe("init validation", () => {
  it("throws when service is missing", () => {
    expect(() => init({ env: "test", sinks: [() => {}] } as AmplioConfig)).toThrow(
      /service is required/,
    );
  });

  it("throws when env is missing", () => {
    expect(() => init({ service: "api", sinks: [() => {}] } as AmplioConfig)).toThrow(
      /env is required/,
    );
  });


  it("throws when service is empty", () => {
    expect(() => init({ service: "", env: "test", sinks: [() => {}] })).toThrow(
      /service is required/,
    );
  });

  it("throws when env is empty", () => {
    expect(() => init({ service: "api", env: "", sinks: [() => {}] })).toThrow(
      /env is required/,
    );
  });

  it("throws when service is whitespace-only", () => {
    expect(() => init({ service: "   ", env: "test", sinks: [() => {}] })).toThrow(
      /service is required/,
    );
  });

  it("throws when env is whitespace-only", () => {
    expect(() => init({ service: "api", env: "   ", sinks: [() => {}] })).toThrow(
      /env is required/,
    );
  });

  it("throws when sinks is empty", () => {
    expect(() => init({ service: "api", env: "test", sinks: [] })).toThrow(
      /at least one sink/,
    );
  });

  it("throws when sinks is null", () => {
    expect(() => init({ service: "api", env: "test", sinks: null as any })).toThrow(
      /at least one sink/,
    );
  });

  it("throws when sinks is a non-array", () => {
    expect(() => init({ service: "api", env: "test", sinks: "nope" as any })).toThrow(
      /at least one sink/,
    );
  });

  it("throws when sinks is omitted or undefined", () => {
    expect(() => init({ service: "api", env: "test" } as AmplioConfig)).toThrow(
      /at least one sink/,
    );
    expect(() =>
      init({ service: "api", env: "test", sinks: undefined } as unknown as AmplioConfig),
    ).toThrow(/at least one sink/);
  });
});
