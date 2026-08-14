/**
 * OTLP/HTTP logs sink.
 *
 * Endpoint resolution (first match wins):
 *   1. options.endpoint                          — `/v1/logs` appended unless already present
 *   2. OTEL_EXPORTER_OTLP_LOGS_ENDPOINT          — used VERBATIM (per the OTel spec,
 *      signal-specific endpoints are full URLs)
 *   3. OTEL_EXPORTER_OTLP_ENDPOINT               — base URL, `/v1/logs` appended
 *
 * Delivery: by default this sink POSTs ONE request per emit — fine for dev
 * and low traffic, not for production request rates. Pass `batch: true`
 * (100 records / 1 s) or `batch: { maxSize, maxWaitMs }` to coalesce records
 * into one export request. Batching makes the sink async-pending between
 * flushes. Amplio's `flush()` calls the sink's active drain hook, so shutdown
 * and short-lived/serverless paths can deliver a partial batch immediately.
 */
import type { JsonValue, Sink, SinkRecord } from "@useamplio/amplio";

export interface OtlpSinkOptions {
  endpoint?: string;
  headers?: Record<string, string>;
  /** When false (default), export failures warn once then stay silent. Pass true to throw. */
  throwOnError?: boolean;
  /**
   * Record fields promoted to typed OTLP log attributes (the fields you can
   * filter on in an OTel backend without parsing the JSON body). Dot paths
   * walk nested objects (`"http.status"` → record.http.status). Replaces the
   * default list; the full record always ships in the log body.
   */
  attributes?: string[];
  /**
   * Coalesce records into one export request. `true` = 100 records / 1 s;
   * pass `{ maxSize, maxWaitMs }` to tune. Default: off (one POST per emit).
   */
  batch?: boolean | { maxSize?: number; maxWaitMs?: number };
}

const DEFAULT_ATTRIBUTE_FIELDS = [
  "service",
  "@event",
  "duration_ms",
  "request_id",
  "success",
  // The fields people actually filter on in an OTel backend:
  "http.method",
  "http.route",
  "http.status",
  "rpc.procedures",
] as const;

const DEFAULT_BATCH_MAX_SIZE = 100;
const DEFAULT_BATCH_MAX_WAIT_MS = 1_000;

type OtlpAttributeValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: OtlpAttributeValue[] } }
  | { kvlistValue: { values: OtlpAttribute[] } };

interface OtlpAttribute {
  key: string;
  value: OtlpAttributeValue;
}

const parseOtlpHeaders = (raw: string | undefined): Record<string, string> => {
  if (!raw) {
    return {};
  }

  const headers: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) {
      continue;
    }

    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      continue;
    }

    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key) {
      headers[key] = value;
    }
  }

  return headers;
};

/** Flat key first (`record["http.status"]`), then dot-path walk (`record.http.status`). */
const fieldValue = (
  record: SinkRecord,
  field: string,
): JsonValue | undefined => {
  if (field === "@event") {
    return record["@event"];
  }
  const flat = record[field];
  if (flat !== undefined || !field.includes(".")) {
    return flat;
  }
  let current: JsonValue | undefined = record as JsonValue;
  for (const part of field.split(".")) {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      return undefined;
    }
    current = (current as Record<string, JsonValue>)[part];
  }
  return current;
};

const toOtlpValue = (
  value: JsonValue | undefined,
): OtlpAttributeValue | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return { stringValue: value };
  }

  if (typeof value === "boolean") {
    return { boolValue: value };
  }

  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      return { intValue: String(value) };
    }
    return { doubleValue: value };
  }

  if (Array.isArray(value)) {
    const values = value
      .map((item) => toOtlpValue(item))
      .filter((item): item is OtlpAttributeValue => item !== undefined);
    return { arrayValue: { values } };
  }

  const values = Object.entries(value)
    .map(([key, item]) => toOtlpAttribute(key, item))
    .filter((item): item is OtlpAttribute => item !== undefined);
  return { kvlistValue: { values } };
};

const toOtlpAttribute = (
  key: string,
  value: JsonValue | undefined,
): OtlpAttribute | undefined => {
  const converted = toOtlpValue(value);
  return converted ? { key, value: converted } : undefined;
};

const toTimeUnixNano = (timestamp: JsonValue | undefined): string => {
  let ms: number;

  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    ms = timestamp;
  } else if (typeof timestamp === "string" && timestamp.length > 0) {
    const parsed = Date.parse(timestamp);
    ms = Number.isNaN(parsed) ? Date.now() : parsed;
  } else {
    ms = Date.now();
  }

  return `${Math.trunc(ms)}000000`;
};

const resolveUrl = (options: OtlpSinkOptions): string | undefined => {
  const appendLogsPath = (endpoint: string): string => {
    const base = endpoint.replace(/\/$/, "");
    return base.endsWith("/v1/logs") ? base : `${base}/v1/logs`;
  };

  if (options.endpoint) {
    return appendLogsPath(options.endpoint);
  }
  // Per the OTel spec the signal-specific endpoint is a full URL used as-is;
  // only the base endpoint gets the signal path appended.
  const signalEndpoint = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  if (signalEndpoint) {
    return signalEndpoint;
  }
  const baseEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (baseEndpoint) {
    return appendLogsPath(baseEndpoint);
  }
  return undefined;
};

const resourceKeyOf = (record: SinkRecord): string => {
  const attributes = buildResourceAttributes(record).sort((left, right) =>
    left.key.localeCompare(right.key),
  );
  return JSON.stringify(attributes);
};

