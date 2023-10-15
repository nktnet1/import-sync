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
