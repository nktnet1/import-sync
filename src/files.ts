import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VALID_FILE_EXTENSIONS } from "#/config.ts";

type CallSite = {
  getFileName(): string | null;
  getEvalOrigin(): string | null;
};

/** Whether an id is relative under the current platform's path syntax. */
export const isRelativePath = (
  id: string,
  separator: string = path.sep,
): boolean =>
  /^\.\.?\//.test(id) || (separator === "\\" && /^\.\.?\\/.test(id));

/**
 * Get the file path of the caller function.
 *
 * Implementation inspired by:
 * - https://www.npmjs.com/package/callsite?activeTab=code
 *
 * @returns {string} absolute path of the caller's directory
 * @throws {Error} if no caller file path is available
 */
export const getCallerDirname = (): string => {
  const originalPrepareStackTrace = Error.prepareStackTrace;
  const originalStackTraceLimit = Error.stackTraceLimit;

  try {
    // The caller is the second frame, even if the application limits stacks.
    if (Error.stackTraceLimit < 2) {
      Error.stackTraceLimit = 2;
    }
    Error.prepareStackTrace = (_, stack) => stack;
    const err = new Error("Capture caller stack trace");
    Error.captureStackTrace(err, getCallerDirname);
    const stack = err.stack as unknown as CallSite[] | undefined;

    const caller = stack?.[1];
    const callerFilePath = caller?.getFileName() ?? caller?.getEvalOrigin();
    if (!callerFilePath) {
      throw new Error("Unknown caller file path");
    }

    return path.resolve(
      path.dirname(
        callerFilePath.startsWith("file:")
          ? fileURLToPath(callerFilePath)
          : callerFilePath,
      ),
    );
  } finally {
    Error.prepareStackTrace = originalPrepareStackTrace;
    Error.stackTraceLimit = originalStackTraceLimit;
  }
};

/**
 * Find the module file path by checking for available extensions
 * as defined by VALID_FILE_EXTENSIONS
 *
 * @param {string} filePath The absolute path to the file
 * @returns {string} The resolved file path with appended extension
 * @throws {Error} If the file path does not match any valid extensions
 */
const findFileWithExtensions = (filePath: string): string => {
  for (const ext of VALID_FILE_EXTENSIONS) {
    const extFilePath = `${filePath}${ext}`;
    if (fs.statSync(extFilePath, { throwIfNoEntry: false })?.isFile()) {
      return extFilePath;
    }
  }
  throw new Error(
    `No such file '${filePath}' with matching extensions [${VALID_FILE_EXTENSIONS}]`,
  );
};

/**
 * Find the module file path
 *
 * @param {string} modulePath - The path to the module
 * @param {string} basePath - The base path for the module
 * @returns {string} The resolved file path
 * @throws {Error} If the file is not found
 */
export const findModuleFile = (
  basePath: string,
  modulePath: string,
): string => {
  const filePath = path.resolve(basePath, modulePath);
  if (fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
    return filePath;
  }
  try {
    return findFileWithExtensions(filePath);
  } catch (error) {
    // Native resolution may still use the directory's package.json or index.
    if (fs.statSync(filePath, { throwIfNoEntry: false })?.isDirectory()) {
      return filePath;
    }
    throw error;
  }
};
