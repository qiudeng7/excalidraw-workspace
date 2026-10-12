#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

const [action, origin, canvasId, directory] = process.argv.slice(2);
const cookie = process.env.WORKSPACE_COOKIE;

if (
  !["export", "restore"].includes(action) ||
  !origin ||
  !canvasId ||
  !directory ||
  !cookie
)
  throw new Error(
    "Usage: WORKSPACE_COOKIE=<owner session cookie> node scripts/room-backup.mjs export|restore <origin> <canvasId> <directory>",
  );
const base = new URL(origin).origin;
const route = `${base}/api/canvases/${encodeURIComponent(canvasId)}/collaboration/`;
const hash = (content) => createHash("sha256").update(content).digest("hex");

async function request(path, data) {
  const response = await fetch(route + path, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      Cookie: cookie,
      Origin: base,
      "X-Requested-With": "excalidraw-demo",
      "Content-Type": "application/json",
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });

  if (!response.ok)
    throw new Error(`${response.status}: ${await response.text()}`);

  return response.json();
}

function objectKeys(state) {
  return [
    ...new Set([
      ...Object.values(state.scene.files).map((file) => file.objectKey),
      ...state.versions.flatMap((version) => [
        version.sceneKey,
        ...Object.values(version.files).map((file) => file.objectKey),
      ]),
    ]),
  ];
}

if (action === "export") {
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const backup = await request("backup");
  const objects = {};

  for (const key of objectKeys(backup.state)) {
    const content = JSON.stringify(
      await request(`backup?object=${encodeURIComponent(key)}`),
    );
    const filename = `${hash(content)}.json`;

    await writeFile(join(directory, filename), content, {
      mode: 0o600,
      flag: "wx",
    }).catch(async (error) => {
      if (error.code !== "EEXIST") throw error;
      if ((await readFile(join(directory, filename), "utf8")) !== content)
        throw new Error("Backup hash collision");
    });
    objects[key] = filename;
  }

  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({ backup, objects }, null, 2),
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    `Exported room ${canvasId}: epoch=${backup.state.epoch}, seq=${backup.state.seq}, objects=${Object.keys(objects).length}`,
  );
} else {
  const { backup, objects } = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  );
  const current = await request("backup");

  if (
    backup.state.id !== canvasId ||
    backup.state.ownerId !== current.state.ownerId
  )
    throw new Error("Backup does not match the current canvas owner");
  const mapping = new Map();
  const versions = new Set(
    backup.state.versions.map((version) => version.sceneKey),
  );
  const rewrite = (references) => {
    for (const file of Object.values(references)) {
      if (!mapping.has(file.objectKey))
        throw new Error("Missing backup image object");
      file.objectKey = mapping.get(file.objectKey);
    }
  };
  const content = async (key) => {
    const filename = objects[key];

    if (typeof filename !== "string" || !/^[a-f0-9]{64}\.json$/.test(filename))
      throw new Error("Unsafe backup filename");
    const text = await readFile(join(directory, filename), "utf8");

    if (`${hash(text)}.json` !== filename)
      throw new Error("Backup checksum mismatch");

    return text;
  };

  for (const key of objectKeys(backup.state).filter(
    (key) => !versions.has(key),
  )) {
    const result = await request("restore-object", {
      content: await content(key),
    });

    mapping.set(key, result.key);
  }
  for (const version of backup.state.versions) {
    const scene = JSON.parse(await content(version.sceneKey));

    rewrite(scene.files);
    rewrite(version.files);
    version.sceneKey = (
      await request("restore-object", { content: JSON.stringify(scene) })
    ).key;
  }

  rewrite(backup.state.scene.files);
  const result = await request("restore", {
    backup,
    expectedEpoch: current.state.epoch,
    expectedSeq: current.state.seq,
    expectedAccessRevision: current.state.accessRevision,
  });

  console.log(
    `Restored room ${canvasId}: epoch=${result.epoch}, seq=${result.seq}. Reload existing editors.`,
  );
}
