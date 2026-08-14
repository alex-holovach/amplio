// esbuild's minifier strips the `/* webpackIgnore: true */` magic comment from
// the "next/server" runtime probe in src/schedule-flush.ts, so webpack flags
// every `next build` with "Critical dependency: the request of a dependency is
// an expression". Re-inject the comment into the minified dist after tsup.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const distDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist",
);
const MAGIC = "/* webpackIgnore: true */ /* @vite-ignore */";

let annotated = 0;
for (const file of ["index.js", "legacy.js"]) {
  const filePath = path.join(distDir, file);
  let source;
  try {
    source = await readFile(filePath, "utf8");
  } catch {
    continue;
  }

  // Find the minified variable holding the "next/server" specifier, then
  // annotate the dynamic import() of that variable.
  const specifierVars = [
    ...source.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*"next\/server"/g),
  ].map((match) => match[1]);

  let next = source;
  for (const name of specifierVars) {
    const importCall = new RegExp(`import\\((${name})\\)`, "g");
    next = next.replace(importCall, (_full, arg) => {
      annotated += 1;
      return `import(${MAGIC} ${arg})`;
    });
  }

  if (next !== source) {
    await writeFile(filePath, next, "utf8");
  }
}

if (annotated === 0) {
  console.error(
    "annotate-dynamic-import: no import(<next/server var>) found in dist — " +
      "did schedule-flush.ts change shape?",
  );
  process.exit(1);
}
console.log(
  `annotate-dynamic-import: annotated ${annotated} dynamic import(s) with webpackIgnore`,
);
