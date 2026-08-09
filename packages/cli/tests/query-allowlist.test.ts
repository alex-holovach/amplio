import type { LogRecord } from "@useamplio/amplio";
import { describe, expect, it } from "vitest";
import { queryAllowlist } from "../../../registry/enrichers/query-allowlist.ts";

function record(search?: string): LogRecord {
  return {
    event: "http.request",
    http: {
      method: "GET",
      path: "/api/trpc/post.hello",
      ...(search !== undefined ? { search } : {}),
    },
  };
}

describe("queryAllowlist", () => {
  it("drops http.search entirely by default", () => {
    const enrich = queryAllowlist();
    const out = enrich(record("?token=secret&page=2"));
    expect((out.http as Record<string, unknown>).search).toBeUndefined();
    expect((out.http as Record<string, unknown>).method).toBe("GET");
  });

  it("keeps allowlisted params and redacts the rest", () => {
    const enrich = queryAllowlist({ allow: ["page", "sort"] });
    const out = enrich(record("?token=secret&page=2&sort=asc"));
    const search = (out.http as Record<string, unknown>).search as string;
    expect(search).toContain("page=2");
    expect(search).toContain("sort=asc");
    expect(search).not.toContain("secret");
    expect(search).toContain("token=[REDACTED]");
  });

  it("passes records without http.search through untouched", () => {
    const enrich = queryAllowlist({ allow: ["page"] });
    const input = record();
    expect(enrich(input)).toBe(input);

    const noHttp: LogRecord = { event: "post.created" };
    expect(enrich(noHttp)).toBe(noHttp);
  });

  it("does not mutate the input record", () => {
    const enrich = queryAllowlist();
    const input = record("?token=secret");
    enrich(input);
    expect((input.http as Record<string, unknown>).search).toBe("?token=secret");
  });

  it("handles empty search strings", () => {
    const enrich = queryAllowlist({ allow: ["page"] });
    const input = record("");
    expect(enrich(input)).toBe(input);
  });
});
