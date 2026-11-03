/**
 * Native `require.resolve` uses CommonJS conditions by default. For a package
 * that publishes only an `import` entry, let Node resolve that condition instead
 * of attempting to interpret its exports map ourselves.
 *
 * The Set-based `conditions` option is supported by Node's resolver, but is not
 * part of the public `RequireResolveOptions` declaration. Keep it isolated here.
 */
/** Recreate the import conditions Node uses, including user-supplied flags. */
export const getImportConditions = (
  argv: readonly string[] = process.execArgv,
  nodeOptions: string = process.env.NODE_OPTIONS ?? "",
  supportsSyncRequire: boolean = process.features.require_module,
): Set<string> => {
  const conditions = new Set(["node", "import", "default"]);
  if (supportsSyncRequire) {
    conditions.add("module-sync");
  }
  // NODE_OPTIONS is processed before command-line flags by Node itself.
  const envArgs =
    nodeOptions
      .match(/(?:[^\s"]+|"[^"]*")+/g)
      ?.map((arg) => arg.replaceAll('"', "")) ?? [];
  const args = [...envArgs, ...argv];
  let addonsEnabled = true;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--no-addons") {
      addonsEnabled = false;
    } else if (arg === "--addons") {
      addonsEnabled = true;
    } else if (arg === "--conditions" || arg === "-C") {
      const value = args[++index];
      if (value) {
        conditions.add(value);
      }
    } else if (arg?.startsWith("--conditions=")) {
      const value = arg.slice("--conditions=".length);
      if (value) {
        conditions.add(value);
      }
    }
  }

  if (addonsEnabled) {
    conditions.add("node-addons");
  }

  return conditions;
};

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
        return resolve(id, {
          conditions: getImportConditions(),
        } as NodeJS.RequireResolveOptions);
      default:
        throw error;
    }
  }
};
