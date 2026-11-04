import { registerHooks } from "node:module";

/** Resolve using the consumer's package scope and optional Node conditions. */
function resolveFrom(specifier, parentURL, conditions) {
  const hook = registerHooks({
    resolve(id, context, nextResolve) {
      if (id !== specifier) return nextResolve(id, context);
      return nextResolve(id, {
        ...context,
        parentURL,
        ...(conditions ? { conditions } : {}),
      });
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

/** Resolve require-first conditions through Node's hook-aware ESM resolver. */
export function resolveRequireFrom(specifier, parentURL, conditions) {
  return resolveFrom(specifier, parentURL, conditions);
}
