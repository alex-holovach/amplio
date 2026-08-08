import type { LogRecord } from "@amplio/core";

export interface RequestContext {
  method: string;
  path: string;
  route?: string;
  status?: number;
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" ? value : undefined;
}

export function requestMetadata(context: RequestContext) {
  return (record: LogRecord): LogRecord => {
    const route = nonEmpty(context.route);
    const ip = nonEmpty(context.ip);
    const userAgent = nonEmpty(context.userAgent);
    const requestId = nonEmpty(context.requestId) ?? record.request_id;

    return {
      ...record,
      request_id: requestId,
      http: {
        method: context.method,
        path: context.path,
        ...(route !== undefined ? { route } : {}),
        ...(context.status !== undefined ? { status: context.status } : {}),
        ...(ip !== undefined ? { ip } : {}),
        ...(userAgent !== undefined ? { user_agent: userAgent } : {}),
      },
    };
  };
}
