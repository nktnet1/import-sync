import { defineConfig } from "tsdown";

export default defineConfig({
  entry: "./src/index.ts",
  // The TypeScript 7 declaration generator uses the tsconfig directory as rootDir.
  tsconfig: "./tsconfig.build.json",
  format: "commonjs",
  platform: "node",
  outDir: "./dist",
  // Keep the declaration source map referenced by index.d.cts in the tarball.
  dts: { sourcemap: true },
  clean: true,
  minify: false,
  sourcemap: true,
  exports: true,
  cjsDefault: true,
});
