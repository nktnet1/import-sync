import path from 'path';
import { getCallerFilePath } from './files';
import { ESMOptions, Options } from './types';

/**
 * Creates an esm-compatible require function that can import ES Modules
 *
 * Removes the error for "[ERR_REQUIRE_ESM]: require() of ES Module", as per
 * - https://github.com/standard-things/esm/issues/855#issuecomment-657982788
 *
 * @returns an ESM-compatible require function
 */
const createEs6Require = (esmOptions: ESMOptions) => {
  /* istanbul ignore next */
  require('module').Module._extensions['.js'] = (m: any, filename: string) => {
    m._compile(require('fs').readFileSync(filename, 'utf-8'), filename);
  };
  return require('esm')(module, esmOptions);
};

/**
 * Imports ES6 modules synchronously similar to require in CommonJS
 * Can be used in both ES6 and CommonJS projects
 *
 * @param relativePath - the name or relative path of the module, e.g. ./arrays
 * @param {Options} [options] - options as defined in types.ts
 * @returns the imported module
 */
const importSync = (relativePath: string, options: Options = {}) => {
  const defaultOptions: Required<Options> = {
    basePath: path.dirname(getCallerFilePath()),
    esmOptions: {},
  };
  const opts = { ...defaultOptions, ...options };
  const filePath = path.join(opts.basePath, relativePath);
  const es6Require = createEs6Require(options.esmOptions);
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
