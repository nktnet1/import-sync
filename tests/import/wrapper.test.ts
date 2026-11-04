import fs, { realpathSync, writeFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  factory: vi.fn(),
  load: vi.fn(),
}));
vi.mock("esm-sync", () => ({ default: mocks.factory }));

import importSync from "#/import.ts";
import {
  createPackageDirectory,
  withTemporaryDirectory,
} from "../helpers/fixtures.ts";

const basicDirectory = realpathSync(
  fileURLToPath(new URL("../basic/", import.meta.url)),
);

beforeEach(() => {
  mocks.load.mockReset();
  mocks.factory.mockReset().mockReturnValue(mocks.load);
});

function expectBasicModuleResolution(id: string): void {
  const value = { sentinel: true };
  mocks.load.mockReturnValue(value);

  expect(importSync(id, { basePath: basicDirectory })).toBe(value);
  expect(mocks.load).toHaveBeenCalledExactlyOnceWith(
    join(basicDirectory, "basic.mjs"),
  );
}

function expectNativeFallback(path: string): void {
  const nativeResult = createRequire(import.meta.url)(path);
  mocks.load.mockReturnValue({});
  expect(importSync(path)).toBe(nativeResult);
}

test("resolves bare package IDs from the caller and forwards ESM options", () => {
  const esmOptions = { mode: "strict" } as const;
  const value = { sentinel: true };
  mocks.load.mockReturnValue(value);

  expect(importSync("node-fetch", { esmOptions })).toBe(value);
  expect(mocks.load).toHaveBeenCalledExactlyOnceWith(
    pathToFileURL(createRequire(import.meta.url).resolve("node-fetch")).href,
  );
  expect(mocks.factory).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    esmOptions,
  );
});

test("ignores basePath when resolving a package ID", () => {
  const value = { sentinel: true };
  mocks.load.mockReturnValue(value);

  expect(importSync("node-fetch", { basePath: "/ignored" })).toBe(value);
  expect(mocks.load).toHaveBeenCalledExactlyOnceWith(
    pathToFileURL(createRequire(import.meta.url).resolve("node-fetch")).href,
  );
});

test("ignores basePath for absolute paths", () => {
  const id = join(realpathSync(tmpdir()), "example-module.mjs");
  const value = { sentinel: true };
  mocks.load.mockReturnValue(value);

  expect(importSync(id, { basePath: "/ignored" })).toBe(value);
  expect(mocks.load).toHaveBeenCalledExactlyOnceWith(id);
});

test.each([
  { description: "a built-in package ID", id: "node:fs" },
  { description: "a bare built-in package ID", id: "fs" },
  {
    description: "an absolute path",
    id: join(realpathSync(tmpdir()), "fixture.mjs"),
  },
  {
    description: "a file URL",
    id: new URL("../basic/basic.mjs", import.meta.url).href,
  },
  {
    description: "an uppercase file URL",
    id: new URL("../basic/basic.mjs", import.meta.url).href.replace(
      /^file:/,
      "FILE:",
    ),
  },
])("does not capture a caller stack for $description", ({ id }) => {
  const originalCaptureStackTrace = Error.captureStackTrace;
  const value = { sentinel: true };
  mocks.load.mockReturnValue(value);

  try {
    Error.captureStackTrace = () => {
      throw new Error("Unnecessary caller stack capture");
    };
    expect(importSync(id)).toBe(value);
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith(id);
  } finally {
    Error.captureStackTrace = originalCaptureStackTrace;
  }
});

test("resolves extensionless paths against an explicit basePath", () => {
  expectBasicModuleResolution("./basic");
});

test("resolves relative basePath values from the working directory", () => {
  const value = { sentinel: true };
  mocks.load.mockReturnValue(value);
  const basePath = "tests/basic";
  const expectedRoot = realpathSync(process.cwd());

  expect(importSync("./basic", { basePath })).toBe(value);
  expect(mocks.load).toHaveBeenCalledExactlyOnceWith(
    realpathSync(join(expectedRoot, basePath, "basic.mjs")),
  );
});

test.skipIf(process.platform !== "win32")(
  "recognises backslash-prefixed relative paths on Windows",
  () => {
    expectBasicModuleResolution(String.raw`.\basic`);
  },
);

