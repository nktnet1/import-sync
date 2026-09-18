import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    maxWorkers: 1,
    include: ["**/*.test.{js,cjs,mjs,ts}"],
    exclude: [...configDefaults.exclude, "**/dist/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
    },
  },
});
