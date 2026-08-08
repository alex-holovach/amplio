import { NextResponse } from "next/server";
import { useRequestLogger, withAmplio } from "../../../telemetry/middleware/next";
import "../../../telemetry/logger";

export const GET = withAmplio(async () => {
  useRequestLogger().set({ route: { name: "health" } });
  return NextResponse.json({ ok: true });
});
