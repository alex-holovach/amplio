import { describe, expect, it } from "vitest";
import { deepMerge } from "../src/deep-merge.js";

describe("deepMerge", () => {
  it("merges nested objects (user.id + user.plan)", () => {
    const base = { user: { id: "u_1" } };
    const patch = { user: { plan: "pro" } };

    expect(deepMerge(base, patch)).toEqual({
      user: { id: "u_1", plan: "pro" },
    });
    expect(base).toEqual({ user: { id: "u_1" } });
  });

  it("nested patch keeps sibling keys when overwriting", () => {
    const base = { user: { id: "1", plan: "free" } };
    const patch = { user: { plan: "pro" } };

    expect(deepMerge(base, patch)).toEqual({
      user: { id: "1", plan: "pro" },
    });
    expect(base).toEqual({ user: { id: "1", plan: "free" } });
  });

  it("replaces arrays instead of concatenating", () => {
    const base = { tags: ["a", "b"] };
    const patch = { tags: ["c"] };

    expect(deepMerge(base, patch)).toEqual({ tags: ["c"] });
    expect(base.tags).toEqual(["a", "b"]);
  });

  it("skips undefined in patch (keeps prior value)", () => {
    const base = { keep: "yes", drop: "no" };
    const patch = { drop: undefined };

    expect(deepMerge(base, patch)).toEqual({ keep: "yes", drop: "no" });
    expect(base).toEqual({ keep: "yes", drop: "no" });
  });

  it("overwrites with null", () => {
    const base = { value: "present", nested: { a: 1 } };
    const patch = { value: null, nested: null };

    expect(deepMerge(base, patch)).toEqual({ value: null, nested: null });
    expect(base).toEqual({ value: "present", nested: { a: 1 } });
  });
});
