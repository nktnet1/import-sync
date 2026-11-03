/**
 * Native `require.resolve` uses CommonJS conditions by default. For a package
 * that publishes only an `import` entry, let Node resolve that condition instead
 * of attempting to interpret its exports map ourselves.
 *
 * The Set-based `conditions` option is supported by Node's resolver, but is not
 * part of the public `RequireResolveOptions` declaration. Keep it isolated here.
 */
const IMPORT_RESOLVE_OPTIONS: NodeJS.RequireResolveOptions & {
  conditions: Set<string>;
} = { conditions: new Set(["node", "import", "default"]) };

/** Prefer the existing require entry point; fall back only for missing conditions. */
export const resolvePackageId = (
  id: string,
  resolve: (id: string, options?: NodeJS.RequireResolveOptions) => string,
): string => {
  try {
    return resolve(id);
  } catch (error) {
    switch ((error as NodeJS.ErrnoException | undefined)?.code) {
      case "ERR_PACKAGE_PATH_NOT_EXPORTED":
      case "ERR_PACKAGE_IMPORT_NOT_DEFINED":
        return resolve(id, IMPORT_RESOLVE_OPTIONS);
      default:
        throw error;
    }
  }
};