test.each([
  { description: "null", value: null },
  { description: "undefined", value: undefined },
  { description: "zero", value: 0 },
  { description: "false", value: false },
  { description: "an empty string", value: "" },
  { description: "a function", value: () => "hello" },
])("preserves $description returned by the loader", ({ value }) => {
  mocks.load.mockReturnValue(value);

  expect(importSync("node:fs")).toBe(value);
  expect(mocks.load).toHaveBeenCalledExactlyOnceWith("node:fs");
});

test.each([
  { description: "an empty array", value: [] },
  { description: "a Date instance", value: new Date(0) },
  { description: "a frozen empty object", value: Object.freeze({}) },
  {
    description: "a frozen null-prototype object",
    value: Object.freeze(Object.create(null)),
  },
])("preserves $description instead of falling back to require", ({ value }) => {
  mocks.load.mockReturnValue(value);

  expect(importSync("node:fs")).toBe(value);
});

test.each([
  {
    description: "symbol-only exports",
    value: { [Symbol.for("fixture")]: 42 },
  },
  {
    description: "non-enumerable exports",
    value: Object.defineProperty({}, "hidden", { value: 42 }),
  },
])("preserves $description without a native require fallback", ({ value }) => {
  mocks.load.mockReturnValue(value);

  expect(importSync("node:fs")).toBe(value);
});

test("does not introspect a Proxy returned by the loader", () => {
  const value = new Proxy(
    {},
    {
      isExtensible: () => {
        throw new Error("must not inspect an exported Proxy");
      },
    },
  );
  mocks.load.mockReturnValue(value);

  expect(importSync("node:fs")).toBe(value);
});

test("falls back to native require only for empty objects", () => {
  mocks.load.mockReturnValue({});
  const nativeFs = createRequire(import.meta.url)("node:fs");

  expect(importSync("node:fs")).toBe(nativeFs);
});

test.each([
  { name: "null", source: "module.exports = null;" },
  { name: "undefined", source: "module.exports = undefined;" },
  { name: "an empty array", source: "module.exports = [];" },
  { name: "a function", source: "module.exports = () => 42;" },
])("preserves $name from the native CommonJS fallback", ({ source }) => {
  withTemporaryDirectory("import-sync-fallback-", (root) => {
    const fixture = join(root, "fixture.cjs");
    writeFileSync(fixture, source);
    expectNativeFallback(fixture);
  });
});

test.each([
  { description: "file URL", uppercase: false, withQuery: false },
  { description: "uppercase file URL", uppercase: true, withQuery: false },
  {
    description: "file URL with query and fragment",
    uppercase: false,
    withQuery: true,
  },
  {
    description: "uppercase file URL with query and fragment",
    uppercase: true,
    withQuery: true,
  },
])(
  "keeps the correct CommonJS fallback behaviour for a $description",
  ({ uppercase, withQuery }) => {
    withTemporaryDirectory("import-sync-fallback-url-", (root) => {
      const fixture = join(root, "fixture #%.cjs");
      writeFileSync(fixture, 'module.exports = { source: "native CJS" };');
      const nativeResult = createRequire(import.meta.url)(fixture);
      const url = pathToFileURL(fixture).href;
      const id = `${uppercase ? url.replace(/^file:/, "FILE:") : url}${withQuery ? "?v=1#entry" : ""}`;
      const loaderValue = {};
      mocks.load.mockReturnValue(loaderValue);

      expect(importSync(id)).toBe(withQuery ? loaderValue : nativeResult);
      expect(mocks.load).toHaveBeenCalledExactlyOnceWith(id);
    });
  },
);

test("uses the native CommonJS fallback for directory package entries", () => {
  withTemporaryDirectory("import-sync-fallback-directory-", (root) => {
    const directory = createPackageDirectory(
      root,
      "fixture",
      "entry.cjs",
      'module.exports = { source: "native CJS directory" };',
    );
    expectNativeFallback(directory);
  });
});

test("keeps the original namespace if the native fallback is also empty", () => {
  withTemporaryDirectory("import-sync-fallback-empty-", (root) => {
    const fixture = join(root, "fixture.cjs");
    writeFileSync(fixture, "module.exports = {};");
    const namespace = {};
    mocks.load.mockReturnValue(namespace);

    expect(importSync(fixture)).toBe(namespace);
  });
});

