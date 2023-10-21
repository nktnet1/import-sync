import fs from 'fs';
import path from 'path';
import { VALID_FILE_EXTENSIONS } from './config';

/**
 * Get the file path of the caller function.
 *
 * Implementation inspired by:
 * - https://www.npmjs.com/package/callsite?activeTab=code
 *
 * @returns {string} absolute path or an empty string if no caller
 */
export const getCallerFilePath = (): string => {
  const orig = Error.prepareStackTrace;
  Error.prepareStackTrace = (_, stack) => stack;
  const err = new Error();
  Error.captureStackTrace(err, getCallerFilePath);
  const stack = err.stack as any;
  Error.prepareStackTrace = orig;
  return stack[1].getFileName();
};

/**
 * Find the module file path by checking for available extensions
 * as defined by VALID_FILE_EXTENSIONS
 *
 * @param {string} modulePath - The path to the module
 * @param {string} basePath - The base path for the module
 * @returns {string} The resolved file path
 * @throws {Error} If the file is not found
 */
export const findModuleFile = (modulePath: string, basePath: string): string => {
  const filePath = path.join(basePath, modulePath);
  if (fs.existsSync(filePath)) {
    return filePath;
  }
  if (!path.extname(filePath)) {
    for (const ext of VALID_FILE_EXTENSIONS) {
      const extFilePath = path.join(basePath, `${modulePath}${ext}`);
      if (fs.existsSync(extFilePath)) {
        return extFilePath;
      }
    }
  }
  throw new Error(
    `No such file '${filePath}' with matching extensions [${VALID_FILE_EXTENSIONS}]`
  );
};
