import type { LogRecord } from "@logcn/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { otlpSink } from "../../../registry/sinks/otlp.ts";

describe("otlpSink", () => {
  const originalEnv = process.env;
  let fetchMock: ReturnType<typeof vi.fn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
    warnSpy.mockRestore();
  });

  it("missing endpoint -> no-op sink, no throw, fetch not called, console.warn once", async () => {
    const sink = otlpSink();
    const record: LogRecord = { event: "test.event", service: "my-api" };

    await expect(sink(record)).resolves.toBeUndefined();
    await expect(sink(record)).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(
      "otlpSink: OTEL_EXPORTER_OTLP_ENDPOINT is not set; OTLP export is disabled",
    );
  });

  it("endpoint + mock fetch 200 -> POST https://otel.example.com/v1/logs, body has service attribute stringValue my-api", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const sink = otlpSink({ endpoint: "https://otel.example.com" });
    const record: LogRecord = { event: "test.event", service: "my-api" };

    await sink(record);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://otel.example.com/v1/logs");
    expect(init?.method).toBe("POST");

    const body = JSON.parse(init?.body as string);
    const attributes =
      body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
    const serviceAttr = attributes.find((a: { key: string }) => a.key === "service");
    expect(serviceAttr).toEqual({ key: "service", value: { stringValue: "my-api" } });
    const resourceAttrs = body.resourceLogs[0].resource.attributes;
    const serviceNameAttr = resourceAttrs.find(
      (a: { key: string }) => a.key === "service.name",
    );
    expect(serviceNameAttr).toEqual({
      key: "service.name",
      value: { stringValue: "my-api" },
    });
  });



  it("successful export uses fetch method POST", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const sink = otlpSink({ endpoint: "https://otel.example.com" });
    await sink({ event: "test.event" } as LogRecord);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe("POST");
  });

  it("successful payload has resourceLogs/scopeLogs/logRecords length 1 (shape smoke)", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const sink = otlpSink({ endpoint: "https://otel.example.com" });
    await sink({ event: "test.event", service: "my-api" } as LogRecord);

    const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
    expect(body.resourceLogs).toHaveLength(1);
    expect(body.resourceLogs[0].scopeLogs).toHaveLength(1);
    expect(body.resourceLogs[0].scopeLogs[0].logRecords).toHaveLength(1);
  });


  it("OTLP log record body.stringValue equals JSON.stringify(record) for event + service", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const sink = otlpSink({ endpoint: "https://otel.example.com" });
    const record: LogRecord = { event: "test.event", service: "my-api" };
    await sink(record);
    const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
    expect(body.resourceLogs[0].scopeLogs[0].logRecords[0].body).toEqual({
      stringValue: JSON.stringify(record),
    });
  });

  it("omits resource when both service and env are missing or empty", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const sink = otlpSink({ endpoint: "https://otel.example.com" });

    for (const record of [
      { event: "test.event" } as LogRecord,
      { event: "test.event", service: "", env: "" } as LogRecord,
    ]) {
      fetchMock.mockClear();
      await sink(record);
      const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
      expect(body.resourceLogs[0].resource).toBeUndefined();
    }
  });

  it("resource includes deployment.environment when record.env is set", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const sink = otlpSink({ endpoint: "https://otel.example.com" });

    fetchMock.mockClear();
    await sink({ event: "test.event", env: "production" } as LogRecord);
    let body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
    let resourceAttrs = body.resourceLogs[0].resource.attributes;
    expect(resourceAttrs).toEqual([
      {
        key: "deployment.environment",
        value: { stringValue: "production" },
      },
    ]);

    fetchMock.mockClear();
    await sink({
      event: "test.event",
      service: "my-api",
      env: "production",
    } as LogRecord);
    body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
    resourceAttrs = body.resourceLogs[0].resource.attributes;
    expect(resourceAttrs).toEqual([
      {
        key: "service.name",
        value: { stringValue: "my-api" },
      },
      {
        key: "deployment.environment",
        value: { stringValue: "production" },
      },
    ]);
  });

  it("endpoint already ending with /v1/logs (with or without trailing slash) POSTs once to that path", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const record: LogRecord = { event: "test.event" };

    for (const endpoint of [
      "https://otel.example.com/v1/logs",
      "https://otel.example.com/v1/logs/",
    ]) {
      fetchMock.mockClear();
      const sink = otlpSink({ endpoint });
      await sink(record);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0]![0]).toBe("https://otel.example.com/v1/logs");
      expect(fetchMock.mock.calls[0]![1]?.method).toBe("POST");
    }
  });

  it("endpoint with path prefix appends /v1/logs under that prefix", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const record: LogRecord = { event: "test.event" };

    for (const endpoint of [
      "https://otel.example.com/otlp",
      "https://otel.example.com/otlp/",
    ]) {
      fetchMock.mockClear();
      const sink = otlpSink({ endpoint });
      await sink(record);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0]![0]).toBe(
        "https://otel.example.com/otlp/v1/logs",
      );
      expect(fetchMock.mock.calls[0]![1]?.method).toBe("POST");
    }
  });

  it("fetch 500 + throwOnError true -> throws OTLP export failed with status 500", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    const sink = otlpSink({ endpoint: "https://otel.example.com", throwOnError: true });
    const record: LogRecord = { event: "test.event" };

    await expect(sink(record)).rejects.toThrow("OTLP export failed with status 500");
  });

  it("fetch 500 + throwOnError false -> resolves, no throw", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    const sink = otlpSink({ endpoint: "https://otel.example.com", throwOnError: false });
    const record: LogRecord = { event: "test.event" };

    await expect(sink(record)).resolves.toBeUndefined();
  });

  it("fetch reject (network) + throwOnError false -> resolves", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));

    const sink = otlpSink({ endpoint: "https://otel.example.com", throwOnError: false });
    const record: LogRecord = { event: "test.event" };

    await expect(sink(record)).resolves.toBeUndefined();
  });

  it("fetch reject (network) + throwOnError true (default) -> rejects with the network error", async () => {
    const networkError = new Error("network down");
    fetchMock.mockRejectedValue(networkError);

    // omit throwOnError — default is true
    const sink = otlpSink({ endpoint: "https://otel.example.com" });
    const record: LogRecord = { event: "test.event" };

    await expect(sink(record)).rejects.toBe(networkError);
  });

  it("ISO timestamp -> timeUnixNano from record.timestamp", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const sink = otlpSink({ endpoint: "https://otel.example.com" });
    const record: LogRecord = {
      event: "test.event",
      timestamp: "2026-01-15T12:00:00.000Z",
    };

    await sink(record);

    const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
    expect(body.resourceLogs[0].scopeLogs[0].logRecords[0].timeUnixNano).toBe(
      "1768478400000000000",
    );
  });

  it("numeric timestamp ms -> timeUnixNano from record.timestamp", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const sink = otlpSink({ endpoint: "https://otel.example.com" });
    const record: LogRecord = {
      event: "test.event",
      timestamp: 1768478400000,
    };

    await sink(record);

    const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
    expect(body.resourceLogs[0].scopeLogs[0].logRecords[0].timeUnixNano).toBe(
      "1768478400000000000",
    );
  });


  it("unparseable timestamp -> POST succeeds, timeUnixNano falls back to now", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const nowMs = 1770000000000;
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(nowMs);

    try {
      const sink = otlpSink({ endpoint: "https://otel.example.com" });
      const record = {
        event: "test.event",
        timestamp: "not-a-date",
      } as LogRecord;

      await expect(sink(record)).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledOnce();

      const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
      const timeUnixNano =
        body.resourceLogs[0].scopeLogs[0].logRecords[0].timeUnixNano;
      expect(timeUnixNano).toMatch(/^\d+000000$/);
      expect(timeUnixNano).toBe(`${nowMs}000000`);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer token, X-Custom=abc + env endpoint -> fetch headers include those", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://otel.example.com";
    process.env.OTEL_EXPORTER_OTLP_HEADERS =
      "Authorization=Bearer token, X-Custom=abc";

    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const sink = otlpSink();
    const record: LogRecord = { event: "test.event" };

    await sink(record);

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toMatchObject({
      "content-type": "application/json",
      Authorization: "Bearer token",
      "X-Custom": "abc",
    });
  });

  it('OTEL_EXPORTER_OTLP_HEADERS=" Authorization = Bearer spaced , X-Ok = 1 " trims keys/values', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://otel.example.com";
    process.env.OTEL_EXPORTER_OTLP_HEADERS =
      " Authorization = Bearer spaced , X-Ok = 1 ";

    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const sink = otlpSink();
    await sink({ event: "test.event" } as LogRecord);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toMatchObject({
      "content-type": "application/json",
      Authorization: "Bearer spaced",
      "X-Ok": "1",
    });
    expect(init?.headers?.Authorization).toBe("Bearer spaced");
    expect(init?.headers?.["X-Ok"]).toBe("1");
  });

  it("OTEL_EXPORTER_OTLP_HEADERS with malformed segment without = still parses valid pairs and ignores the bad segment", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://otel.example.com";
    process.env.OTEL_EXPORTER_OTLP_HEADERS =
      "Authorization=Bearer x, notavalidpair, X-Ok=1";

    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const sink = otlpSink();
    const record: LogRecord = { event: "test.event" };

    await sink(record);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toMatchObject({
      "content-type": "application/json",
      Authorization: "Bearer x",
      "X-Ok": "1",
    });
    expect(init?.headers).not.toHaveProperty("notavalidpair");
  });

  it("options.headers Authorization merges with default content-type application/json", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const sink = otlpSink({
      endpoint: "https://otel.example.com",
      headers: { Authorization: "Bearer x" },
    });

    await sink({ event: "test.event" } as LogRecord);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toMatchObject({
      "content-type": "application/json",
      Authorization: "Bearer x",
    });
  });

  it("options.headers content-type application/x-protobuf overrides default JSON content-type", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const sink = otlpSink({
      endpoint: "https://otel.example.com",
      headers: { "content-type": "application/x-protobuf" },
    });

    await sink({ event: "test.event" } as LogRecord);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toMatchObject({
      "content-type": "application/x-protobuf",
    });
    expect(init?.headers?.["content-type"]).toBe("application/x-protobuf");
  });

  it("options.headers Authorization overrides OTEL_EXPORTER_OTLP_HEADERS env", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://otel.example.com";
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=Bearer env";

    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const sink = otlpSink({ headers: { Authorization: "Bearer opt" } });
    await sink({ event: "test.event" } as LogRecord);

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toMatchObject({
      "content-type": "application/json",
      Authorization: "Bearer opt",
    });
  });

  it("OTEL_EXPORTER_OTLP_HEADERS skips empty header keys (=novalue)", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://otel.example.com";
    process.env.OTEL_EXPORTER_OTLP_HEADERS =
      "=novalue,Authorization=Bearer x";

    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const sink = otlpSink();
    await sink({ event: "test.event" } as LogRecord);

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toMatchObject({
      "content-type": "application/json",
      Authorization: "Bearer x",
    });
    expect(init?.headers?.[""]).toBeUndefined();
    expect(init?.headers).not.toHaveProperty("novalue");
  });

  it('OTEL_EXPORTER_OTLP_HEADERS="Authorization=,X-Ok=1" keeps empty Authorization value and X-Ok=1', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://otel.example.com";
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=,X-Ok=1";

    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const sink = otlpSink();
    await sink({ event: "test.event" } as LogRecord);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toMatchObject({
      "content-type": "application/json",
      Authorization: "",
      "X-Ok": "1",
    });
    expect(init?.headers?.Authorization).toBe("");
  });

  it('OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer x," (trailing comma / empty segment) still parses Authorization and does not throw', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://otel.example.com";
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=Bearer x,";

    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const sink = otlpSink();
    await expect(sink({ event: "test.event" } as LogRecord)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toMatchObject({
      "content-type": "application/json",
      Authorization: "Bearer x",
    });
    expect(init?.headers?.Authorization).toBe("Bearer x");
  });

  it('OTEL_EXPORTER_OTLP_HEADERS=",Authorization=Bearer x" (leading comma / empty segment) still parses Authorization', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://otel.example.com";
    process.env.OTEL_EXPORTER_OTLP_HEADERS = ",Authorization=Bearer x";

    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const sink = otlpSink();
    await expect(sink({ event: "test.event" } as LogRecord)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toMatchObject({
      "content-type": "application/json",
      Authorization: "Bearer x",
    });
    expect(init?.headers?.Authorization).toBe("Bearer x");
  });

  it('OTEL_EXPORTER_OTLP_HEADERS=",,," with endpoint set → fetch still succeeds with default content-type only (no extra headers from empty segments); sink does not throw', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://otel.example.com";
    process.env.OTEL_EXPORTER_OTLP_HEADERS = ",,,";

    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const sink = otlpSink();
    await expect(sink({ event: "test.event" } as LogRecord)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toEqual({ "content-type": "application/json" });
    expect(init?.headers?.[""]).toBeUndefined();
  });


  it('OTEL_EXPORTER_OTLP_HEADERS="   ,  , " (whitespace + empty segments) → fetch headers only default content-type; no throw', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://otel.example.com";
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "   ,  , ";

    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const sink = otlpSink();
    await expect(sink({ event: "test.event" } as LogRecord)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toEqual({ "content-type": "application/json" });
    expect(init?.headers?.[""]).toBeUndefined();
  });


  it('OTEL_EXPORTER_OTLP_HEADERS="" (empty string) with endpoint → fetch headers only default content-type; no throw', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://otel.example.com";
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "";

    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const sink = otlpSink();
    await expect(sink({ event: "test.event" } as LogRecord)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toEqual({ "content-type": "application/json" });
    expect(init?.headers?.[""]).toBeUndefined();
  });


  it("OTEL_EXPORTER_OTLP_HEADERS unset (deleted) + endpoint via options or env → fetch headers only default content-type", async () => {
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const record: LogRecord = { event: "test.event" };

    // endpoint via options
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    fetchMock.mockClear();
    await otlpSink({ endpoint: "https://otel.example.com" })(record);
    expect(fetchMock).toHaveBeenCalledOnce();
    let [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toEqual({ "content-type": "application/json" });
    expect(init?.headers?.[""]).toBeUndefined();

    // endpoint via env
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://otel.example.com";
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    fetchMock.mockClear();
    await otlpSink()(record);
    expect(fetchMock).toHaveBeenCalledOnce();
    [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toEqual({ "content-type": "application/json" });
    expect(init?.headers?.[""]).toBeUndefined();
  });

  it('OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer x,,X-Ok=1" (double comma / empty segment) keeps both Authorization and X-Ok', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://otel.example.com";
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=Bearer x,,X-Ok=1";

    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const sink = otlpSink();
    await sink({ event: "test.event" } as LogRecord);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toMatchObject({
      "content-type": "application/json",
      Authorization: "Bearer x",
      "X-Ok": "1",
    });
  });

  it("typed log attributes: intValue, boolValue, doubleValue", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const sink = otlpSink({ endpoint: "https://otel.example.com" });

    await sink({
      event: "test.event",
      duration_ms: 42,
      success: true,
    } as LogRecord);

    let body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
    let attributes =
      body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
    expect(
      attributes.find((a: { key: string }) => a.key === "duration_ms"),
    ).toEqual({ key: "duration_ms", value: { intValue: 42 } });
    expect(
      attributes.find((a: { key: string }) => a.key === "success"),
    ).toEqual({ key: "success", value: { boolValue: true } });

    fetchMock.mockClear();
    await sink({
      event: "test.event",
      duration_ms: 1.5,
    } as LogRecord);

    body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
    attributes = body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
    expect(
      attributes.find((a: { key: string }) => a.key === "duration_ms"),
    ).toEqual({ key: "duration_ms", value: { doubleValue: 1.5 } });
  });

  it("ATTRIBUTE_FIELDS omit null/undefined/object values (request_id null, nested meta ignored)", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const sink = otlpSink({ endpoint: "https://otel.example.com" });

    await sink({
      event: "ok",
      request_id: null,
      success: true,
      meta: { nested: true, depth: 1 },
    } as LogRecord);

    const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
    const attributes =
      body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes as Array<{
        key: string;
        value: Record<string, unknown>;
      }>;
    const keys = attributes.map((a) => a.key);

    expect(
      attributes.find((a) => a.key === "event"),
    ).toEqual({ key: "event", value: { stringValue: "ok" } });
    expect(
      attributes.find((a) => a.key === "success"),
    ).toEqual({ key: "success", value: { boolValue: true } });
    expect(keys).not.toContain("request_id");
    expect(keys).not.toContain("meta");
  });

});
