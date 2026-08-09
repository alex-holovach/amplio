import { describe, expect, it } from "vitest";
import { eventNameToRelativePath } from "../src/utils/event-name.js";

describe("eventNameToRelativePath", () => {
  it("maps 2-segment names without duplicated domain prefix", () => {
    expect(eventNameToRelativePath("post.created")).toBe("events/post/created.ts");
    expect(eventNameToRelativePath("email.sent")).toBe("events/email/sent.ts");
  });

  it("maps 3+ segment names consistently", () => {
    expect(eventNameToRelativePath("auth.user.signed_up")).toBe(
      "events/auth/user-signed-up.ts",
    );
    expect(eventNameToRelativePath("post.latest.viewed")).toBe(
      "events/post/latest-viewed.ts",
    );
  });
});
