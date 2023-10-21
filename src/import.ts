import esm from 'esm';
import fs from 'fs';
import { ESMOptions, Options } from './types';
import { findModuleFile, getCallerDirname } from './files';

/**
 * Creates an esm-compatible require function that can import ES Modules
 *
 * @returns an ESM-compatible require function
 */
/* istanbul ignore next */
const createEsmRequire = (esmOptions: ESMOptions) => {
  /**
   * Removes the error for "[ERR_REQUIRE_ESM]: require() of ES Module", as per
   * - https://github.com/standard-things/esm/issues/855#issuecomment-657982788
   */
  require('module').Module._extensions['.js'] = (m: any, filename: string) => {
    m._compile(fs.readFileSync(filename, 'utf-8'), filename);
  };
  const loader = esm(module, esmOptions);

  const newModule = module.constructor.length > 1 ? module.constructor : loader('module');
  const oldResolveFilename = newModule._resolveFilename;
  /**
   * Referencing
   * - https://github.com/kenotron/esm-jest/commit/624b9524ee698f5cbd16ee2481dc4cd0dec52e42
   * - https://github.com/standard-things/esm/issues/331#issuecomment-377056717
   */
  newModule._resolveFilename = function(request: string, parent: any, isMain: boolean) {
    const newRequest = request.startsWith('node:') ? request.substring(5) : request;
    return oldResolveFilename.call(this, newRequest, parent, isMain);
  };
  return loader;
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
  const modulePath = /^\.\.?\//.test(id) ? findModuleFile(id, basePath) : id;
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
