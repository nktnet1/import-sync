import { existsSync, readFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

type PackageJSON = {
  name?: string;
  exports?: unknown;
  imports?: unknown;
};
type PackageScope = { directory: string; metadata: PackageJSON };
type Resolution = string | null | undefined;
type TargetContext = {
  scope: PackageScope;
  conditions: ReadonlySet<string>;
  isImports: boolean;
  replacement: string | undefined;
};

const resolverError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

const readPackageJSON = (directory: string): PackageJSON | undefined => {
  const filename = path.join(directory, "package.json");
  return existsSync(filename)
    ? (JSON.parse(readFileSync(filename, "utf8")) as PackageJSON)
    : undefined;
};

/** A package scope ends at node_modules, even when it has no package.json. */
const packageScope = (filename: string): PackageScope | undefined => {
  let directory = path.dirname(filename);
  while (path.basename(directory) !== "node_modules") {
    const metadata = readPackageJSON(directory);
    if (metadata) return { directory, metadata };
    const parent = path.dirname(directory);
    if (directory === parent) return undefined;
    directory = parent;
  }
  return undefined;
};

/** Node's require lookup paths retain the consumer's node_modules hierarchy. */
const findPackage = (
  name: string,
  parentFilename: string,
): PackageScope | undefined => {
  // Built-ins are handled before lookup, but Node types permit null paths.
  for (const directory of createRequire(parentFilename).resolve.paths(name) ??
    []) {
    const packageDirectory = path.join(directory, name);
    const metadata = readPackageJSON(packageDirectory);
    if (metadata) return { directory: packageDirectory, metadata };
  }
  return undefined;
};

/** Select the best subpath pattern, following Node's prefix/length priority. */
const matchPackageMap = (
  key: string,
  map: Record<string, unknown>,
): { target: unknown; replacement: string | undefined } | undefined => {
  if (Object.hasOwn(map, key) && !key.includes("*")) {
    return { target: map[key], replacement: undefined };
  }
  let bestKey = "";
  let replacement = "";
  for (const pattern of Object.keys(map)) {
    const star = pattern.indexOf("*");
    if (star < 0 || pattern.slice(star + 1).includes("*")) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (
      !key.startsWith(prefix) ||
      !key.endsWith(suffix) ||
      key.length < prefix.length + suffix.length
    ) {
      continue;
    }
    const previousStar = bestKey.indexOf("*");
    if (
      previousStar >= 0 &&
      (star < previousStar ||
        (star === previousStar && pattern.length <= bestKey.length))
    ) {
      continue;
    }
    bestKey = pattern;
    replacement = key.slice(prefix.length, key.length - suffix.length);
  }
  return bestKey ? { target: map[bestKey], replacement } : undefined;
};

/** Reject encoded separators and package-target directory traversal. */
const validateTarget = (
  target: string,
  replacement: string | undefined,
): void => {
  for (const component of [target.slice(2).split(/[?#]/, 1)[0], replacement]) {
    if (component === undefined) continue;
    if (/%(?:2f|5c)/i.test(component)) {
      throw resolverError("ERR_INVALID_MODULE_SPECIFIER", target);
    }
    for (const segment of component.split(/[\\/]/)) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment).toLowerCase();
      } catch {
        throw resolverError("ERR_INVALID_PACKAGE_TARGET", target);
      }
      if (decoded === "." || decoded === ".." || decoded === "node_modules") {
        throw resolverError("ERR_INVALID_PACKAGE_TARGET", target);
      }
    }
  }
};

/** Resolve string targets, including external package redirects from #imports. */
const resolveStringTarget = (
  target: string,
  context: TargetContext,
): string => {
  const expanded =
    context.replacement === undefined
      ? target
      : target.replaceAll("*", context.replacement);
  if (target.startsWith("./")) {
    validateTarget(target, context.replacement);
    return new URL(
      expanded,
      pathToFileURL(`${context.scope.directory}${path.sep}`),
    ).href;
  }
  if (!context.isImports || /^\.{1,2}(?:\/|$)|^\//.test(target)) {
    throw resolverError("ERR_INVALID_PACKAGE_TARGET", target);
  }
  // Package imports may redirect to packages, not to other #aliases.
  if (target.startsWith("#")) {
    throw resolverError("ERR_MODULE_NOT_FOUND", target);
  }
  return resolveImportSpecifier(
    expanded,
    path.join(context.scope.directory, "__import_sync__.cjs"),
    context.conditions,
  );
};

/** Preserve the final invalid target error when no array entry resolves. */
function resolveArrayTarget(
  options: readonly unknown[],
  context: TargetContext,
): Resolution {
  let last: Resolution | Error;
  for (const option of options) {
    try {
      const resolved = resolveTarget(option, context);
      if (resolved !== undefined && resolved !== null) return resolved;
      last = resolved;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ERR_INVALID_PACKAGE_TARGET"
      ) {
        throw error;
      }
      last = error as Error;
    }
  }
  if (last instanceof Error) throw last;
  return last;
}

