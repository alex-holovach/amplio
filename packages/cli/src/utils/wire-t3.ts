import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./fs.js";
import { parseJsonc } from "./jsonc.js";

/**
 * Auto-wiring for the create-t3-app layout. Both files live at scaffold-stable
 * paths, so the edits below are mechanical string transforms guarded by shape
 * checks — if the file has drifted from the T3 scaffold we leave it untouched
 * and report "unrecognized" so init can fall back to printing a snippet.
 */

export const T3_ROUTE_FILE = "src/app/api/trpc/[trpc]/route.ts";
export const T3_TRPC_FILE = "src/server/api/trpc.ts";
export const T3_NEXTAUTH_ROUTE_FILE = "src/app/api/auth/[...nextauth]/route.ts";

export type WireStatus = "wired" | "already" | "not-found" | "unrecognized";

export interface WireResult {
  status: WireStatus;
  file: string;
}

const ROUTE_EXPORT_RE =
  /export\s*\{\s*handler\s+as\s+GET\s*,\s*handler\s+as\s+POST\s*,?\s*\}\s*;?/;

const PROCEDURE_EXPORT_RE =
  /export const (publicProcedure|protectedProcedure)(\s*=\s*)t\.procedure/g;

export async function hasTelemetryPathAlias(
  cwd: string,
  telemetryDir: string,
): Promise<boolean> {
  const tsconfigPath = path.join(cwd, "tsconfig.json");
  if (!(await pathExists(tsconfigPath))) {
    return false;
  }
  try {
    const raw = await fs.readFile(tsconfigPath, "utf8");
    const config = parseJsonc<{ compilerOptions?: { paths?: Record<string, string[]> } }>(raw);
    const paths = config.compilerOptions?.paths ?? {};
    return paths["~telemetry/*"]?.includes(`./${telemetryDir}/*`) ?? false;
  } catch {
    return false;
  }
}

