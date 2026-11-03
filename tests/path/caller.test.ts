import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { getCallerDirname } from "#/files.ts";
import importSync from "#/index.ts";

const libraryPath = fs.realpathSync(
  fileURLToPath(new URL("../../dist/index.cjs", import.meta.url)),
);

const withCapturedStack = (stack: unknown, assertion: () => void): void => {
  const originalCaptureStackTrace = Error.captureStackTrace;
  try {
    Error.captureStackTrace = (target: object) => {
      Object.defineProperty(target, "stack", {
        configurable: true,
        value: stack,
      });
    };
    assertion();
  } finally {
    Error.captureStackTrace = originalCaptureStackTrace;
  }
};

const fakeCallSite = (fileName: string | null, evalOrigin: string | null) => ({
  getFileName: () => fileName,
  getEvalOrigin: () => evalOrigin,
});

test("decodes escaped ESM caller URLs", () => {
  const callerFile = path.join(
    fs.realpathSync(process.cwd()),
    "space percent% hash# unicode-🍄.mjs",
  );
  withCapturedStack(
    [
      fakeCallSite(null, null),
      fakeCallSite(pathToFileURL(callerFile).href, null),
    ],
    () => {
      expect(getCallerDirname()).toBe(fs.realpathSync(process.cwd()));
    },
  );
});

test("uses the working directory for a relative eval caller", () => {
  withCapturedStack(
    [fakeCallSite(null, null), fakeCallSite("[eval]", null)],
    () => {
      expect(getCallerDirname()).toBe(fs.realpathSync(process.cwd()));
    },
  );
});

test("resolves package imports from a CommonJS eval caller", () => {
  const cwd = fs.realpathSync(process.cwd());
  const consumer = `const importSync = require(${JSON.stringify(libraryPath)});
if (typeof importSync("node-fetch").default !== "function") throw new Error("incorrect export");
`;
  const result = spawnSync(process.execPath, ["-e", consumer], {
    cwd,
    encoding: "utf8",
    timeout: 8_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});

test("falls back to eval origin when the caller filename is absent", () => {
  const callerFile = path.join(fs.realpathSync(process.cwd()), "eval.js");
  withCapturedStack(
    [fakeCallSite(null, null), fakeCallSite(null, callerFile)],
    () => {
      expect(getCallerDirname()).toBe(fs.realpathSync(process.cwd()));
    },
  );
});

test("reports unknown callers without leaking custom stack preparation", () => {
  const originalStackLimit = Error.stackTraceLimit;
  const originalStackPreparation = Error.prepareStackTrace;
  const customStackPreparation: typeof Error.prepareStackTrace = () => "custom";
  Error.prepareStackTrace = customStackPreparation;
  try {
    withCapturedStack([], () => {
      expect(() => getCallerDirname()).toThrow("Unknown caller file path");
    });
    expect(Error.prepareStackTrace).toBe(customStackPreparation);
    expect(Error.stackTraceLimit).toBe(originalStackLimit);
  } finally {
    Error.prepareStackTrace = originalStackPreparation;
  }
});

test.each([0, 1])(
  "resolves relative imports even with Error.stackTraceLimit=%i",
  (stackLimit) => {
    const originalStackLimit = Error.stackTraceLimit;
    const originalStackPreparation = Error.prepareStackTrace;
    try {
      Error.stackTraceLimit = stackLimit;
      expect(importSync("../basic/basic").helloString).toBe("helloworld");
      expect(Error.stackTraceLimit).toBe(stackLimit);
      expect(Error.prepareStackTrace).toBe(originalStackPreparation);
    } finally {
      Error.stackTraceLimit = originalStackLimit;
    }
  },
);

test("restores error stack hooks even if V8 stack capture throws", () => {
  const originalCaptureStackTrace = Error.captureStackTrace;
  const originalStackLimit = Error.stackTraceLimit;
  const originalStackPreparation = Error.prepareStackTrace;
  try {
    Error.stackTraceLimit = 0;
    Error.captureStackTrace = () => {
      throw new Error("capture failed");
    };
    expect(() => getCallerDirname()).toThrow("capture failed");
    expect(Error.stackTraceLimit).toBe(0);
    expect(Error.prepareStackTrace).toBe(originalStackPreparation);
  } finally {
    Error.captureStackTrace = originalCaptureStackTrace;
    Error.stackTraceLimit = originalStackLimit;
  }
});

test.each(["cjs", "mjs"])(
  "resolves imports from actual %s consumers in escaped directories",
  (extension) => {
    const temporaryRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "import-sync-path-")),
    );
    try {
      const directory = path.join(
        temporaryRoot,
        "space percent% hash# unicode-🍄",
      );
      fs.mkdirSync(directory);
      const caller = path.join(directory, `caller.${extension}`);
      fs.writeFileSync(
        path.join(directory, "fixture.mjs"),
        'export const marker = "decoded";\n',
      );
      const common = `const importSync = require(${JSON.stringify(libraryPath)});\nif (importSync("./fixture").marker !== "decoded") throw new Error("incorrect import");\n`;
      fs.writeFileSync(
        caller,
        extension === "mjs"
          ? `import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\n${common}`
          : common,
      );
      const result = spawnSync(process.execPath, [caller], {
        encoding: "utf8",
        timeout: 8_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
    } finally {
      fs.rmSync(temporaryRoot, { force: true, recursive: true });
    }
  },
  12_000,
);
