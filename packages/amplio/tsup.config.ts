import { defineConfig } from "tsup";

export default defineConfig(
  [
    ["index", "plugin", "testing"],
    ["legacy"],
  ].map((entries, index) => ({
    entry: entries.map((entry) => `src/${entry}.ts`),
    outDir: "dist",
    clean: index === 0,
    format: ["esm"],
    dts: true,
    sourcemap: true,
    splitting: false,
    treeshake: true,
    minify: true,
    target: "node20",
  })),
);
