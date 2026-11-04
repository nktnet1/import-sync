import { registerHooks } from "node:module";

/** Resolve ESM package exports from the consumer's location, retaining URL suffixes. */
export function resolveImportFrom(specifier, parentURL) {
  // `import.meta.resolve` is synchronous but normally resolves relative to this
  // helper. Retarget only the requested specifier, preserving native ESM
  // conditions and any resolver hooks installed by the application.
  const hook = registerHooks({
    resolve(id, context, nextResolve) {
      return nextResolve(
        id,
        id === specifier ? { ...context, parentURL } : context,
      );
    },
  });
  try {
    return import.meta.resolve(specifier);
  } finally {
    hook.deregister();
  }
}
