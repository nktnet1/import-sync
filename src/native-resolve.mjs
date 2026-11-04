import { createRequire, registerHooks } from "node:module";

/** Resolve using the consumer's package scope and optional Node conditions. */
function resolveFrom(specifier, parentURL) {
  const hook = registerHooks({
    resolve(id, context, nextResolve) {
      if (id !== specifier) return nextResolve(id, context);
      return nextResolve(id, { ...context, parentURL });
    },
  });
  try {
    return import.meta.resolve(specifier);
  } finally {
    hook.deregister();
  }
}

/** Resolve ESM package exports in the caller's scope, retaining URL suffixes. */
export function resolveImportFrom(specifier, parentURL) {
  return resolveFrom(specifier, parentURL);
}

/** Resolve require conditions without poisoning the native ESM resolution cache. */
let requireProbeIndex = 0;
export function resolveRequireFrom(specifier, parentURL) {
  // Use a fresh, never-loaded specifier so require() invokes the resolver even
  // when the real package is already cached. The temporary hook resolves the
  // requested id, then aborts before executing its module body.
  const probe = `./.__import_sync_require_probe_${++requireProbeIndex}.cjs`;
  const stopped = Symbol("import-sync require resolution captured");
  let resolved = null;
  const hook = registerHooks({
    resolve(id, context, nextResolve) {
      if (id !== probe) return nextResolve(id, context);
      resolved = nextResolve(specifier, { ...context, parentURL }).url;
      throw stopped;
    },
  });
  try {
    try {
      createRequire(parentURL)(probe);
      throw new Error("Native require resolution did not invoke the probe");
    } catch (error) {
      if (error !== stopped) throw error;
    }
  } finally {
    hook.deregister();
  }
  if (typeof resolved !== "string") {
    throw new TypeError("Native require resolution did not provide a URL");
  }
  return resolved;
}
