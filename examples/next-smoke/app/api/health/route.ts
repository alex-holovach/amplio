import { NextResponse } from "next/server";
import { withAmplio } from "../../../telemetry/plugins/next";

export const GET = withAmplio("/api/health", async () => {
  return NextResponse.json({ ok: true });
});
