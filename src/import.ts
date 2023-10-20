import esm from 'esm';
import path from 'path';
import fs from 'fs';
import { ESMOptions, Options } from './types';

/**
 * Creates an esm-compatible require function that can import ES Modules
 *
 * @returns an ESM-compatible require function
 */
/* istanbul ignore next */
const createEs6Require = (esmOptions: ESMOptions) => {
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
 * Imports ES6 modules synchronously similar to require in CommonJS
 * Can be used in both ES6 and CommonJS projects
 *
 * @param relativePath - the name or relative path of the module, e.g. ./arrays
 * @param {Options} [options] - options as defined in types.ts
 * @returns the imported module
 */
const importSync = (id: string, options: Options = {}) => {
  const defaultOptions: Required<Options> = {
    basePath: require.main?.path || '',
    esmOptions: {},
  };
  const opts = { ...defaultOptions, ...options };
  const filePath = path.join(opts.basePath, id);
  const es6Require = createEs6Require(opts.esmOptions);
  try {
    return es6Require(filePath);
  } catch (error: any) {
    throw new Error(`
        Failed to import from:
            ${filePath}.
        Options:
            ${JSON.stringify(options)}
        Require error message:
            ${error.stack}
    `);
  }
};

export default importSync;
