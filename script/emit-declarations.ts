import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

interface DeclarationMap {
  version: number;
  file: string;
  sources: string[];
  sourcesContent?: string[];
}

const cjsFacade = `import type esmImportSync from "./index.mjs";

declare function importSync(
  ...args: Parameters<typeof esmImportSync>
): ReturnType<typeof esmImportSync>;

declare namespace importSync {
  export type Options = import("./index.mjs").Options;
  export type ESMOptions = import("./index.mjs").ESMOptions;
}

export = importSync;
`;

/**
 * tsdown emits a .d.cts for its CJS output, but that ESM-style declaration
 * makes both NodeNext ESM default imports and TS `import = require` non-callable.
 * Keep tsdown's inferred declarations as ESM types and emit a typed CJS facade.
 */
export function emitDeclarations(directory: string): void {
  const cjsDeclaration = join(directory, "index.d.cts");
  const cjsMap = join(directory, "index.d.cts.map");
  const declaration = readFileSync(cjsDeclaration, "utf8");
  const mappingReference = "//# sourceMappingURL=index.d.cts.map";
  if (!declaration.includes(mappingReference)) {
    throw new Error("Generated declaration is missing its source map");
  }
  const mapping: unknown = JSON.parse(readFileSync(cjsMap, "utf8"));
  if (
    !mapping ||
    typeof mapping !== "object" ||
    !("version" in mapping) ||
    mapping.version !== 3 ||
    !("file" in mapping) ||
    mapping.file !== "index.d.cts" ||
    !("sources" in mapping) ||
    !Array.isArray(mapping.sources) ||
    !mapping.sources.every((source) => typeof source === "string")
  ) {
    throw new Error("Invalid generated declaration source map");
  }
  const map = mapping as DeclarationMap;
  const root = realpathSync(resolve(directory, ".."));
  const sourcesContent = map.sources.map((source) => {
    const sourcePath = realpathSync(resolve(directory, source));
    const location = relative(root, sourcePath);
    if (
      location === ".." ||
      location.startsWith(`..${sep}`) ||
      isAbsolute(location)
    ) {
      throw new Error(
        `Declaration source map points outside the project: ${source}`,
      );
    }
    return readFileSync(sourcePath, "utf8");
  });
  map.file = "index.d.mts";
  map.sourcesContent = sourcesContent;

  writeFileSync(
    join(directory, "index.d.mts"),
    declaration.replace(
      mappingReference,
      "//# sourceMappingURL=index.d.mts.map",
    ),
  );
  writeFileSync(join(directory, "index.d.mts.map"), JSON.stringify(map));
  writeFileSync(cjsDeclaration, cjsFacade);
  rmSync(cjsMap);
}
