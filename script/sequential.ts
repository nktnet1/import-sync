// Preserve stage ordering and stop after the first failure without launching
// concurrent consumers or mixing their reporter output.
export function runSequential<T>(
  items: readonly T[],
  action: (item: T) => unknown,
): Promise<void> {
  return items.reduce<Promise<void>>(
    (previous, item) =>
      previous.then(async () => {
        await action(item);
      }),
    Promise.resolve(),
  );
}