const buildResourceAttributes = (record: SinkRecord): OtlpAttribute[] => {
  const attributes: OtlpAttribute[] = [];
  const keys = new Set<string>();
  const add = (attribute: OtlpAttribute | undefined): void => {
    if (!attribute || keys.has(attribute.key)) return;
    keys.add(attribute.key);
    attributes.push(attribute);
  };

  if (typeof record.service === "string" && record.service.length > 0) {
    add({ key: "service.name", value: { stringValue: record.service } });
  }
  if (typeof record.env === "string" && record.env.length > 0) {
    add({
      key: "deployment.environment",
      value: { stringValue: record.env },
    });
  }

  const resource = record.resource;
  if (
    resource !== null &&
    typeof resource === "object" &&
    !Array.isArray(resource)
  ) {
    for (const [key, value] of Object.entries(resource)) {
      add(toOtlpAttribute(key, value));
    }
  }

  return attributes;
};

export function otlpSink(options: OtlpSinkOptions = {}): Sink {
  const url = resolveUrl(options);
  const throwOnError = options.throwOnError ?? false;
  const attributeFields = options.attributes ?? DEFAULT_ATTRIBUTE_FIELDS;
  const headers = {
    "content-type": "application/json",
    ...parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
    ...(options.headers ?? {}),
  };

  if (!url) {
    let warned = false;
    return async () => {
      if (!warned) {
        warned = true;
        console.warn(
          "[amplio] otlpSink: no endpoint configured — set OTEL_EXPORTER_OTLP_LOGS_ENDPOINT (full URL, used verbatim) or OTEL_EXPORTER_OTLP_ENDPOINT (base URL, /v1/logs appended), or pass otlpSink({ endpoint }); OTLP export is disabled",
        );
      }
    };
  }

  let warnedExportFailure = false;

  const warnExportFailure = (detail: string): void => {
    if (throwOnError || warnedExportFailure) {
      return;
    }
    warnedExportFailure = true;
    console.warn(
      `[amplio] otlpSink: export failed (${detail}); further failures will be silent. Pass throwOnError: true to fail hard.`,
    );
  };

  const buildAttributes = (record: SinkRecord): OtlpAttribute[] => {
    const attributes: OtlpAttribute[] = [];
    for (const field of attributeFields) {
      // Keep the conventional OTLP attribute key `event` while sourcing the
      // canonical semantic `@event` field by default.
      const key = field === "@event" ? "event" : field;
      const attr = toOtlpAttribute(key, fieldValue(record, field));
      if (attr) {
        attributes.push(attr);
      }
    }
    return attributes;
  };

  const toLogRecord = (record: SinkRecord) => {
    const attributes = buildAttributes(record);
    return {
      timeUnixNano: toTimeUnixNano(record.timestamp),
      body: { stringValue: JSON.stringify(record) },
      ...(attributes.length > 0 ? { attributes } : {}),
    };
  };

  // One resourceLogs entry per distinct OTLP resource — records in a batch
  // usually share one, but never stamp record A with B's resource attributes.
  const buildPayload = (records: SinkRecord[]) => {
    const groups = new Map<string, SinkRecord[]>();
    for (const record of records) {
      const key = resourceKeyOf(record);
      const group = groups.get(key);
      if (group) {
        group.push(record);
      } else {
        groups.set(key, [record]);
      }
    }

    const resourceLogs = [...groups.values()].map((group) => {
      const first = group[0]!;
      const resourceAttributes = buildResourceAttributes(first);
      return {
        ...(resourceAttributes.length > 0
          ? { resource: { attributes: resourceAttributes } }
          : {}),
        scopeLogs: [{ logRecords: group.map(toLogRecord) }],
      };
    });

    return { resourceLogs };
  };

  const exportRecords = async (records: SinkRecord[]): Promise<void> => {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(buildPayload(records)),
      });
    } catch (error) {
      if (throwOnError) {
        throw error;
      }
      warnExportFailure("network_error");
      return;
    }

    if (!response.ok) {
      if (throwOnError) {
        throw new Error(`OTLP export failed with status ${response.status}`);
      }
      warnExportFailure(`status ${response.status}`);
      return;
    }
  };

  if (!options.batch) {
    return (record: SinkRecord) => exportRecords([record]);
  }

  const batchConfig = options.batch === true ? {} : options.batch;
  const maxSize = batchConfig.maxSize ?? DEFAULT_BATCH_MAX_SIZE;
  const maxWaitMs = batchConfig.maxWaitMs ?? DEFAULT_BATCH_MAX_WAIT_MS;

  let buffer: SinkRecord[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (e: unknown) => void;
  } | null = null;

  const flushBatch = (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const records = buffer;
    const settled = pending;
    buffer = [];
    pending = null;
    if (records.length === 0) {
      settled?.resolve();
      return Promise.resolve();
    }
    const delivery = exportRecords(records).then(
      () => settled?.resolve(),
      (error) => {
        // Every emit in the batch awaited this promise — reject them all so
        // throwOnError surfaces per-record, matching the unbatched contract.
        if (settled) {
          settled.reject(error);
        }
      },
    );
    return delivery;
  };

  const sink: Sink = (record: SinkRecord): Promise<void> => {
    buffer.push(record);
    if (pending === null) {
      let resolve!: () => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      pending = { promise, resolve, reject };
    }
    const result = pending.promise;
    if (buffer.length >= maxSize) {
      void flushBatch();
    } else if (timer === null) {
      timer = setTimeout(flushBatch, maxWaitMs);
      // Don't keep a Node process alive just for a pending batch window.
      (timer as { unref?: () => void }).unref?.();
    }
    return result;
  };
  sink.flush = flushBatch;
  return sink;
}
