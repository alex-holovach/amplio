import type { LogRecord } from "@amplio/amplio";
import { describe, expect, it } from "vitest";
import { requestMetadata } from "../../../registry/enrichers/request-metadata.ts";

describe("requestMetadata", () => {
  it("merges http method/path/user_agent/request_id without dropping existing fields", () => {
    const enrich = requestMetadata({
      method: "POST",
      path: "/api/users",
      userAgent: "amplio-test/1.0",
      requestId: "req-abc-123",
    });

    const record: LogRecord = {
      event: "http.request",
      service: "api",
      env: "test",
      custom_field: "keep-me",
      nested: { a: 1 },
    };

    const out = enrich(record);

    expect(out.event).toBe("http.request");
    expect(out.service).toBe("api");
    expect(out.env).toBe("test");
    expect(out.custom_field).toBe("keep-me");
    expect(out.nested).toEqual({ a: 1 });

    expect(out.request_id).toBe("req-abc-123");
    expect(out.http).toEqual({
      method: "POST",
      path: "/api/users",
      user_agent: "amplio-test/1.0",
    });
  });

  it("preserves existing request_id when context omits it", () => {
    const enrich = requestMetadata({
      method: "GET",
      path: "/health",
    });

    const out = enrich({
      event: "ping",
      request_id: "existing-id",
    });

    expect(out.request_id).toBe("existing-id");
    expect(out.event).toBe("ping");
    expect(out.http).toEqual({ method: "GET", path: "/health" });
  });

  it("includes optional route/status/ip on http when provided", () => {
    const enrich = requestMetadata({
      method: "GET",
      path: "/api/users/42",
      route: "/api/users/:id",
      status: 200,
      ip: "203.0.113.10",
    });
    const out = enrich({ event: "http.request" });
    expect(out.http).toEqual({
      method: "GET",
      path: "/api/users/42",
      route: "/api/users/:id",
      status: 200,
      ip: "203.0.113.10",
    });
  });

  it("omits optional route/status/ip when context does not provide them", () => {
    const enrich = requestMetadata({
      method: "DELETE",
      path: "/api/sessions",
    });
    const out = enrich({ event: "http.request" });
    const http = out.http as Record<string, unknown>;
    expect(http).toEqual({ method: "DELETE", path: "/api/sessions" });
    expect(http).not.toHaveProperty("route");
    expect(http).not.toHaveProperty("status");
    expect(http).not.toHaveProperty("ip");
  });

  it("includes status 0 on http.status (0 is valid, not treated as unset)", () => {
    const enrich = requestMetadata({
      method: "GET",
      path: "/api/pending",
      status: 0,
    });
    const out = enrich({ event: "http.request" });
    const http = out.http as Record<string, unknown>;
    expect(http).toHaveProperty("status");
    expect(http.status).toBe(0);
  });

  it("maps userAgent to http.user_agent when provided and omits it when not", () => {
    const withUa = requestMetadata({
      method: "GET",
      path: "/api",
      userAgent: "amplio-cli/2.0",
    })({ event: "http.request" });
    expect((withUa.http as Record<string, unknown>).user_agent).toBe(
      "amplio-cli/2.0",
    );

    const withoutUa = requestMetadata({
      method: "GET",
      path: "/api",
    })({ event: "http.request" });
    expect(withoutUa.http as Record<string, unknown>).not.toHaveProperty(
      "user_agent",
    );
  });

  it("omits empty-string route/ip/userAgent from http", () => {
    const enrich = requestMetadata({
      method: "GET",
      path: "/api",
      route: "",
      ip: "",
      userAgent: "",
      status: 0,
    });
    const out = enrich({ event: "http.request" });
    const http = out.http as Record<string, unknown>;
    expect(http).toEqual({ method: "GET", path: "/api", status: 0 });
    expect(http).not.toHaveProperty("route");
    expect(http).not.toHaveProperty("ip");
    expect(http).not.toHaveProperty("user_agent");
  });

  it("does not overwrite existing request_id when context.requestId is empty", () => {
    const enrich = requestMetadata({
      method: "GET",
      path: "/health",
      requestId: "",
    });
    const out = enrich({
      event: "ping",
      request_id: "existing-id",
    });
    expect(out.request_id).toBe("existing-id");
  });
});
