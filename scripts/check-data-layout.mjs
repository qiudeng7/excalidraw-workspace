import { stat } from "node:fs/promises";

const legacy = await stat(".data/workspace.sqlite").then(
  () => true,
  (error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  },
);
if (legacy) {
  console.error(
    "Legacy data found. Stop the service and import it into a new directory before migrating; see docs/deployment.md.",
  );
  process.exitCode = 1;
}
