// 本文件覆盖管理员维护 OIDC 身份源的接口：权限、创建/更新/删除、唯一冲突、
// 图标上传与公开读取、bootstrap 只返回启用项，以及删除身份源不影响已映射账户。
// 未覆盖：登录流程本身（见 oidc-auth.test.ts）与真实对象存储驱动。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { nodeStorage } from "./support/storage";
import { handleApi } from "./support/api";
import { withDatabase } from "../lib/database";
import * as tables from "../../server/db/schema";

const adminPassword = "strong-password-123";
// 1x1 透明 PNG。
const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function fixture() {
  const directory = await mkdtemp(resolve(tmpdir(), "oidc-providers-"));
  const storage = await nodeStorage(directory);
  const raw = async (path: string, init: RequestInit = {}) => {
    const pending: Promise<unknown>[] = [];
    const response = await handleApi(
      new Request(`https://demo.test/api${path}`, {
        ...init,
        headers: {
          Origin: "https://demo.test",
          "Content-Type": "application/json",
          "X-Requested-With": "excalidraw-demo",
          ...(init.headers as Record<string, string>),
        },
      }),
      {
        ...storage,
        publicOrigin: "https://demo.test",
        waitUntil: (p) => pending.push(p),
      },
    );

    await Promise.all(pending);

    return response;
  };
  const call = async (
    path: string,
    method = "GET",
    data?: unknown,
    cookie?: string,
  ) => {
    const response = await raw(path, {
      method,
      ...(cookie ? { headers: { Cookie: cookie } } : {}),
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const text = await response.text();

    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  };

  return {
    storage,
    raw,
    call,
    async close() {
      storage.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

let sequence = 0;

function providerInput(overrides: Record<string, unknown> = {}) {
  sequence += 1;

  return {
    id: crypto.randomUUID(),
    type: "custom",
    name: `身份源 ${sequence}`,
    issuer: `https://idp-${sequence}.example.com`,
    clientId: `client-${sequence}`,
    clientSecret: `secret-${sequence}`,
    enabled: true,
    autoRegister: true,
    ...overrides,
  };
}

async function signIn(f: Fixture) {
  const setup = await f.call("/setup", "POST", {
    email: "admin@example.com",
    password: adminPassword,
  });
  const member = await f.call("/register", "POST", {
    email: "member@example.com",
    password: adminPassword,
  });

  assert.equal(setup.status, 200);
  assert.equal(member.status, 200);

  return { admin: setup.cookie!, member: member.cookie! };
}

test("身份源管理接口仅管理员可用", async () => {
  const f = await fixture();

  try {
    const { admin, member } = await signIn(f);

    assert.equal((await f.call("/admin/oidc-providers")).status, 401);
    for (const [path, method] of [
      ["/admin/oidc-providers", "GET"],
      ["/admin/oidc-providers", "POST"],
      [`/admin/oidc-providers/${crypto.randomUUID()}`, "PATCH"],
      [`/admin/oidc-providers/${crypto.randomUUID()}`, "DELETE"],
    ] as const) {
      const response = await f.call(
        path,
        method,
        method === "GET" ? undefined : providerInput(),
        member,
      );

      assert.equal(response.status, 403, `${method} ${path}`);
      assert.equal(response.body.error.code, "FORBIDDEN");
    }

    const listed = await f.call(
      "/admin/oidc-providers",
      "GET",
      undefined,
      admin,
    );

    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body, { providers: [] });
  } finally {
    await f.close();
  }
});

test("创建、更新、删除身份源，重复的 (type, issuer, client_id) 被拒绝", async () => {
  const f = await fixture();

  try {
    const { admin } = await signIn(f);
    const input = providerInput({ type: "custom", autoRegister: false });
    const created = await f.call("/admin/oidc-providers", "POST", input, admin);

    assert.equal(created.status, 201);
    assert.equal(created.body.provider.id, input.id);
    assert.equal(created.body.provider.scopes, "openid profile email");
    assert.equal(created.body.provider.autoRegister, false);
    assert.equal(created.body.provider.enabled, true);
    assert.equal(
      created.body.provider.clientSecret,
      input.clientSecret,
      "列表与详情按约定返回明文密钥",
    );
    // custom 类型在未上传图标前没有图标地址。
    assert.equal(created.body.provider.iconUrl, null);

    const duplicate = await f.call(
      "/admin/oidc-providers",
      "POST",
      { ...input, id: crypto.randomUUID() },
      admin,
    );

    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, "OIDC_PROVIDER_EXISTS");

    const updated = await f.call(
      `/admin/oidc-providers/${input.id}`,
      "PATCH",
      { name: "改名后的身份源", enabled: false },
      admin,
    );

    assert.equal(updated.status, 200);
    assert.equal(updated.body.provider.name, "改名后的身份源");
    assert.equal(updated.body.provider.enabled, false);
    assert.equal(updated.body.provider.issuer, input.issuer);
    const listed = await f.call(
      "/admin/oidc-providers",
      "GET",
      undefined,
      admin,
    );

    assert.equal(listed.body.providers.length, 1);
    assert.equal(listed.body.providers[0].enabled, false);

    for (const invalid of [
      { issuer: "not-a-url" },
      { issuer: "ftp://idp.example.com" },
      { clientSecret: "" },
      { scopes: "profile email" },
      { type: "github" },
      { id: "not-a-uuid" },
    ]) {
      const response = await f.call(
        "/admin/oidc-providers",
        "POST",
        providerInput(invalid),
        admin,
      );

      assert.equal(response.status, 400, JSON.stringify(invalid));
    }

    const changedType = await f.call(
      `/admin/oidc-providers/${input.id}`,
      "PATCH",
      { type: "google" },
      admin,
    );

    assert.equal(changedType.status, 400);
    const missing = await f.call(
      `/admin/oidc-providers/${crypto.randomUUID()}`,
      "DELETE",
      undefined,
      admin,
    );

    assert.equal(missing.status, 404);
    assert.equal(
      (
        await f.call(
          `/admin/oidc-providers/${input.id}`,
          "DELETE",
          undefined,
          admin,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await f.call(
          `/admin/oidc-providers/${input.id}`,
          "DELETE",
          undefined,
          admin,
        )
      ).status,
      404,
    );
  } finally {
    await f.close();
  }
});

test("上传图标后公开读取，非图片或超大图标被拒绝", async () => {
  const f = await fixture();

  try {
    const { admin } = await signIn(f);
    const input = providerInput();
    const created = await f.call("/admin/oidc-providers", "POST", input, admin);

    assert.equal(created.status, 201);
    const uploaded = await f.call(
      `/admin/oidc-providers/${input.id}/icon`,
      "PUT",
      { dataUrl: png },
      admin,
    );

    assert.equal(uploaded.status, 200);
    assert.equal(
      uploaded.body.provider.iconUrl,
      `/api/auth/oidc/${input.id}/icon`,
    );
    const icon = await f.raw(`/auth/oidc/${input.id}/icon`);

    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get("content-type"), "image/png");
    assert.match(icon.headers.get("content-security-policy")!, /sandbox/);
    assert.equal(
      Buffer.from(await icon.arrayBuffer()).toString("base64"),
      png.split(",")[1],
    );
    assert.equal(
      (await f.raw(`/auth/oidc/${crypto.randomUUID()}/icon`)).status,
      404,
    );

    for (const [dataUrl, status] of [
      ["data:image/gif;base64,R0lGODlhAQABAAAAACw=", 400],
      [`data:image/png;base64,${"A".repeat(400_000)}`, 400],
    ] as const) {
      const response = await f.call(
        `/admin/oidc-providers/${input.id}/icon`,
        "PUT",
        { dataUrl },
        admin,
      );

      assert.equal(response.status, status);
    }

    const preset = providerInput({ type: "google", name: "Google" });
    const presetCreated = await f.call(
      "/admin/oidc-providers",
      "POST",
      preset,
      admin,
    );

    assert.equal(presetCreated.body.provider.iconUrl, "/oidc/google.svg");
    assert.equal(
      (
        await f.call(
          `/admin/oidc-providers/${preset.id}/icon`,
          "PUT",
          { dataUrl: png },
          admin,
        )
      ).status,
      400,
    );
  } finally {
    await f.close();
  }
});

test("删除身份源保留已映射账户，bootstrap 只返回启用项", async () => {
  const f = await fixture();

  try {
    const { admin } = await signIn(f);
    const enabled = await f.call(
      "/admin/oidc-providers",
      "POST",
      providerInput({ type: "gitlab", name: "团队 GitLab" }),
      admin,
    );
    const disabled = await f.call(
      "/admin/oidc-providers",
      "POST",
      providerInput({ type: "google", name: "停用的 Google", enabled: false }),
      admin,
    );

    assert.equal(enabled.status, 201);
    assert.equal(disabled.status, 201);
    const bootstrap = await (await f.raw("/bootstrap")).json();

    assert.deepEqual(bootstrap.authMethods, {
      local: true,
      oidc: [
        {
          id: enabled.body.provider.id,
          type: "gitlab",
          name: "团队 GitLab",
          iconUrl: "/oidc/gitlab.svg",
        },
      ],
    });
    const issuer = enabled.body.provider.issuer;
    const mapped = {
      id: crypto.randomUUID(),
      email: "mapped@example.com",
      name: "已映射用户",
      role: "user" as const,
      passwordHash: "!oidc",
      createdAt: new Date().toISOString(),
      provider: "oidc" as const,
      issuer,
      subject: "member",
    };

    await withDatabase(f.storage.database, () =>
      f.storage.database.insert(tables.users).values(mapped),
    );
    assert.equal(
      (
        await f.call(
          `/admin/oidc-providers/${enabled.body.provider.id}`,
          "DELETE",
          undefined,
          admin,
        )
      ).status,
      200,
    );
    const users = await withDatabase(f.storage.database, () =>
      f.storage.database.select().from(tables.users),
    );

    assert.ok(users.some((user) => user.id === mapped.id));
    assert.deepEqual(
      (await (await f.raw("/bootstrap")).json()).authMethods.oidc,
      [],
    );
  } finally {
    await f.close();
  }
});
