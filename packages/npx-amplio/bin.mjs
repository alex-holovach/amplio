#!/usr/bin/env node
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const pkgDir = path.dirname(require.resolve("@useamplio/cli/package.json"));
await import(pathToFileURL(path.join(pkgDir, "dist/cli.js")).href);
