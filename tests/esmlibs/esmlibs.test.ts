import { expect, test } from "@jest/globals";
import importSync from "../../src";

test("Esmlib importing node-fetch", () => {
  expect(typeof importSync("node-fetch").default).toStrictEqual("function");
});

test("Esmlib importing node-datachannel", () => {
  expect(typeof importSync("node-datachannel").initLogger).toStrictEqual(
    "function",
  );
});
