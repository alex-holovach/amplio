import { readFile } from "node:fs/promises";
import path from "node:path";

export type DetectedFramework = "next" | "hono" | "express" | "fastify";

const FRAMEWORK_PRIORITY: DetectedFramework[] = ["next", "hono", "express", "fastify"];

const FRAMEWORK_DEPS: Record<DetectedFramework, readonly string[]> = {
  next: ["next"],
  hono: ["hono"],
  express: ["express"],
  fastify: ["fastify"],
};

export async function detectFramework(cwd: string): Promise<DetectedFramework | null> {
  const pkgPath = path.join(cwd, "package.json");
  let raw: string;
  try {
    raw = await readFile(pkgPath, "utf8");
  } catch {
    return null;
  }

  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(raw) as typeof pkg;
  } catch {
    return null;
  }

  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  for (const framework of FRAMEWORK_PRIORITY) {
    for (const dep of FRAMEWORK_DEPS[framework]) {
      if (dep in deps) {
        return framework;
      }
    }
  }

  return null;
}

export function shouldAutoScaffold(yes?: boolean): boolean {
  return yes === true || !process.stdout.isTTY;
}
