import { NextResponse } from "next/server";
import { withAmplio } from "../../../telemetry/plugins/next";

export const GET = withAmplio("/api/failure", async () => {
  return NextResponse.json({ ok: false }, { status: 503 });
});
