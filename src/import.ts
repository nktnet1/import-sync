import { realpathSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { types } from "node:util";
import esm from "esm-sync";

import {
  findRelativeModuleFile,
  getCallerDirname,
  isRelativePath,
} from "#/files.ts";
import { Options } from "#/options.ts";
import { resolvePackageId } from "#/resolve.ts";

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
    modulePath = findRelativeModuleFile(
      options.basePath ?? getCallerDirname(),
      id,
    );
  } else if (path.isAbsolute(id) || id.startsWith("file:") || isBuiltin(id)) {
    modulePath = id;
  } else {
    modulePath = resolvePackageId(
      id,
      createRequire(path.join(getCallerDirname(), "__import_sync__.cjs"))
        .resolve,
    );
  }

  const importedModule = esmImport(modulePath, options);

  // Preserve exports returned directly by the loader. A .mjs/.mts module may
  // deliberately export an empty object under the "module.exports" name; a
  // second native require would evaluate its side effects again.
  if (!isEmptyObject(importedModule)) {
    return importedModule;
  }
  const filename = modulePath.startsWith("file:")
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

export default importSync;
