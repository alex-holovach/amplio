import { describe, expect, it } from "vitest";
import { createRequestId } from "../src/legacy.js";

describe("createRequestId", () => {
  it("matches req_<time>_<rand> and is unique", () => {
    const id = createRequestId();
    expect(id).toMatch(/^req_[a-z0-9]+_[a-z0-9]+$/);
    expect(createRequestId()).not.toBe(id);
  });
});
