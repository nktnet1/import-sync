import { realpathSync, statSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { types } from "node:util";
import esm from "esm-sync";

import {
  findModuleFile,
  findRelativeModuleFile,
  getCallerFilename,
  isRelativePath,
  MissingModuleFileError,
  toESMRelativeSpecifier,
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

/** Use Node's ESM resolver with the actual consumer filename as the parent. */
const resolveNativeImportFrom = (
  id: string,
  callerFilename: string,
): string => {
  // biome-ignore lint/style/noCommonJs: the helper must remain ESM at runtime
  const { resolveImportFrom } = require(
    path.join(__dirname, "native-resolve.mjs"),
  ) as {
    resolveImportFrom: (id: string, parentURL: string) => string;
  };
  return resolveImportFrom(id, pathToFileURL(callerFilename).href);
};

/** Preserve hook redirects (including queries) that require.resolve loses. */
const resolvePackageOverride = (
  id: string,
  callerFilename: string,
  resolved: string,
): string => {
  // require.resolve can collapse a hooked file URL onto its filesystem path,
  // silently discarding a query or fragment even on current Node versions.
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
    pathToFileURL(callerFilename).href,
    getStartupRequireConditions(),
  );
  if (!isFileURL(candidate) || !path.isAbsolute(resolved)) return candidate;
  // A hook may intentionally select a symlink alias of the same real file.
  // Compare URL spelling instead of treating every realpath alias as identical.
  if (candidate !== pathToFileURL(resolved).href) return candidate;
  try {
    // A hook can also return a virtual file URL that has no disk entry. Keep
    // that URL rather than replacing it with require.resolve's path spelling.
    realpathSync(resolved);
    return resolved;
  } catch {
    return candidate;
  }
};

/** Resolve consumer package exports without resolving from import-sync itself. */
const resolveConsumerPackage = (id: string, callerFilename: string): string => {
  const resolved = resolvePackageId(
    id,
    createRequire(callerFilename).resolve,
    process.features.require_module
      ? () => resolveNativeImportFrom(id, callerFilename)
      : undefined,
  );
  return process.features.require_module
    ? resolvePackageOverride(id, callerFilename, resolved)
    : resolved;
};

/** Whether native URL resolution selected the unmodified relative specifier. */
const isDefaultRelativeURL = (
  id: string,
  callerFilename: string,
  resolved: string,
): boolean => {
  if (!isFileURL(resolved)) return false;
  const native = new URL(resolved);
  const expected = new URL(id, pathToFileURL(callerFilename).href);
  if (native.href === expected.href) return true;
  if (native.search !== expected.search || native.hash !== expected.hash) {
    return false;
  }

  // Without --preserve-symlinks, native resolution can canonicalise the
  // expected path. Only that exact canonical spelling is the default: a hook
  // choosing a different symlink alias still represents an override.
  const canonicalTarget = (url: URL): string => {
    const filename = fileURLToPath(url);
    try {
      return realpathSync(filename);
    } catch {
      // A default resolution may point at a nonexistent target. Its existing
      // parent remains enough to determine the canonical spelling.
      return path.join(
        realpathSync(path.dirname(filename)),
        path.basename(filename),
      );
    }
  };
  try {
    const canonical = pathToFileURL(canonicalTarget(expected));
    canonical.search = expected.search;
    canonical.hash = expected.hash;
    return native.href === canonical.href;
  } catch {
    // A hook can resolve a malformed specifier or a path whose decoded
    // parent does not exist. If the expected default cannot be canonicalised,
    // there is no evidence to discard the hook's valid native result.
    return false;
  }
};

/** Honour native hook overrides without decoding actual literal filenames. */
const resolveLiteralRelativeModule = (
  id: string,
  callerFilename: string,
  resolveLegacy: () => string,
): string => {
  // Encoded separators and NUL bytes cannot form native file URLs, but are
  // valid literal characters in a filesystem name on supported platforms.
  if (/%(?:2f|5c|00)/i.test(id)) return resolveLegacy();
  const specifier = toESMRelativeSpecifier(id);
  let native: string;
  try {
    native = resolveNativeImportFrom(specifier, callerFilename);
  } catch (error) {
    // Invalid percent escapes can name real filesystem files even though
    // Node's URL decoder rejects the unescaped relative specifier.
    if (error instanceof URIError && error.message === "URI malformed") {
      return resolveLegacy();
    }
    throw error;
  }
  return isDefaultRelativeURL(specifier, callerFilename, native)
    ? resolveLegacy()
    : native;
};

/** Resolve redirects installed by Node's synchronous hooks, retaining path rules. */
const resolveRelativeModule = (
  id: string,
  basePath: string,
  callerFilename: string,
): string => {
  const resolveLegacy = () => findRelativeModuleFile(basePath, id);
  if (!process.features.require_module) return resolveLegacy();

  // Literal filesystem names beat the URL interpretation of ?, # and %.
  if (
    /[?#%]/.test(id) &&
    statSync(path.resolve(basePath, id), { throwIfNoEntry: false })?.isFile()
  ) {
    return resolveLiteralRelativeModule(id, callerFilename, resolveLegacy);
  }

  const native = resolveNativeImportFrom(
    toESMRelativeSpecifier(id),
    callerFilename,
  );
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
  // A hook can choose a distinct symlink alias of the same canonical file.
  // Realpath equivalence must not erase that deliberate module identity.
  return legacyURL.href === native ? legacy : native;
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
    // Capture the caller here: V8 stack depth determines relative resolution.
    const callerFilename = options.basePath
      ? path.join(options.basePath, "__import_sync__.cjs")
      : getCallerFilename();
    modulePath = resolveRelativeModule(
      id,
      options.basePath ?? path.dirname(callerFilename),
      callerFilename,
    );
  } else if (path.isAbsolute(id)) {
    modulePath = findAbsoluteModulePath(id);
  } else if (isFileURL(id) || isBuiltin(id)) {
    modulePath = id;
  } else {
    modulePath = resolveConsumerPackage(id, getCallerFilename());
  }

  const resolvedId = preserveLiteralFilename(modulePath);
  return withCommonJSFallback(resolvedId, esmImport(resolvedId, options));
};

export default importSync;
