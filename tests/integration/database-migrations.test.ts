import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const execute = promisify(execFile);
const migrations = resolve("server/db/migrations/sqlite");

test(
  "a failed NuxtHub migration exits before the Node start command",
  { timeout: 60000 },
  async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "hub-start-"));

    try {
      // NuxtHub generates @nuxthub/db in the project's node_modules.
      // Keep that namespace private so this CLI test cannot overwrite the app client.
      await mkdir(resolve(directory, "node_modules/@nuxthub"), {
        recursive: true,
      });
      for (const entry of await readdir(resolve("node_modules"))) {
        if (entry === "@nuxthub") continue;
        await symlink(
          resolve("node_modules", entry),
          resolve(directory, "node_modules", entry),
        );
      }

      await symlink(
        resolve("node_modules/@nuxthub/core"),
        resolve(directory, "node_modules/@nuxthub/core"),
        "dir",
      );
      await cp(migrations, resolve(directory, "server/db/migrations/sqlite"), {
        recursive: true,
      });
      await writeFile(
        resolve(directory, "server/db/migrations/sqlite/9999_failure.sql"),
        "SELECT * FROM missing_table;",
      );
      await writeFile(resolve(directory, "package.json"), '{"type":"module"}');
      await writeFile(
        resolve(directory, "nuxt.config.ts"),
        'export default defineNuxtConfig({modules:["@nuxthub/core"],hub:{db:{dialect:"sqlite",connection:{url:"file:.data/db/sqlite.db"},applyMigrationsDuringBuild:false,applyMigrationsDuringDev:false}}})',
      );
      const marker = resolve(directory, "started");

      await writeFile(
        resolve(directory, "start.mjs"),
        'import { writeFileSync } from "node:fs"; writeFileSync("started", "yes")',
      );
      await assert.rejects(
        execute(
          "sh",
          [
            "-c",
            '"$1" db migrate && node start.mjs',
            "sh",
            resolve("node_modules/.bin/nuxt"),
          ],
          { cwd: directory },
        ),
        (error) => {
          const result = error as {
            code: number;
            stdout: string;
            stderr: string;
          };

          assert.equal(result.code, 1);
          assert.match(result.stdout + result.stderr, /9999_failure\.sql/);
          assert.match(result.stdout + result.stderr, /missing_table/);

          return true;
        },
      );
      await assert.rejects(readFile(marker), { code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
