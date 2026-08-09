import { describe, expect, it } from "vitest";
import { assertValidEventName, eventNameToRelativePath } from "../src/utils/event-name.js";

describe("assertValidEventName", () => {
  it("accepts valid dotted lowercase names", () => {
    expect(() => assertValidEventName("auth.user.signed_up")).not.toThrow();
    expect(() => assertValidEventName("email.sent")).not.toThrow();
  });

  it("reports lowercase requirement for uppercase segments", () => {
    expect(() => assertValidEventName("Post.Created")).toThrow(
      'Event names must be lowercase (got "Post.Created"; try "post.created").',
    );
    expect(() => assertValidEventName("auth.User.signed_up")).toThrow(
      'Event names must be lowercase (got "auth.User.signed_up"; try "auth.user.signed_up").',
    );
  });

  it("reports the full naming rule for other invalid names", () => {
    expect(() => assertValidEventName("auth")).toThrow(/2\+ dot-separated segments/);
    expect(() => assertValidEventName("auth..user")).toThrow(/2\+ dot-separated segments/);
  });
});

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
