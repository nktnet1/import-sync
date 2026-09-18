import { expect, test } from "vitest";
import importSync from "../../src";
import nativeImportSync from "../native-import-sync";

test("Can resolve module imports that are pure-esm, e.g. node-fetch", () => {
  expect(nativeImportSync("node-fetch").default).toStrictEqual(
    expect.any(Function),
  );
});

test("Can resolve imports of imports that are pure-esm, e.g. node-fetch", () => {
  expect(importSync("./nodeFetchImport.js")).toStrictEqual({
    nodeFetch: expect.any(Function),
  });
});
