import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { VALID_FILE_EXTENSIONS } from "#/config.ts";

type CallSite = {
  getFileName(): string | null;
  getEvalOrigin(): string | null;
};

/** Extract the source filename from V8's potentially nested eval origins. */
const evalOriginFilename = (origin: string): string | undefined => {
  let location = origin;
  let evaluated = false;
  while (location.startsWith("eval at ")) {
    const opening = location.indexOf("(");
    if (opening < 0 || !location.endsWith(")")) return undefined;
    location = location.slice(opening + 1, -1);
    evaluated = true;
  }
  // V8 appends :line:column to eval origins, not to ordinary filenames.
  return evaluated ? location.replace(/:\d+:\d+$/, "") : location;
};

/** Dot-only paths name directories, regardless of platform. */
const isDirectoryShorthand = (id: string): boolean => id === "." || id === "..";

/** A final dot segment explicitly requests a directory, even without a slash. */
const endsInDirectoryShorthand = (id: string): boolean =>
  isDirectoryShorthand(path.basename(id));

/** Whether an id is relative under the current platform's path syntax. */
export const isRelativePath = (
  id: string,
  separator: string = path.sep,
): boolean =>
  isDirectoryShorthand(id) ||
  /^\.\.?\//.test(id) ||
  (separator === "\\" && /^\.\.?\\/.test(id));

/** Normalise Windows separators only for Node's URL-based ESM resolver. */
export const toESMRelativeSpecifier = (
  id: string,
  separator: string = path.sep,
): string => (separator === "\\" ? id.replaceAll("\\", "/") : id);

export type CallerLocation = {
  filename: string;
  parentURL: string;
};

/** Capture the caller's path and full URL, including ESM query or fragment. */
const captureCallerLocation = (boundary: Function): CallerLocation => {
  const originalPrepareStackTrace = Error.prepareStackTrace;
  const originalStackTraceLimit = Error.stackTraceLimit;

  try {
    // The caller is the second frame, even if the application limits stacks.
    if (Error.stackTraceLimit < 2) {
      Error.stackTraceLimit = 2;
    }
    Error.prepareStackTrace = (_, stack) => stack;
    const err = new Error("Capture caller stack trace");
    Error.captureStackTrace(err, boundary);
    const stack = err.stack as unknown as CallSite[] | undefined;

    const caller = stack?.[1];
    const fileName = caller?.getFileName();
    const origin = fileName ? undefined : caller?.getEvalOrigin();
    const callerFilePath =
      fileName ?? (origin ? evalOriginFilename(origin) : undefined);
    if (!callerFilePath) {
      throw new Error("Unknown caller file path");
    }

    const isURL = /^file:/i.test(callerFilePath);
    const filename = path.resolve(
      isURL ? fileURLToPath(callerFilePath) : callerFilePath,
    );
    return {
      filename,
      parentURL: isURL
        ? new URL(callerFilePath).href
        : pathToFileURL(filename).href,
    };
  } finally {
    Error.prepareStackTrace = originalPrepareStackTrace;
    Error.stackTraceLimit = originalStackTraceLimit;
  }
};

/** Return the caller's real parent URL for hook-aware native resolution. */
export const getCallerLocation = (): CallerLocation =>
  captureCallerLocation(getCallerLocation);

/** Return the V8 caller's actual filename for filesystem resolution. */
export const getCallerFilename = (): string =>
  captureCallerLocation(getCallerFilename).filename;

/** Resolve the caller directory without adding a stack frame to the lookup. */
export const getCallerDirname = (): string =>
  path.dirname(captureCallerLocation(getCallerDirname).filename);

export class MissingModuleFileError extends Error {}

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
  throw new MissingModuleFileError(
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
  // Final dot segments and trailing separators explicitly request directories.
  // Preserve the separator so a sibling file cannot shadow the directory.
  if (
    endsInDirectoryShorthand(modulePath) ||
    [path.sep, "/"].includes(modulePath.slice(-1))
  ) {
    if (fs.statSync(filePath, { throwIfNoEntry: false })?.isDirectory()) {
      // The loader needs the separator too: without it, a sibling
      // "directory.mjs" can take precedence over the directory's main file.
      return `${filePath}${path.sep}`;
    }
    throw new MissingModuleFileError(`No directory found at '${filePath}'`);
  }
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

/**
 * Resolve a relative specifier without changing support for literal filenames
 * containing URL special characters. When literal lookup fails, also accept
 * ESM-style percent encoding, search parameters and fragments.
 */
export const findRelativeModuleFile = (
  basePath: string,
  id: string,
): string => {
  try {
    return findModuleFile(basePath, id);
  } catch (error) {
    if (!(error instanceof MissingModuleFileError) || !/[?#%]/.test(id)) {
      throw error;
    }
  }

  const baseURL = pathToFileURL(`${path.resolve(basePath)}${path.sep}`);
  const specifierURL = new URL(id, baseURL);
  const resolvedPath = findModuleFile(basePath, fileURLToPath(specifierURL));
  // Preserve a bare "?" or "#": URL.search and URL.hash return "" for those.
  const suffixStart = specifierURL.href.search(/[?#]/);
  const suffix = suffixStart === -1 ? "" : specifierURL.href.slice(suffixStart);
  return `${pathToFileURL(resolvedPath).href}${suffix}`;
};
