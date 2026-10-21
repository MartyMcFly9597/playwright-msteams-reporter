const { copyFileSync, mkdirSync } = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const output = path.join(root, "dist", "esm");
mkdirSync(output, { recursive: true });
for (const name of ["index", "healthReporter"]) {
  copyFileSync(path.join(__dirname, "esm", `${name}.mjs`), path.join(output, `${name}.mjs`));
}