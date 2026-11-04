import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    maxWorkers: 1,
    include: ["**/*.test.{js,cjs,mjs,ts}"],
    exclude: [...configDefaults.exclude, "**/dist/**"],
    fsModuleCache: true,
    isolate: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // These are re-export/type-only entrypoints with no instrumentable logic.
      exclude: ["src/index.ts", "src/options.ts"],
    },
  },
});
