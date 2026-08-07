import { NextResponse } from "next/server";
import { useRequestLogger, withLogcn } from "../../../telemetry/middleware/next";
import "../../../telemetry/logger";

export const GET = withLogcn(async () => {
  useRequestLogger()?.set({ route: { name: "health" } });
  return NextResponse.json({ ok: true });
});
