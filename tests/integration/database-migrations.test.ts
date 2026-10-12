import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
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
const importer = resolve("scripts/import-legacy-data.mjs");
const migrations = resolve("server/db/migrations/sqlite");

async function legacyData(directory: string) {
  await mkdir(directory);
  const db = new DatabaseSync(resolve(directory, "workspace.sqlite"));

  try {
    db.exec("CREATE TABLE schema_migrations(name TEXT PRIMARY KEY)");
    for (const file of (await readdir(migrations))
      .filter((name) => /^000[1-4]_.*\.sql$/.test(name))
      .sort()) {
      db.exec(await readFile(resolve(migrations, file), "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES(?)").run(file);
    }

    db.exec(
      "INSERT INTO users VALUES('legacy','legacy@example.com','Legacy','admin','hash','2020'); INSERT INTO sessions VALUES('session','legacy',9999999999999); INSERT INTO workspaces VALUES('space','legacy','Legacy','2020','2020',7); INSERT INTO canvases VALUES('canvas','space','Saved',3,'legacy/canvas/canvas/saved.json','2020','2020',0)",
    );
    await mkdir(resolve(directory, "objects/legacy/canvas/canvas"), {
      recursive: true,
    });
    await writeFile(
      resolve(directory, "objects/legacy/canvas/canvas/saved.json"),
      '{"elements":[{"id":"image"}],"files":{"image":"data:image/png;base64,abcd"}}',
    );
  } finally {
    db.close();
  }
}

test("offline import preserves accounts, sessions, revisions and snapshots without changing the source", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "hub-import-"));
  const source = resolve(root, "legacy");
  const target = resolve(root, "new-data");

  try {
    await legacyData(source);
    await execute(process.execPath, [
      importer,
      "--source",
      source,
      "--target",
      target,
    ]);
    const imported = new DatabaseSync(resolve(target, "db/sqlite.db"));
    const original = new DatabaseSync(resolve(source, "workspace.sqlite"));

    try {
      assert.equal(
        imported.prepare("SELECT revision FROM canvases").get()?.revision,
        3,
      );
      assert.equal(
        imported.prepare("SELECT catalog_revision FROM workspaces").get()
          ?.catalog_revision,
        7,
      );
      assert.equal(
        imported.prepare("SELECT token_hash FROM sessions").get()?.token_hash,
        "session",
      );
      assert.deepEqual(
        imported
          .prepare("SELECT name FROM _hub_migrations ORDER BY name")
          .all()
          .map((row) => row.name),
        [
          "0001_accounts",
          "0002_navigation",
          "0003_user_settings",
          "0004_prepend_new_canvases",
        ],
      );
      assert.equal(
        original
          .prepare("SELECT count(*) AS count FROM schema_migrations")
          .get()?.count,
        4,
      );
      assert.equal(
        original
          .prepare(
            "SELECT count(*) AS count FROM sqlite_master WHERE name='_hub_migrations'",
          )
          .get()?.count,
        0,
      );
      assert.equal(
        await readFile(
          resolve(target, "blob/legacy/canvas/canvas/saved.json"),
          "utf8",
        ),
        await readFile(
          resolve(source, "objects/legacy/canvas/canvas/saved.json"),
          "utf8",
        ),
      );
      await assert.rejects(
        execute(process.execPath, [
          importer,
          "--source",
          source,
          "--target",
          target,
        ]),
        /Destination already exists/,
      );
    } finally {
      imported.close();
      original.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing referenced snapshots abort import without publishing partial data", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "hub-missing-"));

  try {
    const source = resolve(root, "legacy");
    const target = resolve(root, "new-data");

    await legacyData(source);
    await rm(resolve(source, "objects"), { recursive: true });
    await assert.rejects(
      execute(process.execPath, [
        importer,
        "--source",
        source,
        "--target",
        target,
      ]),
      /ENOENT/,
    );
    assert.deepEqual((await readdir(root)).sort(), ["legacy"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
