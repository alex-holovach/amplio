/**
 * Global enricher for init({ enrichers }) that scrubs `http.search`.
 *
 * Request middleware records the query string verbatim, and field-level
 * redaction does not parse it — tokens or PII in `?…` params can leak.
 * This enricher drops `http.search` entirely by default; pass an allowlist
 * to keep specific params and redact the rest.
 *
 * @example
 * init({
 *   // …
 *   enrichers: [queryAllowlist()],                          // drop http.search
 *   // enrichers: [queryAllowlist({ allow: ["page", "sort"] })], // keep page/sort, redact the rest
 * });
 */
import type { JsonValue, LogRecord } from "@useamplio/amplio";

export interface QueryAllowlistOptions {
  /** Query params to keep verbatim. Everything else becomes `[REDACTED]`. */
  allow?: string[];
}

function isRecord(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function queryAllowlist(options: QueryAllowlistOptions = {}) {
  const allow = new Set(options.allow ?? []);

  return (record: LogRecord): LogRecord => {
    const http = record.http;
    if (!isRecord(http) || typeof http.search !== "string" || http.search === "") {
      return record;
    }

    if (allow.size === 0) {
      const { search: _search, ...rest } = http;
      return { ...record, http: rest };
    }

    let params: URLSearchParams;
    try {
      params = new URLSearchParams(http.search.replace(/^\?/, ""));
    } catch {
      // Unparseable query string — safer to drop it than to pass it through.
      const { search: _search, ...rest } = http;
      return { ...record, http: rest };
    }

    const parts: string[] = [];
    for (const [key, value] of params) {
      parts.push(
        allow.has(key)
          ? `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
          : `${encodeURIComponent(key)}=[REDACTED]`,
      );
    }

    const search = parts.join("&");
    return { ...record, http: { ...http, search: search ? `?${search}` : "" } };
  };
}