/** Select conditions in declaration order, including nested condition maps. */
function resolveConditionalTarget(
  target: object,
  context: TargetContext,
): Resolution {
  for (const [condition, value] of Object.entries(target)) {
    if (/^(0|[1-9]\d*)$/.test(condition)) {
      throw resolverError("ERR_INVALID_PACKAGE_CONFIG", condition);
    }
    if (condition !== "default" && !context.conditions.has(condition)) {
      continue;
    }
    const resolved = resolveTarget(value, context);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

/** Resolve an import target using declaration-order conditions and Node's arrays. */
function resolveTarget(target: unknown, context: TargetContext): Resolution {
  if (typeof target === "string") return resolveStringTarget(target, context);
  if (target === null) return null;
  if (Array.isArray(target)) return resolveArrayTarget(target, context);
  if (typeof target === "object")
    return resolveConditionalTarget(target, context);
  throw resolverError(
    "ERR_INVALID_PACKAGE_TARGET",
    `Invalid package target type: ${typeof target}`,
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Convert exports and imports declarations into a subpath-keyed map. */
const packageMap = (
  entries: unknown,
  scope: PackageScope,
  isImports: boolean,
): Record<string, unknown> => {
  if (isImports) return isRecord(entries) ? entries : {};
  if (!isRecord(entries)) return { ".": entries };

  const keys = Object.keys(entries);
  const subpaths = keys.some((key) => key.startsWith("."));
  if (subpaths && keys.some((key) => !key.startsWith("."))) {
    throw resolverError("ERR_INVALID_PACKAGE_CONFIG", scope.directory);
  }
  return subpaths ? entries : { ".": entries };
};

const resolveMap = (
  id: string,
  entries: unknown,
  scope: PackageScope,
  conditions: ReadonlySet<string>,
  isImports: boolean,
): string => {
  const code = isImports
    ? "ERR_PACKAGE_IMPORT_NOT_DEFINED"
    : "ERR_PACKAGE_PATH_NOT_EXPORTED";
  const matched = matchPackageMap(id, packageMap(entries, scope, isImports));
  if (matched) {
    const resolved = resolveTarget(matched.target, {
      scope,
      conditions,
      isImports,
      replacement: matched.replacement,
    });
    if (resolved !== null && resolved !== undefined) return resolved;
  }
  throw resolverError(code, `${id} in ${scope.directory}/package.json`);
};

/** Use import conditions for external targets of package imports, too. */
function resolveImportSpecifier(
  specifier: string,
  filename: string,
  conditions: ReadonlySet<string>,
): string {
  if (isBuiltin(specifier)) return specifier;
  if (specifier.startsWith("#")) {
    const scope = packageScope(filename);
    if (!scope)
      throw resolverError("ERR_PACKAGE_IMPORT_NOT_DEFINED", specifier);
    return resolveMap(
      specifier,
      scope.metadata.imports,
      scope,
      conditions,
      true,
    );
  }
  const nameAndSubpath = /^((?:@[^/\\%]+\/)?[^./\\%][^/\\%]*)(\/.*)?$/.exec(
    specifier,
  );
  if (!nameAndSubpath) {
    throw resolverError("ERR_INVALID_MODULE_SPECIFIER", specifier);
  }
  const [, name, subpath] = nameAndSubpath;
  const scope = packageScope(filename);
  const target =
    scope?.metadata.name === name && scope.metadata.exports != null
      ? scope
      : findPackage(name, filename);
  if (!target) {
    // Legacy packages may have an index.js without any package.json.
    try {
      return createRequire(filename).resolve(specifier);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") {
        throw error;
      }
      throw resolverError("ERR_MODULE_NOT_FOUND", specifier);
    }
  }
  if (target.metadata.exports == null) {
    return createRequire(filename).resolve(specifier);
  }
  return resolveMap(
    subpath ? `.${subpath}` : ".",
    target.metadata.exports,
    target,
    conditions,
    false,
  );
}

/** Import-condition fallback for Node versions without synchronous hooks. */
export const resolveLegacyImport = (
  id: string,
  consumerFilename: string,
  conditions: ReadonlySet<string>,
): string => resolveImportSpecifier(id, consumerFilename, conditions);
