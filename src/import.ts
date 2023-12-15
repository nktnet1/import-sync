import esm from '@httptoolkit/esm';

import { ESMOptions, Options } from './types';
import { findModuleFile, getCallerDirname } from './files';

/**
 * Creates an esm-compatible require function that can import ES Modules
 *
 * @returns an ESM-compatible require function
 */
/* istanbul ignore next */
const createEsmRequire = (esmOptions: ESMOptions) => {
  return esm(module, esmOptions);
};

/**
 * Returns an ESM-imported module
 *
 * @param modulePath absolute path or id of the module to import
 * @param options same options as importSync
 * @returns the esm imported module
 */
const esmImport = (modulePath: string, options: Options) => {
  const esmRequire = createEsmRequire(options.esmOptions);
  try {
    return esmRequire(modulePath);
  } catch (error: any) {
    throw new Error(`
        Failed to import from:
            ${modulePath}.
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
    const basicModule = require(modulePath);
    if (Object.keys(basicModule).length > 0) {
      return basicModule;
    }
  } catch (error) {
    /* nothing to do */
  }

  return importedModule;
};

export default importSync;
