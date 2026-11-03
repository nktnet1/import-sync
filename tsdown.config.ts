import { defineConfig } from "tsdown";

export default defineConfig({
  entry: "./src/index.ts",
  // The TypeScript 7 declaration generator uses the tsconfig directory as rootDir.
  tsconfig: "./tsconfig.build.json",
  format: "commonjs",
  platform: "node",
  outDir: "./dist",
  dts: true,
  clean: true,
  minify: false,
  sourcemap: true,
  exports: true,
  cjsDefault: true,
});
