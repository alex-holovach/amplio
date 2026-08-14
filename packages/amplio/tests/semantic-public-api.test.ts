import { describe, expect, it } from "vitest";
import * as core from "../src/index.js";
import * as authoring from "../src/plugin.js";

describe("semantic public API", () => {
  it("exposes only Event semantics on main and Plugin authoring on its subpath", () => {
    for (const name of ["event", "init", "flush"] as const) {
      expect(core, name).toHaveProperty(name);
    }

    for (const name of [
      "defineFact",
      "defineOperation",
      "defineWorkload",
      "group",
      "optional",
      "many",
      "logger",
      "createLogger",
      "createRequestLogger",
      "getLogger",
      "useLogger",
      "runWithLogger",
    ] as const) {
      expect(core, name).not.toHaveProperty(name);
    }

    expect(authoring).toHaveProperty("plugin");
    expect(core).not.toHaveProperty("plugin");
  });

  it("init configures by side effect and does not hand application code a logger", () => {
    expect(
      core.init({ service: "api", env: "test", sinks: [() => undefined] }),
    ).toBeUndefined();
  });
});
