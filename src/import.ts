import esm from '@httptoolkit/esm';

import { findModuleFile, getCallerDirname } from './files';
import { Options } from './options';

/**
 * Returns an ESM-imported module
 *
 * @param modulePath absolute path or id of the module to import
 * @param options same options as importSync
 * @returns the esm imported module
 */
const esmImport = (modulePath: string, options: Options) => {
  const esmRequire = esm(module, options.esmOptions);
  try {
    return esmRequire(modulePath);
  } catch (error: any) {
    throw new Error(`
Failed to import from:
  ${modulePath}
Options:
  ${JSON.stringify(options)}
Require error message:
  ${error.stack}
    `);
  }
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
  const basePath = options.basePath ?? getCallerDirname();
  const modulePath = /^\.\.?\//.test(id) ? findModuleFile(basePath, id) : id;
  const importedModule = esmImport(modulePath, options);

  if (Object.keys(importedModule).length > 0) {
    return importedModule;
  }
  // In case CJS shows up as empty, e.g. when importing CommonJS/CommonTS into Jest
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const basicModule = require(modulePath);
    /* istanbul ignore next */
    if (Object.keys(basicModule).length > 0) {
      return basicModule;
    }
  } catch (_error) {
    /* nothing to do */
  }

  return importedModule;
};

export default importSync;
