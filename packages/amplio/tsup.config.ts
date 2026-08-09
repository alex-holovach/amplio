import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/events.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  minify: true,
  target: "node20",
});
