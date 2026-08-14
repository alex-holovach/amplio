import fs from "node:fs/promises";
import path from "node:path";

export function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

export function isPortableAbsolute(candidate: string): boolean {
  return path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate);
}

/** Resolve a possibly-not-yet-created path through its nearest existing ancestor. */
export async function canonicalizePath(candidate: string): Promise<string> {
  let existingAncestor = path.resolve(candidate);
  const missingSegments: string[] = [];

  while (true) {
    try {
      await fs.lstat(existingAncestor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) throw error;
      missingSegments.unshift(path.basename(existingAncestor));
      existingAncestor = parent;
    }
  }

  const canonicalAncestor = await fs.realpath(existingAncestor);
  return path.resolve(canonicalAncestor, ...missingSegments);
}

export async function isCanonicallyWithin(
  root: string,
  candidate: string,
): Promise<boolean> {
  const [canonicalRoot, canonicalCandidate] = await Promise.all([
    fs.realpath(path.resolve(root)),
    canonicalizePath(candidate),
  ]);
  return isPathWithin(canonicalRoot, canonicalCandidate);
}
