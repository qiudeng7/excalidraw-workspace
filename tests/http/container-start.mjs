import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const image = process.argv[2];
assert.ok(image, "Pass the image to test, e.g. workspace-check:runtime");
const prefix = `workspace-start-${process.pid}`;
const temporary = await mkdtemp(join(tmpdir(), `${prefix}-`));
const containers = new Set();
const volumes = new Set();

const docker = async (...args) =>
  (await execute("docker", args, { maxBuffer: 8 * 1024 * 1024 })).stdout.trim();

async function volume(name) {
  const result = `${prefix}-${name}`;
  await docker("volume", "create", result);
  volumes.add(result);

  return result;
}

async function launch(name, data, migrations) {
  const container = `${prefix}-${name}`;
  const args = [
    "run",
    "-d",
    "--name",
    container,
    "-v",
    `${data}:/app/.data`,
    "-e",
    "PUBLIC_ORIGIN=http://localhost:3000",
  ];
  if (migrations) {
    args.push("-v", `${migrations}:/app/.output/server/db/migrations:ro`);
  }
  containers.add(container);
  await docker(...args, image);

  return container;
}

async function ready(container, needsSetup) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const running = await docker(
      "inspect",
      "--format",
      "{{.State.Running}}",
      container,
    );
    assert.equal(running, "true", `${container} exited before becoming ready`);
    try {
      const body = JSON.parse(
        await docker(
          "exec",
          container,
          "node",
          "--input-type=module",
          "-e",
          "const r=await fetch('http://127.0.0.1:3000/api/bootstrap');if(!r.ok)throw Error(r.status);console.log(JSON.stringify(await r.json()))",
        ),
      );
      assert.equal(body.needsSetup, needsSetup);

      return body;
    } catch (error) {
      if (error.code === "ERR_ASSERTION") throw error;
      if (attempt === 59) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

async function stop(container) {
  await docker("stop", container);
  await docker("rm", container);
  containers.delete(container);
}

async function sql(container, query, read = false) {
  const source = `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync('/app/.data/db/sqlite.db');try{console.log(JSON.stringify(${read ? "db.prepare(process.argv[1]).all()" : "db.exec(process.argv[1]) ?? null"}))}finally{db.close()}`;

  return JSON.parse(
    await docker(
      "exec",
      container,
      "node",
      "--input-type=module",
      "-e",
      source,
      query,
    ),
  );
}

try {
  const freshData = await volume("fresh");
  let app = await launch("fresh", freshData);
  await ready(app, true);
  await docker(
    "exec",
    app,
    "sh",
    "-c",
    'test "$(id -u)" != 0 && test -w /app/.data/db && test -w /app/.data/blob',
  );
  const migrations = await sql(
    app,
    "SELECT name FROM _hub_migrations ORDER BY name",
    true,
  );
  assert.ok(migrations.length > 1);
  await sql(app, "UPDATE settings SET registration_enabled=0 WHERE id=1");
  await stop(app);
  app = await launch("repeat", freshData);
  assert.equal((await ready(app, true)).registrationEnabled, false);
  assert.deepEqual(
    await sql(app, "SELECT name FROM _hub_migrations ORDER BY name", true),
    migrations,
  );
  await stop(app);
  console.log("Fresh volume and repeat startup passed");

  // Make an old installation with the same official runner, withholding only
  // the newest SQL file. Its migration history must be reused during upgrade.
  const oldMigrations = join(temporary, "old");
  const oldSql = join(oldMigrations, "sqlite");
  const source = `${prefix}-assets`;
  containers.add(source);
  await docker("create", "--name", source, image);
  await docker(
    "cp",
    `${source}:/app/.output/server/db/migrations`,
    oldMigrations,
  );
  await docker("rm", source);
  containers.delete(source);
  const files = (await readdir(oldSql))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  assert.ok(files.length > 1);
  assert.equal(files.length, migrations.length);
  await rm(join(oldSql, files.at(-1)));
  await chmod(temporary, 0o755);
  await chmod(oldMigrations, 0o755);
  await chmod(oldSql, 0o755);
  const oldData = await volume("upgrade");
  app = await launch("old", oldData, oldMigrations);
  await ready(app, true);
  assert.equal(
    (await sql(app, "SELECT name FROM _hub_migrations", true)).length,
    files.length - 1,
  );
  await sql(
    app,
    "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES('fixture-user','fixture@example.com','Saved user','admin','fixture','2026-01-01'); INSERT INTO workspaces(id,user_id,name,created_at,updated_at) VALUES('fixture-workspace','fixture-user','Saved workspace','2026-01-01','2026-01-01')",
  );
  await stop(app);
  app = await launch("upgraded", oldData);
  await ready(app, false);
  assert.deepEqual(
    await sql(
      app,
      "SELECT name FROM workspaces WHERE id='fixture-workspace'",
      true,
    ),
    [{ name: "Saved workspace" }],
  );
  assert.equal(
    (await sql(app, "SELECT name FROM _hub_migrations", true)).length,
    files.length,
  );
  await stop(app);
  console.log("Old database upgraded and existing user/workspace preserved");

  const brokenMigrations = join(temporary, "broken");
  await cp(oldMigrations, brokenMigrations, { recursive: true });
  await chmod(brokenMigrations, 0o755);
  await chmod(join(brokenMigrations, "sqlite"), 0o755);
  await writeFile(
    join(brokenMigrations, "sqlite", "9999_invalid.sql"),
    "INVALID MIGRATION SQL;",
    { mode: 0o644 },
  );
  const broken = await launch(
    "broken",
    await volume("broken"),
    brokenMigrations,
  );
  const waited = await execute("docker", ["wait", broken], { timeout: 30000 });
  const exitCode = waited.stdout.trim();
  assert.notEqual(exitCode, "0");
  const output = await execute("docker", ["logs", broken]);
  const logs = `${output.stdout}\n${output.stderr}`;
  assert.match(logs, /9999_invalid/);
  assert.match(logs, /Database migration failed; server not started/);
  assert.doesNotMatch(logs, /Listening on/);
  const failure = await docker(
    "inspect",
    "--format",
    "{{.State.ExitCode}}",
    broken,
  );
  assert.notEqual(failure, "0");
  console.log("Failed migration exited without listening");
} finally {
  for (const container of containers) {
    try {
      await docker("rm", "-f", container);
    } catch (error) {
      console.error(
        `Could not remove test container ${container}:`,
        error.message,
      );
    }
  }
  for (const data of volumes) {
    try {
      await docker("volume", "rm", data);
    } catch (error) {
      console.error(`Could not remove test volume ${data}:`, error.message);
    }
  }
  await rm(temporary, { recursive: true, force: true });
}
