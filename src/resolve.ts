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
type StartupConditions = {
  import: Set<string>;
  require: Set<string>;
};

const readStartupConditions = (): StartupConditions => {
  /* v8 ignore next 7 -- @preserve: compatibility with Node before registerHooks. */
  if (typeof registerHooks !== "function") {
    const importConditions = getImportConditions();
    const requireConditions = new Set(importConditions);
    requireConditions.delete("import");
    requireConditions.add("require");
    return { import: importConditions, require: requireConditions };
  }

  const captured: { conditions?: readonly string[] } = {};
  const hook = registerHooks({
    resolve(_specifier, context) {
      captured.conditions = [...context.conditions];
      // The only operation during this short-lived hook is our internal
      // built-in probe. Do not pass it through user-installed resolver hooks.
      return { url: "node:os", shortCircuit: true };
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

  return {
    import: deriveImportConditions(captured.conditions),
    require: new Set(captured.conditions),
  };
};

/** Older Node 22 releases support require(esm) but not synchronous hooks. */
export const supportsNativeResolverHooks = (): boolean =>
  process.features.require_module && typeof registerHooks === "function";

// Snapshot the real process-start conditions, not mutable runtime flags.
const startupConditions = readStartupConditions();
const startupImportConditions = startupConditions.import;
export const getStartupRequireConditions = (): string[] => [
  ...startupConditions.require,
];

/** Prefer the existing require entry point; fall back only for missing conditions. */
export const resolvePackageId = (
  id: string,
  resolve: (id: string, options?: NodeJS.RequireResolveOptions) => string,
  resolveImport?: () => string,
): string => {
  try {
    return resolve(id);
  } catch (error) {
    switch ((error as NodeJS.ErrnoException | undefined)?.code) {
      case "ERR_PACKAGE_PATH_NOT_EXPORTED":
      case "ERR_PACKAGE_IMPORT_NOT_DEFINED":
        // CJS resolution discards ESM URL search parameters and fragments.
        // When available, use Node's import resolver in the consumer's scope.
        if (resolveImport) return resolveImport();
        return resolve(id, {
          conditions: new Set(startupImportConditions),
        } as NodeJS.RequireResolveOptions);
      case "MODULE_NOT_FOUND":
        // On Node 22, require.resolve() does not always invoke synchronous
        // resolver hooks, even when a hooked require() or import() succeeds.
        // Keep the original failure when ESM cannot resolve it either.
        if (resolveImport) {
          try {
            return resolveImport();
          } catch (nativeError) {
            // Keep the original CommonJS error only if native resolution also
            // reports a missing module. A hook may explicitly reject a
            // specifier, and its error must not be mistaken for a lookup miss.
            const code = (nativeError as NodeJS.ErrnoException | undefined)
              ?.code;
            if (
              code !== "ERR_MODULE_NOT_FOUND" &&
              code !== "MODULE_NOT_FOUND"
            ) {
              throw nativeError;
            }
          }
        }
        throw error;
      default:
        throw error;
    }
  }
};
