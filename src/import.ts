import { realpathSync, statSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { types } from "node:util";
import esm from "esm-sync";

import {
  findModuleFile,
  findRelativeModuleFile,
  getCallerDirname,
  isRelativePath,
  MissingModuleFileError,
} from "#/files.ts";
import { Options } from "#/options.ts";
import { getStartupRequireConditions, resolvePackageId } from "#/resolve.ts";

/**
 * Returns an ESM-imported module
 *
 * @param modulePath absolute path or id of the module to import
 * @param options same options as importSync
 * @returns the esm imported module
 */
const esmImport = (modulePath: string, options: Options) => {
  try {
    const esmRequire = esm(module, options.esmOptions);
    return esmRequire(modulePath);
  } catch (error: unknown) {
    /* v8 ignore next -- @preserve */
    const message = error instanceof Error ? error.stack : error;
    let serializedOptions: string;
    try {
      serializedOptions = JSON.stringify(options);
    } catch {
      serializedOptions = "[unserializable options]";
    }
    throw new Error(
      `
Failed to import from:
  ${modulePath}
Options:
  ${serializedOptions}
Require error message:
  ${message}`,
      { cause: error },
    );
  }
};

/** URL schemes are case-insensitive, including file: URLs. */
const isFileURL = (id: string): boolean => /^file:/i.test(id);

/** Whether an empty, extensible object may need a CommonJS fallback. */
const isEmptyObject = (value: unknown): boolean => {
  if (value === null || typeof value !== "object" || types.isProxy(value)) {
    return false;
  }
  // Successfully loaded ESM namespaces are non-extensible. Loading them again
  // through native require would evaluate their side effects twice.
  if (!Object.isExtensible(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(value).length === 0
  );
};

/** Use Node's ESM resolver with the consumer's directory as the parent. */
const resolveNativeImportFrom = (id: string, callerDirname: string): string => {
  // biome-ignore lint/style/noCommonJs: the helper must remain ESM at runtime
  const { resolveImportFrom } = require(
    path.join(__dirname, "native-resolve.mjs"),
  ) as {
    resolveImportFrom: (id: string, parentURL: string) => string;
  };
  return resolveImportFrom(
    id,
    pathToFileURL(path.join(callerDirname, "__import_sync__.cjs")).href,
  );
};

/** Check redirects of an existing package on Node 22, whose require.resolve ignores hooks. */
/* v8 ignore start -- @preserve: Node 22-only behaviour is tested with real CJS and ESM consumers. */
const resolveNode22PackageOverride = (
  id: string,
  callerDirname: string,
  resolved: string,
): string => {
  /* v8 ignore next 2 -- @preserve: only Node 22 lacks hook-aware require.resolve. */
  if (!process.versions.node.startsWith("22.") || !path.isAbsolute(resolved)) {
    return resolved;
  }

  // Do not swallow hook errors. A resolver may deliberately prohibit the
  // package even when a file exists at the require.resolve result.
  // biome-ignore lint/style/noCommonJs: the helper must remain ESM at runtime
  const { resolveRequireFrom } = require(
    path.join(__dirname, "native-resolve.mjs"),
  ) as {
    resolveRequireFrom: (
      id: string,
      parentURL: string,
      conditions: string[],
    ) => string;
  };
  const candidate = resolveRequireFrom(
    id,
    pathToFileURL(path.join(callerDirname, "__import_sync__.cjs")).href,
    getStartupRequireConditions(),
  );
  if (!isFileURL(candidate)) return candidate;
  try {
    const nativeURL = new URL(candidate);
    if (realpathSync(fileURLToPath(nativeURL)) !== realpathSync(resolved)) {
      return candidate;
    }
  } catch {
    // A load hook might provide a virtual module with no filesystem backing.
    return candidate;
  }
  return resolved;
};
/* v8 ignore stop -- @preserve */

/** Resolve consumer package exports without resolving from import-sync itself. */
const resolveConsumerPackage = (id: string, callerDirname: string): string => {
  const callerFile = path.join(callerDirname, "__import_sync__.cjs");
  const resolved = resolvePackageId(
    id,
    createRequire(callerFile).resolve,
    process.features.require_module
      ? () => resolveNativeImportFrom(id, callerDirname)
      : undefined,
  );
  return process.features.require_module
    ? resolveNode22PackageOverride(id, callerDirname, resolved)
    : resolved;
};

/** Resolve redirects installed by Node's synchronous hooks, retaining path rules. */
const resolveRelativeModule = (id: string, basePath: string): string => {
  const resolveLegacy = () => findRelativeModuleFile(basePath, id);
  if (!process.features.require_module) return resolveLegacy();

  // Literal filesystem names beat the URL interpretation of ?, # and %.
  if (
    /[?#%]/.test(id) &&
    statSync(path.resolve(basePath, id), { throwIfNoEntry: false })?.isFile()
  ) {
    return resolveLegacy();
  }

  const native = resolveNativeImportFrom(id, basePath);
  if (!isFileURL(native)) return native;

  const nativePath = fileURLToPath(native);
  if (!statSync(nativePath, { throwIfNoEntry: false })?.isFile()) {
    return resolveLegacy();
  }

  let legacy: string;
  try {
    legacy = resolveLegacy();
  } catch (error) {
    if (error instanceof MissingModuleFileError) return native;
    throw error;
  }

  const legacyURL = new URL(
    isFileURL(legacy) ? legacy : pathToFileURL(legacy).href,
  );
  const nativeURL = new URL(native);
  if (
    realpathSync(fileURLToPath(legacyURL)) === realpathSync(nativePath) &&
    legacyURL.search === nativeURL.search &&
    legacyURL.hash === nativeURL.hash
  ) {
    return legacy;
  }
  return native;
};

/** Match relative extension discovery for plain absolute filesystem paths. */
const findAbsoluteModulePath = (id: string): string =>
  path.extname(id) === "" && !/[?#]/.test(id) ? findModuleFile(".", id) : id;

/**
 * A resolved filesystem filename can contain literal URL characters. Pass it
 * as an encoded file URL so the loader cannot interpret "%20", "?", or "#"
 * as URL syntax and load a different file. A suffix on a nonexistent literal
 * path remains a query/fragment specifier.
 */
const preserveLiteralFilename = (modulePath: string): string => {
  if (
    path.isAbsolute(modulePath) &&
    /[?#%]/.test(modulePath) &&
    statSync(modulePath, { throwIfNoEntry: false })?.isFile()
  ) {
    return pathToFileURL(modulePath).href;
  }
  return modulePath;
};

/** Preserve loaded ESM exports, using native require only for empty CJS results. */
const withCommonJSFallback = (
  modulePath: string,
  importedModule: ReturnType<typeof esmImport>,
): ReturnType<typeof esmImport> => {
  // Preserve exports returned directly by the loader. A .mjs/.mts module may
  // deliberately export an empty object under the "module.exports" name; a
  // second native require would evaluate its side effects again.
  if (!isEmptyObject(importedModule)) {
    return importedModule;
  }
  // A file URL with query/fragment can have a different loader identity than
  // its filesystem path. Retrying it via native require would run it twice.
  if (isFileURL(modulePath) && /[?#]/.test(modulePath)) {
    return importedModule;
  }
  const filename = isFileURL(modulePath)
    ? fileURLToPath(modulePath)
    : modulePath;
  let resolvedFilename = filename;
  try {
    // Directory entry points and symlinks can conceal an .mjs/.mts module.
    // Native require of that module may execute it again after esm-sync did.
    resolvedFilename = realpathSync(require.resolve(filename));
  } catch {
    // A bare built-in or a missing native resolution has no filesystem target.
  }
  if ([".mjs", ".mts"].includes(path.extname(resolvedFilename))) {
    return importedModule;
  }

  // In case CJS shows up as empty, e.g. when importing CommonJS/CommonTS in a test runner
  try {
    // biome-ignore lint/style/noCommonJs: allow CommonJS require fallback
    const basicModule = require(filename);
    if (!isEmptyObject(basicModule)) {
      return basicModule;
    }
  } catch (_error) {
    /* nothing to do */
  }

  return importedModule;
};

/**
 * Imports ES6 modules synchronously similar to require in CommonJS
 * Can be used in both ES6 and CommonJS projects
 *
 * @param relativePath - the name or relative path of the module, e.g. ./arrays
 * @param {Options} [options] - options as defined in types.ts
 * @returns the imported module
 */
const importSync = (id: string, options: Options = {}) => {
  let modulePath: string;
  if (isRelativePath(id)) {
    // Resolve caller context here rather than from a helper: V8 stack depth is
    // part of getCallerDirname's existing contract.
    modulePath = resolveRelativeModule(
      id,
      options.basePath ?? getCallerDirname(),
    );
  } else if (path.isAbsolute(id)) {
    modulePath = findAbsoluteModulePath(id);
  } else if (isFileURL(id) || isBuiltin(id)) {
    modulePath = id;
  } else {
    modulePath = resolveConsumerPackage(id, getCallerDirname());
  }

  const resolvedId = preserveLiteralFilename(modulePath);
  return withCommonJSFallback(resolvedId, esmImport(resolvedId, options));
};

export default importSync;
