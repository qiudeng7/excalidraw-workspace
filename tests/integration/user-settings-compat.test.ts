import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { nodeStorage } from "./support/storage";
import { handleApi } from "./support/api";
import * as tables from "../../server/db/schema";
import { createDefaultUserSettings } from "../../shared/contracts";
import { createUserSettingsResource } from "../../src/lib/userSettings";

const legacySettings = (sidebar: boolean) => {
  const settings: any = createDefaultUserSettings();

  delete settings.features.bottomToolbar;
  delete settings.features.ctrlMultiSelect;
  if (!sidebar) delete settings.features.disableDefaultSidebar;

  return settings;
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));

  return { promise, resolve };
};

async function fixture(t: TestContext) {
  const directory = await mkdtemp(resolve(tmpdir(), "settings-compat-"));
  const storage = await nodeStorage(directory);

  t.after(async () => {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  });
  const request = async (
    path: string,
    method = "GET",
    data?: unknown,
    cookie?: string,
    owner?: string,
    database = storage.database,
  ) => {
    const pending: Promise<unknown>[] = [];
    const response = await handleApi(
      new Request(`https://demo.test/api${path}`, {
        method,
        headers: {
          Origin: "https://demo.test",
          "Content-Type": "application/json",
          "X-Requested-With": "excalidraw-demo",
          ...(cookie ? { Cookie: cookie } : {}),
          ...(owner ? { "X-Settings-Owner": owner } : {}),
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }),
      {
        ...storage,
        database,
        publicOrigin: "https://demo.test",
        waitUntil: (p) => pending.push(p),
      },
    );

    await Promise.all(pending);

    return {
      status: response.status,
      body: (await response.json()) as any,
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  };
  const alice = await request("/setup", "POST", {
    email: "alice@example.test",
    password: "strong-password-123",
  });

  assert.equal(alice.status, 200);

  return { storage, request, alice };
}

test("released v1 writes retain omitted flags, initialize defaults and reject malformed patches", async (t) => {
  const { request, alice } = await fixture(t);

  for (const sidebar of [false, true]) {
    const account = await request("/register", "POST", {
      email: `legacy-${sidebar}@example.test`,
      password: "strong-password-123",
    });

    assert.equal(account.status, 200);
    const legacy = legacySettings(sidebar);

    legacy.features.nunitoFont = false;
    if (sidebar) legacy.features.disableDefaultSidebar = false;
    const firstWrites = await Promise.all(
      [0, 1].map(() =>
        request(
          "/user-settings",
          "PUT",
          { settings: legacy, revision: 0 },
          account.cookie,
        ),
      ),
    );

    assert.deepEqual(
      firstWrites.map((result) => result.status).sort(),
      [200, 409],
    );
    const initial = firstWrites.find((result) => result.status === 200)!;

    assert.equal(initial.status, 200);
    assert.equal(initial.body.revision, 1);
    assert.equal(
      initial.body.settings.features.disableDefaultSidebar,
      !sidebar,
    );
    assert.equal(initial.body.settings.features.bottomToolbar, true);
    assert.equal(initial.body.settings.features.ctrlMultiSelect, true);
    assert.equal(initial.body.settings.features.nunitoFont, false);
    const modern = createDefaultUserSettings();

    modern.features.disableDefaultSidebar = false;
    modern.features.bottomToolbar = false;
    modern.features.ctrlMultiSelect = false;
    assert.equal(
      (
        await request(
          "/user-settings",
          "PUT",
          { settings: modern, revision: 1 },
          account.cookie,
        )
      ).status,
      200,
    );
    // Intermediate clients still own sidebar; original clients own neither new flag.
    if (sidebar) legacy.features.disableDefaultSidebar = true;
    const saved = await request(
      "/user-settings",
      "PUT",
      { settings: legacy, revision: 2 },
      account.cookie,
    );

    assert.equal(saved.status, 200);
    assert.equal(saved.body.revision, 3);
    assert.equal(saved.body.settings.features.disableDefaultSidebar, sidebar);
    assert.equal(saved.body.settings.features.bottomToolbar, false);
    assert.equal(saved.body.settings.features.ctrlMultiSelect, false);
    assert.equal(saved.body.settings.features.nunitoFont, false);
    assert.deepEqual(
      (await request("/user-settings", "GET", undefined, account.cookie)).body,
      saved.body,
    );
    const invalids = [
      { ...legacy, extra: true },
      { ...legacy, features: { ...legacy.features, extra: true } },
      { ...legacy, features: { ...legacy.features, edgeBinding: "false" } },
      { ...legacy, debug: { ...legacy.debug, sampling: "2" } },
      { ...legacy, debug: { sampling: 2 } },
      { ...legacy, features: { ...legacy.features, bottomToolbar: null } },
      // No released client had bottomToolbar without disableDefaultSidebar.
      {
        ...legacySettings(false),
        features: { ...legacySettings(false).features, bottomToolbar: true },
      },
      ...[
        "edgeBinding",
        "nunitoFont",
        "formalLines",
        "solidFill",
        "shortArrowheads",
      ].map((key) => {
        const missing = structuredClone(legacy);

        delete missing.features[key];

        return missing;
      }),
    ];

    for (const settings of invalids) {
      const rejected = await request(
        "/user-settings",
        "PUT",
        { settings, revision: 3 },
        account.cookie,
      );

      assert.equal(rejected.status, 400);
      assert.equal(rejected.body.error.code, "INVALID_USER_SETTINGS");
    }

    const stale = await request(
      "/user-settings",
      "PUT",
      { settings: legacy, revision: 2 },
      account.cookie,
    );

    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "USER_SETTINGS_CONFLICT");
    const wrongOwner = await request(
      "/user-settings",
      "PUT",
      { settings: legacy, revision: 0 },
      alice.cookie,
      account.body.user.id,
    );

    assert.equal(wrongOwner.status, 401);
    assert.equal(wrongOwner.body.error.code, "SESSION_CHANGED");
    assert.deepEqual(
      (await request("/user-settings", "GET", undefined, account.cookie)).body,
      saved.body,
    );
  }

  assert.equal(
    (await request("/user-settings", "GET", undefined, alice.cookie)).body
      .configured,
    false,
  );
  const isolated = await request(
    "/user-settings",
    "PUT",
    { settings: legacySettings(false), revision: 0 },
    alice.cookie,
  );

  assert.equal(isolated.status, 200);
  assert.equal(isolated.body.settings.features.disableDefaultSidebar, true);
  assert.equal(isolated.body.settings.features.bottomToolbar, true);
});

test(
  "legacy read/merge cannot overwrite a modern save racing before CAS",
  { timeout: 15000 },
  async (t) => {
    const { storage, request, alice } = await fixture(t);
    const initial = createDefaultUserSettings();

    assert.equal(
      (
        await request(
          "/user-settings",
          "PUT",
          { settings: initial, revision: 0 },
          alice.cookie,
        )
      ).status,
      200,
    );
    const reached = deferred();
    const resume = deferred();
    const heldDatabase = new Proxy(storage.database, {
      get(target, key) {
        if (key === "update")
          return (table: typeof tables.userSettings) => {
            const builder = target.update(table);

            if (table !== tables.userSettings) return builder;

            return {
              set(values: Parameters<typeof builder.set>[0]) {
                const query = builder.set(values);

                return {
                  where(condition: Parameters<typeof query.where>[0]) {
                    const filtered = query.where(condition);

                    return {
                      returning(
                        selection: Parameters<typeof filtered.returning>[0],
                      ) {
                        reached.resolve();

                        return resume.promise.then(() =>
                          filtered.returning(selection),
                        );
                      },
                    };
                  },
                };
              },
            };
          };

        const value = Reflect.get(target, key);

        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const held = request(
      "/user-settings",
      "PUT",
      { settings: legacySettings(false), revision: 1 },
      alice.cookie,
      undefined,
      heldDatabase,
    );

    try {
      await reached.promise;
      const modern = createDefaultUserSettings();

      modern.features.bottomToolbar = false;
      modern.features.ctrlMultiSelect = false;
      modern.features.disableDefaultSidebar = false;
      const winner = await request(
        "/user-settings",
        "PUT",
        { settings: modern, revision: 1 },
        alice.cookie,
      );

      assert.equal(winner.status, 200);
      resume.resolve();
      const loser = await held;

      assert.equal(loser.status, 409);
      assert.equal(loser.body.error.code, "USER_SETTINGS_CONFLICT");
      assert.deepEqual(
        (await request("/user-settings", "GET", undefined, alice.cookie)).body,
        winner.body,
      );
    } finally {
      resume.resolve();
      await held;
    }
  },
);

test("pre-deployment resources save, retry and resolve conflicts through the real upgraded backend", async (t) => {
  const { storage, request, alice } = await fixture(t);
  const originalFetch = globalThis.fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  for (const sidebar of [false, true]) {
    // Serve a historical GET to the already loaded client, then switch to current handlers.
    const cloud = (
      await request("/user-settings", "GET", undefined, alice.cookie)
    ).body;
    const legacy = legacySettings(sidebar);
    let deployed = false;
    let offline = false;
    const writes: any[] = [];

    globalThis.fetch = (async (input, options) => {
      if (!deployed) return Response.json({ ...cloud, settings: legacy });
      if (options?.method === "PUT") {
        writes.push(JSON.parse(options.body as string));
        if (offline)
          return Response.json(
            { error: { message: "offline" } },
            { status: 503 },
          );
      }

      const headers = new Headers(options?.headers);

      headers.set("Cookie", alice.cookie!);
      headers.set("Origin", "https://demo.test");

      return handleApi(
        new Request(`https://demo.test${input}`, { ...options, headers }),
        {
          ...storage,
          publicOrigin: "https://demo.test",
          waitUntil: () => {},
        },
      );
    }) as typeof fetch;
    const resource = createUserSettingsResource(alice.body.user.id);

    try {
      assert.equal(await resource.load(), true);
      deployed = true;
      legacy.features.nunitoFont = false;
      resource.update(legacy);
      offline = true;
      assert.equal(await resource.flush(), false);
      assert.equal(resource.state.status, "error");
      assert.equal(await resource.load(), false);
      offline = false;
      assert.equal(await resource.retry(), true);
      assert.equal(resource.state.status, "synced");
      assert.equal(resource.state.settings.features.nunitoFont, false);
      // Old resources keep their old local shape even when PUT returns a full document.
      assert.equal(
        Object.hasOwn(writes.at(-1).settings.features, "bottomToolbar"),
        false,
      );
      const modern = createDefaultUserSettings();

      modern.features.disableDefaultSidebar = false;
      modern.features.bottomToolbar = false;
      modern.features.ctrlMultiSelect = false;
      const winner = await request(
        "/user-settings",
        "PUT",
        { settings: modern, revision: resource.state.revision },
        alice.cookie,
      );

      assert.equal(winner.status, 200);
      legacy.debug.sampling = 2;
      resource.update(legacy);
      assert.equal(await resource.flush(), false);
      assert.equal(resource.state.status, "conflict");
      assert.equal(await resource.keepLocal(), true);
      const saved = (
        await request("/user-settings", "GET", undefined, alice.cookie)
      ).body;

      assert.equal(saved.settings.debug.sampling, 2);
      assert.equal(saved.settings.features.bottomToolbar, false);
      assert.equal(saved.settings.features.ctrlMultiSelect, false);
      assert.equal(saved.settings.features.disableDefaultSidebar, sidebar);
      assert.equal(saved.revision, winner.body.revision + 1);
    } finally {
      resource.dispose();
    }
  }
});

test("pre-Ctrl v1 payload preserves disabled Ctrl selection while malformed new flag shapes fail", async (t) => {
  const { request, alice } = await fixture(t);
  const defaults = (
    await request("/user-settings", "GET", undefined, alice.cookie)
  ).body;

  assert.equal(defaults.settings.features.ctrlMultiSelect, true);
  const settings: any = createDefaultUserSettings();

  settings.features.ctrlMultiSelect = false;
  assert.equal(
    (
      await request(
        "/user-settings",
        "PUT",
        { settings, revision: 0 },
        alice.cookie,
      )
    ).status,
    200,
  );
  const legacy = structuredClone(settings);

  delete legacy.features.ctrlMultiSelect;
  legacy.features.formalLines = false;
  const saved = await request(
    "/user-settings",
    "PUT",
    { settings: legacy, revision: 1 },
    alice.cookie,
  );

  assert.equal(saved.status, 200);
  assert.equal(saved.body.settings.features.ctrlMultiSelect, false);
  assert.equal(saved.body.settings.features.formalLines, false);
  for (const invalid of [
    { ...legacy.features, ctrlMultiSelect: "false" },
    { ...legacy.features, ctrlMultiSelect: null },
    { ...legacy.features, ctrlMultiSelect: false, unexpected: true },
    { ...legacy.features, ctrlMultiSelect: false, bottomToolbar: undefined },
    {
      ...legacy.features,
      ctrlMultiSelect: false,
      disableDefaultSidebar: undefined,
    },
  ]) {
    assert.equal(
      (
        await request(
          "/user-settings",
          "PUT",
          { settings: { ...legacy, features: invalid }, revision: 2 },
          alice.cookie,
        )
      ).status,
      400,
    );
  }

  assert.deepEqual(
    (await request("/user-settings", "GET", undefined, alice.cookie)).body,
    saved.body,
  );
});
