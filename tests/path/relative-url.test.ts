import fs, { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test, vi } from "vitest";
import { findRelativeModuleFile } from "#/files.ts";
import importSync from "#/index.ts";
import { runConsumer } from "../helpers/consumer.ts";
import { withTemporaryDirectory } from "../helpers/fixtures.ts";

test.each([
  { description: "a query", file: "entry.mjs", id: "./entry.mjs?version=1" },
  { description: "a fragment", file: "entry.mjs", id: "./entry.mjs#section" },
  {
    description: "a query and fragment on an extensionless path",
    file: "entry.mjs",
    id: "./entry?version=1#section",
  },
  {
    description: "a percent-encoded filename without a query",
    file: "with space #%.mjs",
    id: "./with%20space%20%23%25.mjs",
  },
  {
    description: "a percent-encoded filename",
    file: "with space #%.mjs",
    id: "./with%20space%20%23%25.mjs?version=1",
  },
  { description: "an empty query", file: "entry.mjs", id: "./entry.mjs?" },
  { description: "an empty fragment", file: "entry.mjs", id: "./entry.mjs#" },
])(
  "resolves relative ESM specifiers containing $description",
  ({ file, id }) => {
    withTemporaryDirectory("import-sync-url-", (root) => {
      writeFileSync(join(root, file), 'export const value = "relative URL";\n');

      const result = importSync(id, { basePath: root });
      expect(result.value).toBe("relative URL");
      expect(importSync(id, { basePath: root })).toBe(result);
    });
  },
);

test("preserves cache identity for distinct relative query strings", () => {
  withTemporaryDirectory("import-sync-url-cache-", (root) => {
    const marker = join(root, "marker");
    writeFileSync(
      join(root, "entry.mjs"),
      `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(marker)}, "x"); export const token = {};`,
    );

    const first = importSync("./entry.mjs?a", { basePath: root });
    const second = importSync("./entry.mjs?b", { basePath: root });

    expect(first).not.toBe(second);
    expect(importSync("./entry.mjs?a", { basePath: root })).toBe(first);
    expect(readFileSync(marker, "utf8")).toBe("xx");
  });
});

test("preserves literal file paths containing special URL characters", () => {
  withTemporaryDirectory("import-sync-literal-", (root) => {
    const filename = "literal #%.mjs";
    writeFileSync(join(root, filename), "export const value = 42;\n");

    expect(importSync(`./${filename}`, { basePath: root }).value).toBe(42);
    expect(importSync(pathToFileURL(join(root, filename)).href).value).toBe(42);
  });
});

test("preserves unexpected filesystem errors when a relative URL cannot be inspected", () => {
  const expectedError = Object.assign(new Error("permission denied"), {
    code: "EACCES",
  });
  const stat = vi.spyOn(fs, "statSync").mockImplementation(() => {
    throw expectedError;
  });
  try {
    expect(() =>
      findRelativeModuleFile(realpathSync(tmpdir()), "./entry.mjs?version=1"),
    ).toThrow(expectedError);
  } finally {
    stat.mockRestore();
  }
});

test.each(["cjs", "mjs"])(
  "loads encoded relative URLs in a built %s consumer without basePath",
  (extension) => {
    withTemporaryDirectory("import-sync-url-consumer-", (root) => {
      const libraryPath = realpathSync(
        fileURLToPath(new URL("../../dist/index.cjs", import.meta.url)),
      );
      const source = join(root, "with space #%.mjs");
      writeFileSync(source, 'export const value = "consumer";\n');
      const prefix =
        extension === "mjs"
          ? `import importSync from ${JSON.stringify(pathToFileURL(libraryPath).href)};`
          : `const importSync = require(${JSON.stringify(libraryPath)});`;
      const consumer = join(root, `consumer.${extension}`);
      writeFileSync(
        consumer,
        `${prefix}\nconsole.log(importSync("./with%20space%20%23%25.mjs?version=1").value);\n`,
      );

      expect(runConsumer(consumer, root)).toBe("consumer");
    });
  },
);
