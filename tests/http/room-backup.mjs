// Exercise the operator CLI against the same isolated Node/Worker service as the browser suite.
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { localClient, expect, report } from "./support/local-client.mjs";
import { command, temporaryDirectory, cleanup } from "./support/runtime.mjs";

const origin = process.argv[2];
const request = localClient(origin);
const initial = expect(await request("/bootstrap"), 200);
const auth = await request(
  initial.needsSetup ? "/setup" : "/register",
  "POST",
  {
    email: `backup-${crypto.randomUUID()}@example.test`,
    password: `Backup-${crypto.randomUUID()}!`,
  },
);

expect(auth, 200);
const cookie = auth.cookie;
const space = expect(
  await request("/workspaces", "GET", undefined, cookie),
  200,
).workspaces[0];
const canvas = expect(
  await request(`/workspaces/${space.id}/canvases`, "GET", undefined, cookie),
  200,
).canvases[0];
const route = `/canvases/${canvas.id}/collaboration/`;
const call = async (path, data) =>
  expect(
    await request(
      route + path,
      data === undefined ? "GET" : "POST",
      data,
      cookie,
    ),
    200,
  );
const view = await call("view");
const image = {
  id: "backup-image",
  mimeType: "image/png",
  created: Date.now(),
  dataURL:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j10kAAAAASUVORK5CYII=",
};

await call("assets", image);
const operation = {
  protocolVersion: 1,
  epoch: view.epoch,
  clientId: "backup-cli",
  clientSeq: 1,
  opId: "before-backup",
  baseSeq: 0,
  elements: [
    {
      id: "picture",
      type: "image",
      fileId: image.id,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      angle: 0,
      index: "a0",
      version: 1,
      versionNonce: 5,
    },
  ],
};

await call("update", operation);
await call("versions", { id: "backup-version", label: "CLI backup" });
const directory = await temporaryDirectory("excalidraw-backup-cli-");
const destination = join(directory, "export");
const cli = (action) =>
  command(["scripts/room-backup.mjs", action, origin, canvas.id, destination], {
    executable: process.execPath,
    env: { WORKSPACE_COOKIE: cookie },
  });

try {
  await cli("export");
  const manifest = JSON.parse(
    await readFile(join(destination, "manifest.json"), "utf8"),
  );

  assert.equal(manifest.backup.state.seq, 1);
  assert.equal(Object.keys(manifest.objects).length, 2);
  await call("update", {
    ...operation,
    opId: "after-backup",
    clientSeq: 2,
    baseSeq: 1,
    elements: [{ ...operation.elements[0], x: 200, version: 2 }],
  });
  await cli("restore");
  const restored = await call("view");

  assert.notEqual(restored.epoch, view.epoch);
  assert.equal(restored.seq, 0);
  assert.equal(restored.scene.elements[0].x, 0);
  assert.equal(restored.scene.files[image.id].dataURL, image.dataURL);
  const backup = await call("backup");
  const version = backup.state.versions[0];
  const snapshot = await call(
    `backup?object=${encodeURIComponent(version.sceneKey)}`,
  );

  assert.deepEqual(snapshot.files, version.files);
  assert.equal(snapshot.elements[0].x, 0);
  const storedImage = await call(
    `backup?object=${encodeURIComponent(version.files[image.id].objectKey)}`,
  );

  assert.equal(storedImage.dataURL, image.dataURL);
  // A damaged local object must fail before changing the restored room epoch.
  const filename = Object.values(manifest.objects)[0];

  await writeFile(join(destination, filename), "{}");
  await assert.rejects(cli("restore"));
  assert.equal((await call("view")).epoch, restored.epoch);
  report(
    "room backup CLI: images, fixed versions, fresh epoch and checksum rejection",
  );
} finally {
  await cleanup();
}