test("returns the original empty result if the CommonJS fallback fails", () => {
  const value = {};
  mocks.load.mockReturnValue(value);

  expect(importSync(join(realpathSync(tmpdir()), "missing-fallback.cjs"))).toBe(
    value,
  );
});

test("adds the requested module and options to loader errors", () => {
  mocks.load.mockImplementation(() => {
    throw new Error("controlled failure");
  });
  const options = { basePath: "/unused" };

  expect(() => importSync("node:fs", options)).toThrow(
    /Failed to import from:\s+node:fs[\s\S]*Options:[\s\S]*"basePath":"\/unused"[\s\S]*Require error message:[\s\S]*controlled failure/,
  );
});

test("preserves the original loader error as the cause", () => {
  const cause = Object.assign(new Error("controlled failure"), {
    code: "MODULE_NOT_FOUND",
  });
  mocks.load.mockImplementation(() => {
    throw cause;
  });

  expect(() => importSync("node:fs")).toThrow(
    expect.objectContaining({ cause }),
  );
});

test("reports loader initialisation failures with the same context", () => {
  mocks.factory.mockImplementation(() => {
    throw new Error("factory failure");
  });

  expect(() => importSync("node:fs")).toThrow(
    /Failed to import from:[\s\S]*node:fs[\s\S]*factory failure/,
  );
});

test("wraps non-Error loader failures", () => {
  mocks.load.mockImplementation(() => {
    throw "non-Error failure";
  });

  expect(() => importSync("node:fs")).toThrow(
    /Failed to import from:[\s\S]*non-Error failure/,
  );
});

test("preserves import diagnostics even when options cannot be JSON serialized", () => {
  const options: { basePath: string; circular?: unknown } = {
    basePath: "/unused",
  };
  options.circular = options;
  mocks.load.mockImplementation(() => {
    throw new Error("original loader failure");
  });

  expect(() => importSync("node:fs", options)).toThrow(
    /Failed to import from:[\s\S]*node:fs[\s\S]*\[unserializable options\][\s\S]*original loader failure/,
  );
});

test.each([
  { name: "existing", exists: true },
  { name: "virtual", exists: false },
])(
  "forwards $name relative resolver hook redirects to the loader",
  ({ exists }) => {
    withTemporaryDirectory("import-sync-hooked-relative-unit-", (root) => {
      const original = join(root, exists ? "existing.mjs" : "virtual.mjs");
      const redirected = join(root, "redirected.mjs");
      if (exists) writeFileSync(original, "export const source = 'original';");
      writeFileSync(redirected, "export const source = 'redirected';");

      const hook = registerHooks({
        resolve(id, context, nextResolve) {
          if (id === (exists ? "./existing.mjs" : "./virtual.mjs")) {
            return { url: pathToFileURL(redirected).href, shortCircuit: true };
          }
          return nextResolve(id, context);
        },
      });
      try {
        const value = { sentinel: "hooked" };
        mocks.load.mockReturnValue(value);
        expect(
          importSync(`./${exists ? "existing" : "virtual"}.mjs`, {
            basePath: root,
          }),
        ).toBe(value);
        expect(mocks.load).toHaveBeenCalledExactlyOnceWith(
          pathToFileURL(redirected).href,
        );
      } finally {
        hook.deregister();
      }
    });
  },
);

test("does not swallow unrelated filesystem errors after resolving a hook redirect", () => {
  withTemporaryDirectory("import-sync-hook-permission-", (root) => {
    const redirected = join(root, "redirected.mjs");
    writeFileSync(redirected, "export const source = 'redirected';");
    const permissionError = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    const hook = registerHooks({
      resolve(id, context, nextResolve) {
        if (id === "./virtual.mjs")
          return { url: pathToFileURL(redirected).href, shortCircuit: true };
        return nextResolve(id, context);
      },
    });
    const originalStat = fs.statSync;
    const stat = vi
      .spyOn(fs, "statSync")
      .mockImplementation((filename, options) => {
        if (String(filename) === join(root, "virtual.mjs"))
          throw permissionError;
        return originalStat(filename, options);
      });
    try {
      expect(() => importSync("./virtual.mjs", { basePath: root })).toThrow(
        permissionError,
      );
      expect(mocks.load).not.toHaveBeenCalled();
    } finally {
      stat.mockRestore();
      hook.deregister();
    }
  });
});

