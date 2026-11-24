// 本文件以本地密钥模拟多个 OIDC 身份源，覆盖按身份源的授权码登录：
// discovery 按 issuer 区分、providerId 与流程 Cookie 核对、微软多租户 iss 展开、
// auto_register=false、未启用身份源拒绝与 bootstrap 只返回启用项。
// 未覆盖：真实 IdP 网络行为、图标上传与管理接口权限（见 oidc-providers.test.ts）。
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { nodeStorage } from "./support/storage";
import { handleApi } from "./support/api";
import { withDatabase } from "../lib/database";
import * as tables from "../../server/db/schema";

const savedEnv = { ...process.env };
const savedFetch = globalThis.fetch;
const microsoftIssuer = "https://login.microsoftonline.com/common/v2.0";
const microsoftDiscoveryIssuer =
  "https://login.microsoftonline.com/{tenantid}/v2.0";
const microsoftTenant = "8eaef023-2b34-4be6-b8ac-7e1e7f6b9d21";
const tenantIssuer = `https://login.microsoftonline.com/${microsoftTenant}/v2.0`;
// 同一进程里 discovery 与 JWKS 按 URL 缓存，跨用例共享一套密钥才能复用缓存。
const keyPair = generateKeyPair("ES256");
let sequence = 0;

beforeEach(() => {
  process.env.AUTH_LOCAL = "true";
});

afterEach(() => {
  for (const key of Object.keys(process.env))
    if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  globalThis.fetch = savedFetch;
});

function uniqueIssuer() {
  sequence += 1;

  return `https://idp-${sequence}.test`;
}

type ProviderRow = typeof tables.oidcProviders.$inferInsert & { id: string };

