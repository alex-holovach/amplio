import type { NextRequest } from "next/server";
import { withAmplio } from "../../../../registry/plugins/next.js";

const handler = (_request: NextRequest): Response => new Response("ok");

withAmplio("orders.show", handler);

// @ts-expect-error A stable route is required; a handler alone is ambiguous.
withAmplio(handler);
