import { createRequire } from "node:module";

type ImportSync = typeof import("../src").default;

const nodeRequire = createRequire(import.meta.url);
const importSync = nodeRequire("../dist/index.cjs") as ImportSync;

export default importSync;