test("keeps legacy extension discovery when native require(esm) is unavailable", () => {
  const nativeSupport = vi
    .spyOn(process.features, "require_module", "get")
    .mockReturnValue(false);
  try {
    expectBasicModuleResolution("./basic");
  } finally {
    nativeSupport.mockRestore();
  }
});

test("forwards a relative resolver-hook redirect to a builtin", () => {
  const hook = registerHooks({
    resolve(id, context, nextResolve) {
      if (id === "./virtual.mjs") {
        return { url: "node:os", shortCircuit: true };
      }
      return nextResolve(id, context);
    },
  });
  try {
    const value = { sentinel: true };
    mocks.load.mockReturnValue(value);
    expect(importSync("./virtual.mjs", { basePath: basicDirectory })).toBe(
      value,
    );
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith("node:os");
  } finally {
    hook.deregister();
  }
});

test.each(["?hook=1", "#hook"])(
  "forwards a same-file package hook suffix %s to the loader",
  (suffix) => {
    const packagePath = createRequire(import.meta.url).resolve("node-fetch");
    const hook = registerHooks({
      resolve(id, context, nextResolve) {
        if (id === "node-fetch") {
          return {
            url: `${pathToFileURL(packagePath).href}${suffix}`,
            shortCircuit: true,
          };
        }
        return nextResolve(id, context);
      },
    });
    try {
      const value = { sentinel: "hooked" };
      mocks.load.mockReturnValue(value);
      expect(importSync("node-fetch")).toBe(value);
      expect(mocks.load).toHaveBeenCalledExactlyOnceWith(
        `${pathToFileURL(packagePath).href}${suffix}`,
      );
    } finally {
      hook.deregister();
    }
  },
);

test("keeps a hook's virtual file URL when a package has an existing entry", () => {
  const virtual = pathToFileURL(
    join(realpathSync(tmpdir()), "import-sync-virtual-hook-entry.mjs"),
  ).href;
  const hook = registerHooks({
    resolve(id, context, nextResolve) {
      if (id === "node-fetch") return { url: virtual, shortCircuit: true };
      return nextResolve(id, context);
    },
  });
  try {
    const value = { sentinel: "virtual" };
    mocks.load.mockReturnValue(value);
    expect(importSync("node-fetch")).toBe(value);
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith(virtual);
  } finally {
    hook.deregister();
  }
});

test("forwards a virtual package resolver-hook redirect to a builtin", () => {
  const hook = registerHooks({
    resolve(id, context, nextResolve) {
      if (id === "virtual:builtin") {
        return { url: "node:os", shortCircuit: true };
      }
      return nextResolve(id, context);
    },
  });
  try {
    const value = { sentinel: "builtin" };
    mocks.load.mockReturnValue(value);
    expect(importSync("virtual:builtin")).toBe(value);
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith("node:os");
  } finally {
    hook.deregister();
  }
});

test("preserves a hook URL when the package file disappears during resolution", () => {
  const packageName = "import-sync-resolution-race-fixture";
  const root = realpathSync(fileURLToPath(new URL(".", import.meta.url)));
  const directory = join(root, "node_modules", packageName);
  const target = join(directory, "entry.cjs");
  const targetURL = pathToFileURL(target).href;
  fs.mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name: packageName, main: "entry.cjs" }),
  );
  writeFileSync(target, "module.exports = {};\n");

  const hook = registerHooks({
    resolve(id, context, nextResolve) {
      if (id === packageName) {
        // Node 22 resolves the actual file first, then invokes this hook
        // during the ESM-conditions probe; newer Nodes can invoke it earlier.
        fs.rmSync(target, { force: true });
        return { url: targetURL, shortCircuit: true };
      }
      return nextResolve(id, context);
    },
  });
  try {
    const result = { sentinel: "virtual package file" };
    mocks.load.mockReturnValue(result);
    expect(importSync(packageName)).toBe(result);
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith(targetURL);
  } finally {
    hook.deregister();
    fs.rmSync(directory, { force: true, recursive: true });
  }
});
