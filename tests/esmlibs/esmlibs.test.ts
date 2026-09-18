import { expect, test } from "vitest";
import importSync from "../native-import-sync";

test("Esmlib importing node-fetch", () => {
  expect(typeof importSync("node-fetch").default).toStrictEqual("function");
});

test("Esmlib importing node-datachannel", () => {
  expect(typeof importSync("node-datachannel").initLogger).toStrictEqual(
    "function",
  );
});
