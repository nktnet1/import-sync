import esm from "esm-sync";

import { findModuleFile, getCallerDirname } from "./files";
import { Options } from "./options";

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
    throw new Error(
      `
Failed to import from:
  ${modulePath}
Options:
  ${JSON.stringify(options)}
Require error message:
  ${message}`,
    );
  }
};

/** Whether a loader result resembles an empty namespace or plain object. */
const isEmptyObject = (value: unknown): boolean => {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.keys(value).length === 0
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
  const modulePath = /^\.\.?\//.test(id)
    ? findModuleFile(options.basePath ?? getCallerDirname(), id)
    : id;
  const importedModule = esmImport(modulePath, options);

  // Only empty plain objects or module namespaces need the CommonJS fallback.
  // Preserve direct exports such as null, functions, arrays and class instances.
  if (!isEmptyObject(importedModule)) {
    return importedModule;
  }

  // In case CJS shows up as empty, e.g. when importing CommonJS/CommonTS in a test runner
  try {
    // biome-ignore lint/style/noCommonJs: allow CommonJS require fallback
    const basicModule = require(modulePath);
    if (!isEmptyObject(basicModule)) {
      return basicModule;
    }
  } catch (_error) {
    /* nothing to do */
  }

  return importedModule;
};

export default importSync;
