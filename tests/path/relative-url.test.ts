import fs, {
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { registerHooks } from "node:module";
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

test("honours native redirects for existing literal URL-character filenames", () => {
  withTemporaryDirectory("import-sync-literal-hook-unit-", (root) => {
    const literal = join(root, "literal%20name.mjs");
    const target = join(root, "redirected.mjs");
    writeFileSync(literal, 'export const value = "literal";\n');
    writeFileSync(
      target,
      'export const value = "redirected"; export const url = import.meta.url;\n',
    );
    const hook = registerHooks({
      resolve(id, context, nextResolve) {
        if (id === "./literal%20name.mjs") {
          return {
            url: `${pathToFileURL(target).href}?tag=2`,
            shortCircuit: true,
          };
        }
        return nextResolve(id, context);
      },
    });
    try {
      const loaded = importSync("./literal%20name.mjs", { basePath: root });
      expect(loaded.value).toBe("redirected");
      expect(new URL(loaded.url).search).toBe("?tag=2");
    } finally {
      hook.deregister();
    }
  });
});

test("does not ignore a native hook redirect to a missing file", () => {
  withTemporaryDirectory("import-sync-missing-hook-unit-", (root) => {
    writeFileSync(
      join(root, "original.mjs"),
      'export const value = "original";\n',
    );
    const missingTarget = join(root, "hook-missing.mjs");
    const hook = registerHooks({
      resolve(id, context, nextResolve) {
        if (id === "./original.mjs") {
          return {
            url: pathToFileURL(missingTarget).href,
            shortCircuit: true,
          };
        }
        return nextResolve(id, context);
      },
    });
    try {
      expect(() => importSync("./original.mjs", { basePath: root })).toThrow();
    } finally {
      hook.deregister();
    }
  });
});

test("honours native redirects when the decoded filename does not exist", () => {
  withTemporaryDirectory("import-sync-literal-hook-missing-", (root) => {
    const literal = join(root, "literal%20missing.mjs");
    const target = join(root, "redirected.mjs");
    writeFileSync(literal, 'export const value = "literal";\n');
    writeFileSync(target, 'export const value = "redirected";\n');
    const hook = registerHooks({
      resolve(id, context, nextResolve) {
        if (id === "./literal%20missing.mjs") {
          return { url: pathToFileURL(target).href, shortCircuit: true };
        }
        return nextResolve(id, context);
      },
    });
    try {
      expect(
        importSync("./literal%20missing.mjs", { basePath: root }).value,
      ).toBe("redirected");
    } finally {
      hook.deregister();
    }
  });
});

test("preserves a literal filename containing an encoded path separator", () => {
  withTemporaryDirectory("import-sync-literal-encoded-separator-", (root) => {
    writeFileSync(
      join(root, "literal%2Fslash.mjs"),
      'export const value = "literal separator";\n',
    );
    expect(importSync("./literal%2Fslash.mjs", { basePath: root }).value).toBe(
      "literal separator",
    );
  });
});

test("honours a native hook redirecting a literal filename to a built-in", () => {
  withTemporaryDirectory("import-sync-literal-builtin-hook-", (root) => {
    writeFileSync(
      join(root, "literal%20builtin.mjs"),
      'export const value = "literal";\n',
    );
    const hook = registerHooks({
      resolve(id, context, nextResolve) {
        if (id === "./literal%20builtin.mjs") {
          return { url: "node:path", shortCircuit: true };
        }
        return nextResolve(id, context);
      },
    });
    try {
      expect(
        importSync("./literal%20builtin.mjs", { basePath: root }).sep,
      ).toBe(process.platform === "win32" ? "\\" : "/");
    } finally {
      hook.deregister();
    }
  });
});

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

const literalCollisionCases = [
  { literal: "literal%20space.mjs", decoded: "literal space.mjs" },
  { literal: "literal%23hash.mjs", decoded: "literal#hash.mjs" },
  { literal: "literal%3Fquery.mjs", decoded: "literal?query.mjs" },
  { literal: "literal%2Efile.mjs", decoded: "literal.file.mjs" },
  { literal: "literal?query.mjs", decoded: "literal" },
  { literal: "literal#hash.mjs", decoded: "literal" },
];

// '?' is not a legal filename character on Windows; run those two filesystem
// collisions only on platforms where both distinct files can actually exist.
test.each(
  literalCollisionCases.filter(
    ({ literal, decoded }) =>
      process.platform !== "win32" ||
      (!literal.includes("?") && !decoded.includes("?")),
  ),
)(
  "does not decode a literal filename $literal into an existing different module",
  ({ literal, decoded }) => {
    withTemporaryDirectory("import-sync-literal-collision-", (root) => {
      const literalPath = join(root, literal);
      writeFileSync(literalPath, 'export const value = "literal";\n');
      writeFileSync(join(root, decoded), 'export const value = "decoded";\n');

      const fromRelative = importSync(`./${literal}`, { basePath: root });
      const fromAbsolute = importSync(literalPath);
      const fromURL = importSync(pathToFileURL(literalPath).href);

      expect(fromRelative.value).toBe("literal");
      expect(fromRelative).toBe(fromAbsolute);
      expect(fromAbsolute).toBe(fromURL);
    });
  },
);

test("does not decode percent escapes in the containing directory", () => {
  withTemporaryDirectory("import-sync-literal-parent-", (root) => {
    const literalDirectory = join(root, "literal%20parent");
    const decodedDirectory = join(root, "literal parent");
    fs.mkdirSync(literalDirectory);
    fs.mkdirSync(decodedDirectory);
    writeFileSync(
      join(literalDirectory, "entry.mjs"),
      'export const value = "literal";\n',
    );
    writeFileSync(
      join(decodedDirectory, "entry.mjs"),
      'export const value = "decoded";\n',
    );

    const relative = importSync("./entry.mjs", { basePath: literalDirectory });
    expect(relative.value).toBe("literal");
    expect(importSync(join(literalDirectory, "entry.mjs"))).toBe(relative);
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

test.each([
  "bad%.mjs",
  "bad%2.mjs",
  "bad%GG.mjs",
  "bad%bad.mjs",
  "bad%C3%28.mjs",
])(
  "loads an existing literal filename with malformed percent encoding: %s",
  (filename) => {
    withTemporaryDirectory("import-sync-invalid-escape-", (root) => {
      const absolute = join(root, filename);
      writeFileSync(absolute, 'export const value = "literal";\n');
      const relative = importSync(`./${filename}`, { basePath: root });
      const fromURL = importSync(pathToFileURL(absolute).href);
      expect(relative.value).toBe("literal");
      expect(relative).toBe(fromURL);
    });
  },
);

test("honours hook redirects for existing malformed-percent filenames", () => {
  withTemporaryDirectory("import-sync-invalid-escape-hook-", (root) => {
    writeFileSync(
      join(root, "bad%GG.mjs"),
      'export const value = "literal";\n',
    );
    const target = join(root, "redirected.mjs");
    writeFileSync(target, 'export const value = "redirected";\n');
    const hook = registerHooks({
      resolve(id, context, nextResolve) {
        if (id === "./bad%GG.mjs") {
          return { url: pathToFileURL(target).href, shortCircuit: true };
        }
        return nextResolve(id, context);
      },
    });
    try {
      expect(importSync("./bad%GG.mjs", { basePath: root }).value).toBe(
        "redirected",
      );
    } finally {
      hook.deregister();
    }
  });
});

test.each([
  { label: "Error", makeError: () => new Error("blocked malformed filename") },
  {
    label: "URIError",
    makeError: () => new URIError("hook rejected malformed filename"),
  },
])(
  "preserves explicit $label hook errors for malformed-percent filenames",
  ({ makeError }) => {
    withTemporaryDirectory("import-sync-invalid-escape-blocked-", (root) => {
      writeFileSync(
        join(root, "bad%GG.mjs"),
        'export const value = "literal";\n',
      );
      const rejection = makeError();
      const hook = registerHooks({
        resolve(id, context, nextResolve) {
          if (id === "./bad%GG.mjs") throw rejection;
          return nextResolve(id, context);
        },
      });
      try {
        expect(() => importSync("./bad%GG.mjs", { basePath: root })).toThrow(
          rejection,
        );
      } finally {
        hook.deregister();
      }
    });
  },
);

test("honours hooks when the decoded parent of a literal filename is absent", () => {
  withTemporaryDirectory("import-sync-decoded-parent-missing-", (root) => {
    const literalParent = join(root, "literal%20parent");
    mkdirSync(literalParent);
    writeFileSync(
      join(literalParent, "entry.mjs"),
      'export const value = "literal";\n',
    );
    const redirected = join(root, "redirected.mjs");
    writeFileSync(redirected, 'export const value = "redirected";\n');
    const id = "./literal%20parent/entry.mjs";
    const hook = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === id) {
          return { url: pathToFileURL(redirected).href, shortCircuit: true };
        }
        return nextResolve(specifier, context);
      },
    });
    try {
      expect(importSync(id, { basePath: root }).value).toBe("redirected");
    } finally {
      hook.deregister();
    }
    // Without a redirect, the existing literal parent remains authoritative.
    expect(importSync(id, { basePath: root }).value).toBe("literal");
  });
});
