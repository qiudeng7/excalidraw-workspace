import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { nodeStorage } from "../../server/storage/node";
import { handleApi } from "../../server/services/api";

const legacy = await readFile(
  new URL("../../migrations/0001_accounts.sql", import.meta.url),
  "utf8",
);
const seed = `INSERT INTO users VALUES('legacy','legacy@example.com','Legacy','admin','hash','2020-01-01');
INSERT INTO workspaces VALUES('legacy-space','legacy','Legacy','2020-01-01','2020-01-01');
INSERT INTO canvases(id,workspace_id,name,created_at,updated_at) VALUES('b','legacy-space','B','2020-01-01','2020-01-01'),('a','legacy-space','A','2020-01-01','2020-01-01'),('c','legacy-space','C','2020-01-02','2020-01-02');`;

test(`node: navigation and catalog CAS are atomic, migrated order and foreign keys are preserved`, async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "navigation-"));
  let close: () => unknown;
  let legacyWrite: (sql: string) => Promise<void>;
  let storage: Pick<
    Awaited<ReturnType<typeof nodeStorage>>,
    "repository" | "objects"
  >;
  const db = new DatabaseSync(resolve(directory, "workspace.sqlite"));

  db.exec(legacy);
  db.exec(seed);
  db.exec(
    "CREATE TABLE schema_migrations(name TEXT PRIMARY KEY);INSERT INTO schema_migrations VALUES('0001_accounts.sql')",
  );
  db.close();
  const node = await nodeStorage(directory);

  storage = node;
  const raw = new DatabaseSync(resolve(directory, "workspace.sqlite"));

  raw.exec("PRAGMA foreign_keys=ON");
  legacyWrite = async (sql) => {
    raw.exec(sql);
  };

  close = () => {
    raw.close();
    node.close();
  };

  const request = async (
    path: string,
    method = "GET",
    data?: unknown,
    cookie?: string,
  ) => {
    const promises: Promise<unknown>[] = [];
    const response = await handleApi(
      new Request(`https://demo.test/api${path}`, {
        method,
        headers: {
          Origin: "https://demo.test",
          "X-Requested-With": "excalidraw-demo",
          "Content-Type": "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }),
      {
        ...storage,
        publicOrigin: "https://demo.test",
        clientIp: "192.0.2.1",
        waitUntil: (p) => promises.push(p),
      },
    );

    await Promise.all(promises);

    return {
      status: response.status,
      body: (await response.json()) as any,
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  };

  try {
    const migrated = await storage.repository.canvasCatalog(
      "legacy-space",
      "legacy",
    );

    assert.deepEqual(
      migrated!.canvases.map((row) => [row.id, row.position]),
      [
        ["a", 0],
        ["b", 1],
        ["c", 2],
      ],
    );
    assert.equal(migrated!.catalogRevision, 0);
    assert.equal((await storage.repository.navigation("legacy")).revision, 0);
    await legacyWrite(
      "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES('transition','transition@example.com','Transition','user','hash','2020-01-01');INSERT INTO canvases(id,workspace_id,name,created_at,updated_at) VALUES('d','legacy-space','D','2020-01-03','2020-01-03');",
    );
    assert.equal(
      (await storage.repository.navigation("transition")).revision,
      0,
    );
    const appended = await storage.repository.canvasCatalog(
      "legacy-space",
      "legacy",
    );

    assert.deepEqual(
      appended!.canvases.map((row) => [row.id, row.position]),
      [
        ["a", 0],
        ["b", 1],
        ["c", 2],
        ["d", 3],
      ],
    );
    assert.equal(appended!.catalogRevision, 0);
    const alice = await request("/register", "POST", {
      email: "alice@example.com",
      password: "strong-password-123",
    });
    const bob = await request("/register", "POST", {
      email: "bob@example.com",
      password: "strong-password-123",
    });

    assert.equal(alice.status, 200);
    const space = (await request("/workspaces", "GET", undefined, alice.cookie))
      .body.workspaces[0];
    const list = () =>
      request(
        `/workspaces/${space.id}/canvases`,
        "GET",
        undefined,
        alice.cookie,
      );
    let catalog = (await list()).body;
    const first = catalog.canvases[0].id;
    const second = (
      await request(
        `/workspaces/${space.id}/canvases`,
        "POST",
        { name: "Second", catalogRevision: 0 },
        alice.cookie,
      )
    ).body.canvas.id;
    const third = (
      await request(
        `/workspaces/${space.id}/canvases`,
        "POST",
        { name: "Third", catalogRevision: 1 },
        alice.cookie,
      )
    ).body.canvas.id;

    catalog = (await list()).body;
    assert.equal(catalog.catalogRevision, 2);
    assert.equal(
      (
        await request(
          `/workspaces/${space.id}/canvas-order`,
          "PUT",
          { canvasIds: [first, first, third], catalogRevision: 2 },
          alice.cookie,
        )
      ).status,
      400,
    );
    const reorder = await request(
      `/workspaces/${space.id}/canvas-order`,
      "PUT",
      { canvasIds: [third, first, second], catalogRevision: 2 },
      alice.cookie,
    );

    assert.equal(reorder.status, 200);
    assert.deepEqual(
      reorder.body.canvases.map((row: any) => [
        row.id,
        row.position,
        row.revision,
      ]),
      [
        [third, 0, 0],
        [first, 1, 0],
        [second, 2, 0],
      ],
    );
    const stale = await request(
      `/workspaces/${space.id}/canvas-order`,
      "PUT",
      { canvasIds: [second, first, third], catalogRevision: 2 },
      alice.cookie,
    );

    assert.equal(stale.status, 409);
    assert.deepEqual(
      (await list()).body.canvases.map((row: any) => row.id),
      [third, first, second],
    );
    const otherSpace = (
      await request("/workspaces", "POST", { name: "Other" }, alice.cookie)
    ).body.workspace;
    const other = (
      await request(
        `/workspaces/${otherSpace.id}/canvases`,
        "POST",
        { name: "Other", catalogRevision: 0 },
        alice.cookie,
      )
    ).body.canvas.id;

    assert.equal(
      (
        await request(
          `/workspaces/${space.id}/canvas-order`,
          "PUT",
          { canvasIds: [other, first, second], catalogRevision: 3 },
          alice.cookie,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await request(
          `/workspaces/${space.id}/canvas-order`,
          "PUT",
          { canvasIds: [third, first, second], catalogRevision: 3 },
          bob.cookie,
        )
      ).status,
      404,
    );
    const navs = await Promise.all(
      [first, other].map((canvasId) =>
        request("/navigation", "PUT", { canvasId, revision: 0 }, alice.cookie),
      ),
    );

    assert.deepEqual(navs.map((row) => row.status).sort(), [200, 409]);
    const navigation = (
      await request("/navigation", "GET", undefined, alice.cookie)
    ).body;

    assert.equal(navigation.revision, 1);
    assert.equal(navigation.workspaces.length, 1);
    assert.equal(
      navigation.lastCanvasId,
      navigation.workspaces[0].lastCanvasId,
    );
    assert.equal(
      (
        await request(
          "/navigation",
          "PUT",
          { canvasId: first, revision: 0 },
          alice.cookie,
        )
      ).status,
      409,
    );
    assert.deepEqual(
      (await request("/navigation", "GET", undefined, alice.cookie)).body,
      navigation,
    );
    assert.equal(
      (
        await request(
          "/navigation",
          "PUT",
          { canvasId: first, revision: 0 },
          bob.cookie,
        )
      ).status,
      404,
    );
    const races = await Promise.all([
      request(
        `/workspaces/${space.id}/canvas-order`,
        "PUT",
        { canvasIds: [second, first, third], catalogRevision: 3 },
        alice.cookie,
      ),
      request(
        `/workspaces/${space.id}/canvases`,
        "POST",
        { name: "Race", catalogRevision: 3 },
        alice.cookie,
      ),
    ]);

    assert.deepEqual(races.map((row) => row.status).sort(), [200, 409]);
    catalog = (await list()).body;
    assert.equal(catalog.catalogRevision, 4);
    assert.equal(catalog.canvases.length, races[1].status === 200 ? 4 : 3);
    assert.deepEqual(
      catalog.canvases.map((row: any) => row.position),
      catalog.canvases.map((_: any, i: number) => i),
    );
    const beforeIds = catalog.canvases.map((row: any) => row.id);
    const deletionRaces = await Promise.all([
      request(
        `/workspaces/${space.id}/canvas-order`,
        "PUT",
        { canvasIds: [...beforeIds].reverse(), catalogRevision: 4 },
        alice.cookie,
      ),
      request(
        `/canvases/${second}`,
        "DELETE",
        { catalogRevision: 4 },
        alice.cookie,
      ),
    ]);

    assert.deepEqual(deletionRaces.map((row) => row.status).sort(), [200, 409]);
    catalog = (await list()).body;
    assert.equal(catalog.catalogRevision, 5);
    assert.deepEqual(
      catalog.canvases.map((row: any) => row.id),
      deletionRaces[0].status === 200
        ? [...beforeIds].reverse()
        : beforeIds.filter((id: string) => id !== second),
    );
    assert.equal(
      (
        await request(
          "/navigation",
          "PUT",
          { canvasId: first, revision: 1 },
          alice.cookie,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await request(
          `/canvases/${first}`,
          "DELETE",
          { catalogRevision: 5 },
          alice.cookie,
        )
      ).status,
      200,
    );
    const afterDelete = (
      await request("/navigation", "GET", undefined, alice.cookie)
    ).body;

    assert.equal(afterDelete.lastCanvasId, null);
    assert.equal(afterDelete.lastWorkspaceId, space.id);
    assert.equal(
      afterDelete.workspaces.find((row: any) => row.workspaceId === space.id)
        .lastCanvasId,
      null,
    );
    assert.equal(afterDelete.revision, 2);
    assert.equal(
      (
        await request(
          `/workspaces/${space.id}`,
          "DELETE",
          undefined,
          alice.cookie,
        )
      ).status,
      200,
    );
    const final = (await request("/navigation", "GET", undefined, alice.cookie))
      .body;

    assert.equal(final.lastWorkspaceId, null);
    assert.equal(final.lastCanvasId, null);
    assert.equal(
      final.workspaces.some((row: any) => row.workspaceId === space.id),
      false,
    );
  } finally {
    await close!();
    await rm(directory, { recursive: true, force: true });
  }
});
