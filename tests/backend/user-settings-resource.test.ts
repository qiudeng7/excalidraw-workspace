import { test } from "node:test";
import assert from "node:assert/strict";
import { createUserSettingsResource } from "../../src/lib/userSettings";
import {
  createDefaultUserSettings,
  type UserSettingsDocument,
} from "../../shared/contracts";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const document = (revision = 0): UserSettingsDocument => ({
  settings: createDefaultUserSettings(),
  revision,
  configured: revision > 0,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
test("settings GET failure is readonly, then initializes complete cloud state before writes", async () => {
  const original = globalThis.fetch;
  const calls: unknown[] = [];
  let fail = true;
  const cloud = document(4);
  cloud.settings.features.nunitoFont = false;
  globalThis.fetch = (async (_url, options) => {
    calls.push(options?.method);
    assert.equal(
      new Headers(options?.headers).get("X-Settings-Owner"),
      "alice",
    );
    if (options?.method === "GET")
      return fail ? json({ error: { message: "offline" } }, 503) : json(cloud);
    return json({ ...cloud, revision: 5 });
  }) as typeof fetch;
  const resource = createUserSettingsResource("alice");
  try {
    assert.equal(await resource.load(), false);
    assert.equal(resource.state.ready, false);
    assert.equal(resource.update(createDefaultUserSettings()), false);
    assert.equal(await resource.flush(), true);
    assert.deepEqual(calls, ["GET"]);
    fail = false;
    assert.equal(await resource.retry(), true);
    assert.equal(resource.state.settings.features.nunitoFont, false);
    const next = structuredClone(cloud.settings);
    next.features.edgeBinding = false;
    resource.update(next);
    assert.equal(await resource.flush(), true);
    assert.equal(resource.state.revision, 5);
    assert.equal(resource.state.status, "synced");
  } finally {
    resource.dispose();
    globalThis.fetch = original;
  }
});
test("settings saves serialize and combine later updates without overwriting local preview", async () => {
  const original = globalThis.fetch;
  const first = deferred<Response>();
  const bodies: any[] = [];
  globalThis.fetch = (async (_url, options) => {
    if (options?.method === "GET") return json(document());
    const body = JSON.parse(options?.body as string);
    bodies.push(body);
    if (bodies.length === 1) return first.promise;
    return json({ settings: body.settings, revision: 2, configured: true });
  }) as typeof fetch;
  const resource = createUserSettingsResource("alice");
  try {
    await resource.load();
    const next = createDefaultUserSettings();
    next.debug.sampling = 1.5;
    resource.update(next);
    const saving = resource.flush();
    const newer = structuredClone(next);
    newer.debug.sampling = 2;
    resource.update(newer);
    first.resolve(json({ settings: next, revision: 1, configured: true }));
    assert.equal(await saving, true);
    assert.equal(bodies.length, 2);
    assert.deepEqual(
      bodies.map((body) => body.revision),
      [0, 1],
    );
    assert.equal(bodies[1].settings.debug.sampling, 2);
    assert.equal(resource.state.settings.debug.sampling, 2);
    assert.equal(resource.state.revision, 2);
  } finally {
    resource.dispose();
    globalThis.fetch = original;
  }
});
test("settings conflict requires explicit cloud or local choice; save errors retain pending values", async () => {
  const original = globalThis.fetch;
  let cloud = document();
  let error = false;
  const bodies: any[] = [];
  globalThis.fetch = (async (_url, options) => {
    if (options?.method === "GET") return json(cloud);
    const body = JSON.parse(options?.body as string);
    bodies.push(body);
    if (error) return json({ error: { message: "offline" } }, 503);
    if (body.revision !== cloud.revision)
      return json(
        { error: { code: "USER_SETTINGS_CONFLICT", message: "conflict" } },
        409,
      );
    cloud = {
      settings: body.settings,
      revision: cloud.revision + 1,
      configured: true,
    };
    return json(cloud);
  }) as typeof fetch;
  const resource = createUserSettingsResource("alice");
  try {
    await resource.load();
    cloud = document(1);
    cloud.settings.features.nunitoFont = false;
    const next = createDefaultUserSettings();
    next.features.edgeBinding = false;
    resource.update(next);
    assert.equal(await resource.flush(), false);
    assert.equal(resource.state.status, "conflict");
    assert.equal(resource.state.settings.features.edgeBinding, false);
    assert.equal(await resource.keepLocal(), true);
    assert.equal(resource.state.revision, 2);
    assert.equal(resource.state.settings.features.edgeBinding, false);
    error = true;
    next.debug.sampling = 2;
    resource.update(next);
    assert.equal(await resource.flush(), false);
    assert.equal(resource.state.status, "error");
    assert.equal(resource.state.settings.debug.sampling, 2);
    error = false;
    assert.equal(await resource.retry(), true);
    cloud = document(9);
    cloud.settings.features.solidFill = false;
    resource.update(next);
    assert.equal(await resource.flush(), false);
    assert.equal(resource.useCloud(), true);
    assert.equal(resource.state.revision, 9);
    assert.equal(resource.state.settings.features.solidFill, false);
    assert.equal(resource.state.status, "synced");
  } finally {
    resource.dispose();
    globalThis.fetch = original;
  }
});
test("dispose and session generation guard cancel queued saves and prevent stale responses", async () => {
  const original = globalThis.fetch;
  const loading = deferred<Response>();
  let current = true;
  let puts = 0;
  let signal: AbortSignal | undefined;
  globalThis.fetch = (async (_url, options) => {
    signal = options?.signal as AbortSignal;
    if (options?.method === "PUT") {
      puts++;
      return json(document(1));
    }
    return loading.promise;
  }) as typeof fetch;
  const resource = createUserSettingsResource("alice", () => current);
  try {
    const load = resource.load();
    resource.dispose();
    assert.equal(signal?.aborted, true);
    loading.resolve(json(document(9)));
    assert.equal(await load, false);
    assert.equal(resource.state.ready, false);
    assert.equal(resource.state.revision, 0);
    const second = createUserSettingsResource("alice", () => current);
    await second.load();
    second.update(createDefaultUserSettings());
    current = false;
    assert.equal(await second.flush(), false);
    assert.equal(puts, 0);
    second.dispose();
  } finally {
    resource.dispose();
    globalThis.fetch = original;
  }
});