function providerRow(
  issuer: string,
  overrides: Partial<ProviderRow> = {},
): ProviderRow {
  const now = new Date().toISOString();

  return {
    id: crypto.randomUUID(),
    type: "gitlab",
    name: "GitLab",
    issuer,
    clientId: "client",
    clientSecret: "secret",
    scopes: "openid profile email",
    icon: null,
    enabled: true,
    autoRegister: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function fixture() {
  const directory = await mkdtemp(resolve(tmpdir(), "oidc-auth-"));
  const storage = await nodeStorage(directory);
  const request = async (
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const pending: Promise<unknown>[] = [];
    const response = await handleApi(
      new Request(`https://demo.test/api${path}`, {
        ...init,
        redirect: "manual",
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
  const run = <T>(work: () => Promise<T>) =>
    withDatabase(storage.database, work);
  const seed = (row: ProviderRow) =>
    run(() => storage.database.insert(tables.oidcProviders).values(row));
  const users = () => run(() => storage.database.select().from(tables.users));

  return {
    storage,
    request,
    run,
    seed,
    users,
    async close() {
      storage.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

interface IdpEntry {
  issuer: string;
  audience: string;
  discoveryIssuer?: string;
}

async function mockIdp() {
  const { publicKey, privateKey } = await keyPair;
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: "k1",
    alg: "ES256",
    use: "sig",
  };
  const entries = new Map<string, IdpEntry>();
  const tokens = new Map<string, string>();

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);

    for (const entry of entries.values()) {
      if (url === `${entry.issuer}/.well-known/openid-configuration`)
        return Response.json({
          issuer: entry.discoveryIssuer ?? entry.issuer,
          authorization_endpoint: `${entry.issuer}/authorize`,
          token_endpoint: `${entry.issuer}/token`,
          jwks_uri: `${entry.issuer}/jwks`,
        });
      if (url === `${entry.issuer}/token`)
        return Response.json({ id_token: tokens.get(entry.issuer) ?? "" });
      if (url === `${entry.issuer}/jwks`) return Response.json({ keys: [jwk] });
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return {
    register(entry: IdpEntry) {
      entries.set(entry.issuer, entry);
    },
    async sign(
      issuer: string,
      claims: Record<string, unknown>,
      options: { issuer?: string; audience?: string } = {},
    ) {
      const entry = entries.get(issuer);

      if (!entry) throw new Error(`未注册的身份源 ${issuer}`);
      const token = await new SignJWT(claims)
        .setProtectedHeader({ alg: "ES256", kid: "k1" })
        .setIssuer(options.issuer ?? entry.issuer)
        .setAudience(options.audience ?? entry.audience)
        .setExpirationTime("5m")
        .sign(privateKey);

      tokens.set(issuer, token);

      return token;
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

type Idp = Awaited<ReturnType<typeof mockIdp>>;

async function begin(f: Fixture, providerId: string) {
  const response = await f.request(`/auth/oidc/${providerId}/start`);
  const location = new URL(response.headers.get("location")!);
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;

  return {
    response,
    location,
    cookie,
    state: location.searchParams.get("state")!,
  };
}

async function complete(
  f: Fixture,
  idp: Idp,
  provider: ProviderRow,
  claims: Record<string, unknown>,
  options: { issuer?: string; audience?: string } = {},
) {
  const flow = await begin(f, provider.id);

  await idp.sign(
    provider.issuer,
    {
      sub: "user-1",
      ...claims,
      nonce: flow.location.searchParams.get("nonce"),
    },
    options,
  );
  const callback = await f.request(
    `/auth/oidc/${provider.id}/callback?code=abc&state=${flow.state}`,
    { headers: { Cookie: flow.cookie } },
  );

  return { flow, callback };
}

function sessionCookie(response: Response) {
  return response.headers
    .getSetCookie()
    .find((value) => value.startsWith("excalidraw_session="))
    ?.split(";")[0];
}

async function currentUser(f: Fixture, session: string) {
  return (
    await (await f.request("/session", { headers: { Cookie: session } })).json()
  ).user as { id: string; email: string; role: string };
}

test("两个身份源可以分别登录，账户按实际 issuer 映射且一律是普通用户", async () => {
  const idp = await mockIdp();
  const f = await fixture();
  const gitlabIssuer = uniqueIssuer();

  try {
    const gitlab = providerRow(gitlabIssuer, { name: "公司 GitLab" });
    const microsoft = providerRow(microsoftIssuer, {
      type: "microsoft",
      name: "Microsoft",
    });

    await f.seed(gitlab);
    await f.seed(microsoft);
    idp.register({ issuer: gitlabIssuer, audience: "client" });
    idp.register({
      issuer: microsoftIssuer,
      audience: "client",
      discoveryIssuer: microsoftDiscoveryIssuer,
    });

    const first = await complete(f, idp, gitlab, {
      sub: "gitlab-user",
      email: "GitLab.User@Example.com",
      name: "GitLab 用户",
    });

    assert.equal(first.callback.status, 302);
    assert.equal(first.callback.headers.get("location"), "/");
    const firstSession = sessionCookie(first.callback);

    assert.ok(firstSession, "身份源登录后写入会话 Cookie");
    const firstUser = await currentUser(f, firstSession);

    assert.equal(firstUser.email, "gitlab.user@example.com");
    assert.equal(firstUser.role, "user");

    const second = await complete(
      f,
      idp,
      microsoft,
      { sub: "microsoft-user", email: "ms@example.com", tid: microsoftTenant },
      { issuer: tenantIssuer },
    );

    assert.equal(second.callback.headers.get("location"), "/");
    const secondSession = sessionCookie(second.callback);

    assert.ok(secondSession);
    const secondUser = await currentUser(f, secondSession);

    assert.equal(secondUser.email, "ms@example.com");
    assert.equal(secondUser.role, "user");
    const rows = await f.users();

    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => [row.provider, row.issuer, row.role]),
      [
        ["oidc", gitlabIssuer, "user"],
        // 微软账户记录 id_token 的实际租户 issuer，而不是配置的 common。
        ["oidc", tenantIssuer, "user"],
      ],
    );
    assert.ok(rows.every((row) => row.passwordHash === "!oidc"));
    // 没有任何 OIDC 账户会自动成为管理员。
    assert.equal(
      (await (await f.request("/bootstrap")).json()).needsSetup,
      true,
    );
  } finally {
    await f.close();
  }
});

test("未启用或不存在的身份源拒绝发起登录", async () => {
  const f = await fixture();

  try {
    const disabled = providerRow(uniqueIssuer(), { enabled: false });

    await f.seed(disabled);
    for (const id of [disabled.id, crypto.randomUUID()]) {
      const start = await f.request(`/auth/oidc/${id}/start`);

      assert.equal(start.status, 302);
      assert.equal(start.headers.get("location"), "/?authError=oidc_disabled");
      assert.equal(sessionCookie(start), undefined);
      const callback = await f.request(`/auth/oidc/${id}/callback?code=1`);

      assert.equal(
        callback.headers.get("location"),
        "/?authError=oidc_disabled",
      );
    }

    assert.equal((await f.users()).length, 0);
  } finally {
    await f.close();
  }
});

test("auto_register=false 且无映射账户时回到登录页，已映射账户仍可登录", async () => {
  const idp = await mockIdp();
  const f = await fixture();
  const issuer = uniqueIssuer();

  try {
    const provider = providerRow(issuer, { autoRegister: false });

    await f.seed(provider);
    idp.register({ issuer, audience: "client" });
    const denied = await complete(f, idp, provider, {
      sub: "stranger",
      email: "stranger@example.com",
    });

    assert.equal(denied.callback.status, 302);
    assert.equal(
      denied.callback.headers.get("location"),
      "/?authError=oidc_not_registered",
    );
    assert.equal(sessionCookie(denied.callback), undefined);
    assert.equal((await f.users()).length, 0);

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

    await f.run(() => f.storage.database.insert(tables.users).values(mapped));
    const allowed = await complete(f, idp, provider, {
      sub: "member",
      email: "ignored@example.com",
    });

    assert.equal(allowed.callback.headers.get("location"), "/");
    const session = sessionCookie(allowed.callback);

    assert.ok(session);
    assert.equal((await currentUser(f, session)).id, mapped.id);
    assert.equal((await f.users()).length, 1);
  } finally {
    await f.close();
  }
});

test("流程 Cookie 与回调的 providerId 不一致时按 state 错误拒绝", async () => {
  const idp = await mockIdp();
  const f = await fixture();
  const firstIssuer = uniqueIssuer();
  const secondIssuer = uniqueIssuer();

  try {
    const first = providerRow(firstIssuer, { name: "第一个" });
    const second = providerRow(secondIssuer, { name: "第二个" });

    await f.seed(first);
    await f.seed(second);
    idp.register({ issuer: firstIssuer, audience: "client" });
    idp.register({ issuer: secondIssuer, audience: "client" });
    const flow = await begin(f, first.id);

    await idp.sign(firstIssuer, {
      sub: "user-1",
      nonce: flow.location.searchParams.get("nonce"),
    });
    const callback = await f.request(
      `/auth/oidc/${second.id}/callback?code=abc&state=${flow.state}`,
      { headers: { Cookie: flow.cookie } },
    );

    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("location"), "/?authError=oidc_state");
    assert.equal(sessionCookie(callback), undefined);
    assert.equal((await f.users()).length, 0);
  } finally {
    await f.close();
  }
});

test("微软多租户 iss 必须等于 tid 展开值，严格类型按配置 issuer 校验", async () => {
  const idp = await mockIdp();
  const f = await fixture();
  const strictIssuer = uniqueIssuer();

  try {
    const microsoft = providerRow(microsoftIssuer, { type: "microsoft" });
    const strict = providerRow(strictIssuer, {
      type: "google",
      name: "Google",
    });

    await f.seed(microsoft);
    await f.seed(strict);
    idp.register({
      issuer: microsoftIssuer,
      audience: "client",
      discoveryIssuer: microsoftDiscoveryIssuer,
    });
    idp.register({ issuer: strictIssuer, audience: "client" });

    const wrongTenant = await complete(
      f,
      idp,
      microsoft,
      { sub: "x", tid: microsoftTenant },
      { issuer: "https://login.microsoftonline.com/other-tenant/v2.0" },
    );

    assert.equal(
      wrongTenant.callback.headers.get("location"),
      "/?authError=oidc_invalid_token",
    );
    const missingTenant = await complete(
      f,
      idp,
      microsoft,
      { sub: "x" },
      { issuer: tenantIssuer },
    );

    assert.equal(
      missingTenant.callback.headers.get("location"),
      "/?authError=oidc_invalid_token",
    );
    const otherIssuer = await complete(
      f,
      idp,
      strict,
      { sub: "x" },
      { issuer: "https://evil.test" },
    );

    assert.equal(
      otherIssuer.callback.headers.get("location"),
      "/?authError=oidc_invalid_token",
    );
    const wrongAudience = await complete(
      f,
      idp,
      strict,
      { sub: "x" },
      { audience: "someone-else" },
    );

    assert.equal(
      wrongAudience.callback.headers.get("location"),
      "/?authError=oidc_invalid_token",
    );

    const flow = await begin(f, strict.id);

    await idp.sign(strictIssuer, {
      sub: "x",
      nonce: "wrong-nonce",
    });
    const wrongNonce = await f.request(
      `/auth/oidc/${strict.id}/callback?code=abc&state=${flow.state}`,
      { headers: { Cookie: flow.cookie } },
    );

    assert.equal(
      wrongNonce.headers.get("location"),
      "/?authError=oidc_invalid_token",
    );
    assert.equal((await f.users()).length, 0);
  } finally {
    await f.close();
  }
});

test("关闭本地账号后仍可用启用身份源登录，bootstrap 只返回启用项", async () => {
  const idp = await mockIdp();
  const f = await fixture();
  const enabledIssuer = uniqueIssuer();
  const disabledIssuer = uniqueIssuer();

  process.env.AUTH_LOCAL = "false";

  try {
    const enabled = providerRow(enabledIssuer, {
      type: "gitlab",
      name: "团队 GitLab",
    });
    const disabled = providerRow(disabledIssuer, {
      type: "google",
      name: "停用的 Google",
      enabled: false,
    });

    await f.seed(enabled);
    await f.seed(disabled);
    idp.register({ issuer: enabledIssuer, audience: "client" });
    const bootstrap = await (await f.request("/bootstrap")).json();

    assert.deepEqual(bootstrap.authMethods, {
      local: false,
      oidc: [
        {
          id: enabled.id,
          type: "gitlab",
          name: "团队 GitLab",
          // 预设类型使用前端内置图标路径。
          iconUrl: "/oidc/gitlab.svg",
        },
      ],
    });
    assert.equal(
      (
        await f.request("/login", {
          method: "POST",
          body: JSON.stringify({
            email: "a@b.co",
            password: "long-enough-password",
          }),
        })
      ).status,
      403,
    );
    const { callback } = await complete(f, idp, enabled, {
      sub: "member",
      email: "member@example.com",
    });

    assert.equal(callback.headers.get("location"), "/");
    const session = sessionCookie(callback);

    assert.ok(session);
    assert.equal((await currentUser(f, session)).email, "member@example.com");
  } finally {
    await f.close();
  }
});
