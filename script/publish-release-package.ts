import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { publishReleasePackage } from "./release-publisher.ts";

const { values } = parseArgs({
  options: {
    registry: { type: "string" },
    tag: { type: "string" },
    "expected-sha": { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});

if (!values.registry) throw new Error("--registry is required");
await publishReleasePackage({
  root: realpathSync(resolve(import.meta.dirname, "..")),
  registry: values.registry,
  ...(values.tag ? { tag: values.tag } : {}),
  ...(values["expected-sha"] ? { expectedSha: values["expected-sha"] } : {}),
  dryRun: values["dry-run"],
});
