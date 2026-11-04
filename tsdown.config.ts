import { resolve } from "node:path";
import { defineConfig } from "tsdown";
import { emitDeclarations } from "./script/emit-declarations.ts";

export default defineConfig({
  entry: "./src/index.ts",
  // The TypeScript 7 declaration generator uses the tsconfig directory as rootDir.
  tsconfig: "./tsconfig.build.json",
  format: "commonjs",
  platform: "node",
  outDir: "./dist",
  // Preserve ESM declaration source maps and provide a correct CJS type facade.
  dts: { sourcemap: true },
  onSuccess: (config) => emitDeclarations(resolve(config.cwd, config.outDir)),
  clean: true,
  minify: false,
  sourcemap: true,
  // The package has type-specific export conditions; keep them authored in package.json.
  exports: false,
  cjsDefault: true,
});
