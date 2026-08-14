import fs from "node:fs/promises";
import path from "node:path";
import {
  findPackageManagerRoot,
  packageManagerLockfiles,
} from "./detect-package-manager.js";
import { pathExists } from "./fs.js";
import type { PackageManager } from "./install-deps.js";
import { isCanonicallyWithin, isPathWithin } from "./path-containment.js";

const LOCKFILES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
] as const;

export interface PackageMutationSnapshot {
  path: string;
  existed: boolean;
  content?: Buffer;
}

export async function snapshotPackageMutationFiles(
  cwd: string,
  packageManager: PackageManager,
  operation = "dependency install",
): Promise<PackageMutationSnapshot[]> {
  const projectRoot = path.resolve(cwd);
  const managerRoot = await findPackageManagerRoot(cwd, packageManager);
  if (!isPathWithin(managerRoot, projectRoot)) {
    throw new Error(
      `Package-manager root does not contain the project; ${operation} aborted. No files were changed.`,
    );
  }
  const files = [
    path.join(projectRoot, "package.json"),
    ...LOCKFILES.map((file) => path.join(projectRoot, file)),
    ...packageManagerLockfiles(packageManager).map((file) =>
      path.join(managerRoot, file),
    ),
  ].filter((file, index, all) => all.indexOf(file) === index);
  const snapshots: PackageMutationSnapshot[] = [];
  for (const file of files) {
    if (!(await isCanonicallyWithin(managerRoot, file))) {
      throw new Error(
        `${path.basename(file)} resolves outside the project; ${operation} aborted. No files were changed.`,
      );
    }
    const existed = await pathExists(file);
    snapshots.push({
      path: file,
      existed,
      ...(existed ? { content: await fs.readFile(file) } : {}),
    });
  }
  return snapshots;
}

export async function restorePackageMutationFiles(
  snapshots: PackageMutationSnapshot[],
): Promise<void> {
  for (const snapshot of [...snapshots].reverse()) {
    if (snapshot.existed) {
      await fs.writeFile(snapshot.path, snapshot.content!);
    } else {
      await fs.rm(snapshot.path, { force: true });
    }
  }
}