export async function middlewareImportForFile(
  cwd: string,
  telemetryDir: string,
  fromFile: string,
  middlewareName: string,
): Promise<string> {
  if (await hasTelemetryPathAlias(cwd, telemetryDir)) {
    return `~telemetry/middleware/${middlewareName}`;
  }
  const fromDir = path.dirname(path.join(cwd, fromFile));
  const target = path.join(cwd, telemetryDir, "middleware", middlewareName);
  const relative = path.relative(fromDir, target).replace(/\\/g, "/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function insertAfterImports(source: string, importLine: string): string {
  const importMatches = [...source.matchAll(/^import\s[^;]+;$/gm)];
  const lastImport = importMatches[importMatches.length - 1];
  if (!lastImport || lastImport.index === undefined) {
    return `${importLine}\n${source}`;
  }
  const insertAt = lastImport.index + lastImport[0].length;
  return `${source.slice(0, insertAt)}\n${importLine}${source.slice(insertAt)}`;
}

/**
 * Walk backwards from `index` (a line start) over a contiguous comment block
 * so an insertion lands above the doc comment, not between it and its export.
 */
function commentBlockStart(source: string, index: number): number {
  const lines = source.slice(0, index).split("\n");
  // Last entry is the (empty) tail of the line the export starts on.
  let cursor = lines.length - 1;
  while (cursor > 0) {
    const line = lines[cursor - 1]?.trim() ?? "";
    const isComment =
      line.startsWith("//") ||
      line.startsWith("/*") ||
      line.startsWith("*") ||
      line.endsWith("*/");
    if (!isComment) {
      break;
    }
    cursor -= 1;
  }
  return lines.slice(0, cursor).join("\n").length + (cursor > 0 ? 1 : 0);
}

export async function detectT3Layout(cwd: string): Promise<{
  routeFile: boolean;
  trpcFile: boolean;
  nextAuthRouteFile: boolean;
}> {
  return {
    routeFile: await pathExists(path.join(cwd, T3_ROUTE_FILE)),
    trpcFile: await pathExists(path.join(cwd, T3_TRPC_FILE)),
    nextAuthRouteFile: await pathExists(path.join(cwd, T3_NEXTAUTH_ROUTE_FILE)),
  };
}

/**
 * Wrap the exported tRPC fetch handler with withAmplio:
 *   export { handler as GET, handler as POST };
 * becomes
 *   const wrappedHandler = withAmplio(handler);
 *   export { wrappedHandler as GET, wrappedHandler as POST };
 */
export async function wireT3RouteHandler(
  cwd: string,
  telemetryDir: string,
): Promise<WireResult> {
  const file = T3_ROUTE_FILE;
  const fullPath = path.join(cwd, file);
  if (!(await pathExists(fullPath))) {
    return { status: "not-found", file };
  }

  const source = await fs.readFile(fullPath, "utf8");
  if (source.includes("withAmplio")) {
    return { status: "already", file };
  }
  if (!ROUTE_EXPORT_RE.test(source)) {
    return { status: "unrecognized", file };
  }

  const importPath = await middlewareImportForFile(cwd, telemetryDir, file, "next");
  const withImport = insertAfterImports(
    source,
    `import { withAmplio } from "${importPath}";`,
  );
  const wired = withImport.replace(
    ROUTE_EXPORT_RE,
    "const wrappedHandler = withAmplio(handler);\n\nexport { wrappedHandler as GET, wrappedHandler as POST };",
  );

  await fs.writeFile(fullPath, wired, "utf8");
  return { status: "wired", file };
}

const NEXTAUTH_EXPORT_RE =
  /export\s+const\s*\{\s*GET\s*,\s*POST\s*\}\s*=\s*handlers\s*;?/;

/**
 * Wrap the NextAuth (Auth.js v5) route handlers with withAmplio:
 *   export const { GET, POST } = handlers;
 * becomes
 *   const { GET: authGet, POST: authPost } = handlers;
 *   export const GET = withAmplio(authGet);
 *   export const POST = withAmplio(authPost);
 * Without this, NextAuth `events` callbacks (signIn, etc.) run outside a
 * request scope and every getLogger().child(...) in them silently no-ops.
 */
export async function wireT3NextAuthRoute(
  cwd: string,
  telemetryDir: string,
): Promise<WireResult> {
  const file = T3_NEXTAUTH_ROUTE_FILE;
  const fullPath = path.join(cwd, file);
  if (!(await pathExists(fullPath))) {
    return { status: "not-found", file };
  }

  const source = await fs.readFile(fullPath, "utf8");
  if (source.includes("withAmplio")) {
    return { status: "already", file };
  }
  if (!NEXTAUTH_EXPORT_RE.test(source)) {
    return { status: "unrecognized", file };
  }

  const importPath = await middlewareImportForFile(cwd, telemetryDir, file, "next");
  const withImport = insertAfterImports(
    source,
    `import { withAmplio } from "${importPath}";`,
  );
  const wired = withImport.replace(
    NEXTAUTH_EXPORT_RE,
    "const { GET: authGet, POST: authPost } = handlers;\n\nexport const GET = withAmplio(authGet);\nexport const POST = withAmplio(authPost);",
  );

  await fs.writeFile(fullPath, wired, "utf8");
  return { status: "wired", file };
}

/**
 * Prepend the amplio tRPC middleware to T3's procedure bases:
 *   export const publicProcedure = t.procedure.use(timingMiddleware);
 * becomes
 *   export const publicProcedure = t.procedure.use(amplioMiddleware).use(timingMiddleware);
 */
export async function wireT3TrpcProcedures(
  cwd: string,
  telemetryDir: string,
): Promise<WireResult> {
  const file = T3_TRPC_FILE;
  const fullPath = path.join(cwd, file);
  if (!(await pathExists(fullPath))) {
    return { status: "not-found", file };
  }

  const source = await fs.readFile(fullPath, "utf8");
  if (source.includes("amplioTrpcMiddleware")) {
    return { status: "already", file };
  }

  PROCEDURE_EXPORT_RE.lastIndex = 0;
  const matches = [...source.matchAll(PROCEDURE_EXPORT_RE)];
  if (matches.length === 0) {
    return { status: "unrecognized", file };
  }

  const importPath = await middlewareImportForFile(cwd, telemetryDir, file, "trpc");
  let wired = insertAfterImports(
    source,
    `import { amplioTrpcMiddleware } from "${importPath}";`,
  );

  PROCEDURE_EXPORT_RE.lastIndex = 0;
  wired = wired.replace(
    PROCEDURE_EXPORT_RE,
    "export const $1$2t.procedure.use(amplioMiddleware)",
  );

  // Declare the shared middleware instance above the first procedure export,
  // hopping over any doc comment attached to that export.
  const firstExport = /export const (?:publicProcedure|protectedProcedure)/.exec(wired);
  if (!firstExport || firstExport.index === undefined) {
    return { status: "unrecognized", file };
  }
  const insertAt = commentBlockStart(wired, firstExport.index);
  const declaration =
    "// Annotates the ambient request wide event (spine) with trpc.* fields.\nconst amplioMiddleware = t.middleware(amplioTrpcMiddleware());\n\n";
  wired = wired.slice(0, insertAt) + declaration + wired.slice(insertAt);

  await fs.writeFile(fullPath, wired, "utf8");
  return { status: "wired", file };
}
