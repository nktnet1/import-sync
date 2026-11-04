import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function withTemporaryDirectory<T>(
  prefix: string,
  run: (root: string) => T,
): T {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function createPackageDirectory(
  root: string,
  name: string,
  entryFilename: string,
  entrySource: string,
): string {
  const directory = join(root, name);
  mkdirSync(directory);
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ main: `./${entryFilename}` }),
  );
  writeFileSync(join(directory, entryFilename), entrySource);
  return directory;
}

/** Create a fixture package with import-only exports and a features directory. */
export function createImportOnlyPackageFixture(
  root: string,
  exports: Record<string, unknown>,
): string {
  const directory = join(root, "node_modules", "only-import");
  mkdirSync(join(directory, "features"), { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name: "only-import", type: "module", exports }),
  );
  return directory;
}
