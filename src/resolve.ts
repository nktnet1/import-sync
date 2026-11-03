import { createRequire, registerHooks } from "node:module";

/**
 * Native `require.resolve` uses CommonJS conditions by default. For a package
 * that publishes only an `import` entry, let Node resolve that condition instead
 * of attempting to interpret its exports map ourselves.
 *
 * The Set-based `conditions` option is supported by Node's resolver, but is not
 * part of the public `RequireResolveOptions` declaration. Keep it isolated here.
 */
/** Tokenize NODE_OPTIONS using Node's double-quote and escape rules. */
const tokenizeNodeOptions = (nodeOptions: string): string[] => {
  const args: string[] = [];
  let currentArg = "";
  let inDoubleQuotes = false;

  for (let index = 0; index < nodeOptions.length; index++) {
    const character = nodeOptions[index];
    if (character === '"') {
      inDoubleQuotes = !inDoubleQuotes;
      continue;
    }
    if (
      inDoubleQuotes &&
      character === "\\" &&
      index + 1 < nodeOptions.length
    ) {
      currentArg += nodeOptions[++index];
      continue;
    }
    if (!inDoubleQuotes && /\s/.test(character)) {
      if (currentArg) {
        args.push(currentArg);
        currentArg = "";
      }
      continue;
    }
    currentArg += character;
  }
  if (currentArg) {
    args.push(currentArg);
  }
  return args;
};

/** Add custom flags without interpreting or stripping literal quote characters. */
const addConditionFlags = (
  args: readonly string[],
  conditions: Set<string>,
): void => {
  let addonsEnabled = true;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    switch (arg) {
      case "--no-addons":
        addonsEnabled = false;
        break;
      case "--addons":
        addonsEnabled = true;
        break;
      case "--conditions":
      case "-C": {
        const value = args[++index];
        if (value) {
          conditions.add(value);
        }
        break;
      }
      default:
        if (arg?.startsWith("--conditions=")) {
          const value = arg.slice("--conditions=".length);
          if (value) {
            conditions.add(value);
          }
        }
    }
  }
  if (addonsEnabled) {
    conditions.add("node-addons");
  }
};

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
  addConditionFlags([...tokenizeNodeOptions(nodeOptions), ...argv], conditions);
  return conditions;
};

/** Convert Node's require conditions to import conditions without losing explicit require flags. */
export const deriveImportConditions = (
  requireConditions: readonly string[],
): Set<string> => {
  const conditions = new Set(["import", "default"]);
  let removedBuiltinRequire = false;
  for (const condition of requireConditions) {
    if (condition === "require" && !removedBuiltinRequire) {
      removedBuiltinRequire = true;
      continue;
    }
    conditions.add(condition);
  }
  return conditions;
};

/**
 * Observe Node's actual process-start conditions through its native resolver.
 * Applications may edit NODE_OPTIONS or process.execArgv before importing us;
 * the resolver's condition list is not affected by those edits. The synchronous
 * hook API is available on Node 22.15+; older runtimes retain flag parsing.
 */
const readStartupImportConditions = (): Set<string> => {
  /* v8 ignore next -- @preserve: compatibility with Node before registerHooks. */
  if (typeof registerHooks !== "function") return getImportConditions();

  const captured: { conditions?: readonly string[] } = {};
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      captured.conditions = [...context.conditions];
      return nextResolve(specifier, context);
    },
  });
  try {
    // A built-in is side-effect-free and does not depend on the caller's path.
    createRequire(process.execPath)("node:os");
  } finally {
    hook.deregister();
  }
  /* v8 ignore next 2 -- @preserve: the native built-in resolution always invokes the hook. */
  if (!captured.conditions)
    throw new Error("Unable to determine native module conditions");

  return deriveImportConditions(captured.conditions);
};

// Snapshot the real process-start conditions, not mutable runtime flags.
const startupImportConditions = readStartupImportConditions();

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
          conditions: new Set(startupImportConditions),
        } as NodeJS.RequireResolveOptions);
      default:
        throw error;
    }
  }
};
