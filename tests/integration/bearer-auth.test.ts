// 本文件以本地 RSA 密钥模拟裕昇 Identity，覆盖跨 App Bearer 认证的真实 HTTP 路径：
// 身份源按 issuer 选择、JWKS 验签、aud 与 scope 约束、本地账号映射、读写权限区分，
// 以及 CORS 预检/响应头与 RFC 9728 资源元数据。
// 未覆盖：真实 Identity 服务、WebSocket 协作房间与浏览器内嵌宿主。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createApp, createRouter, defineEventHandler, toWebHandler } from "h3";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { nodeStorage } from "./support/storage";
import { handleApi } from "./support/api";
import { withDatabase } from "../lib/database";
import * as tables from "../../server/db/schema";
import metadata from "../../server/routes/.well-known/oauth-protected-resource.get";

const origin = "https://demo.test";
const readScope = "excalidraw:canvas.read";
const writeScope = "excalidraw:canvas.write";
const savedFetch = globalThis.fetch;
const savedEnv = { ...process.env };
const keyPair = generateKeyPair("RS256");
let sequence = 0;
let issuers: string[] = [];

function uniqueIssuer() {
  sequence += 1;
  const issuer = `https://identity-${sequence}.test`;

  issuers.push(issuer);

  return issuer;
}

afterEach(() => {
  globalThis.fetch = savedFetch;
  for (const key of Object.keys(process.env))
    if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  issuers = [];
});

/** Serve discovery and JWKS for every registered issuer; nothing else is fetched. */
async function mockIdentity(entries: string[]) {
  const { publicKey, privateKey } = await keyPair;
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: "bearer-key",
    alg: "RS256",
    use: "sig",
  };
  const known = new Set(entries);

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);

    for (const issuer of known) {
      if (url === `${issuer}/.well-known/openid-configuration`)
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
        });
      if (url === `${issuer}/jwks`) return Response.json({ keys: [jwk] });
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return {
    sign(
      issuer: string,
      claims: Record<string, unknown>,
      audience: string | string[] = origin,
    ) {
      return new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "bearer-key" })
        .setIssuer(issuer)
        .setAudience(audience)
        .setExpirationTime("5m")
        .sign(privateKey);
    },
  };
}

async function fixture(options: { corsOrigins?: string } = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), "bearer-auth-"));
  const storage = await nodeStorage(directory);
  const request = async (path: string, init: RequestInit = {}) => {
    const pending: Promise<unknown>[] = [];
    const response = await handleApi(
      new Request(`${origin}/api${path}`, {
        ...init,
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "X-Requested-With": "excalidraw-demo",
          ...(init.headers as Record<string, string>),
        },
      }),
      {
        ...storage,
        publicOrigin: origin,
        corsOrigins: options.corsOrigins,
        waitUntil: (promise) => pending.push(promise),
      },
    );

    await Promise.all(pending);

    return response;
  };
  const run = <T>(work: () => Promise<T>) =>
    withDatabase(storage.database, work);
  const seed = (issuer: string, enabled = true) =>
    run(() =>
      storage.database.insert(tables.oidcProviders).values({
        id: crypto.randomUUID(),
        type: "custom",
        name: "裕昇 Identity",
        issuer,
        clientId: "excalidraw",
        clientSecret: "secret",
        scopes: "openid profile email",
        icon: null,
        enabled,
        autoRegister: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
  const users = () => run(() => storage.database.select().from(tables.users));

  return {
    request,
    seed,
    users,
    async close() {
      storage.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function sessionUser(
  f: Awaited<ReturnType<typeof fixture>>,
  token: string,
) {
  const response = await f.request("/session", {
    headers: { Authorization: `Bearer ${token}` },
  });

  assert.equal(response.status, 200);

  return (await response.json()).user;
}

test("有效读令牌按 (iss, sub) 映射到本地账号", async () => {
  const issuer = uniqueIssuer();
  const idp = await mockIdentity([issuer]);
  const f = await fixture();

  try {
    await f.seed(issuer);
    const token = await idp.sign(issuer, {
      sub: "user-1",
      email: "bearer@example.test",
      name: "Bearer 用户",
      scope: readScope,
    });
    const user = await sessionUser(f, token);

    assert.equal(user.email, "bearer@example.test");
    assert.equal(user.name, "Bearer 用户");
    assert.equal(user.role, "user");
    const rows = await f.users();

    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.provider, "oidc");
    assert.equal(rows[0]!.issuer, issuer);
    assert.equal(rows[0]!.subject, "user-1");
    // 同一身份再次访问复用同一账号。
    assert.equal((await sessionUser(f, token)).id, user.id);
    assert.equal((await f.users()).length, 1);
  } finally {
    await f.close();
  }
});

test("受众、scope 或身份源不匹配的令牌不解析为账号", async () => {
  const issuer = uniqueIssuer();
  const otherIssuer = uniqueIssuer();
  const idp = await mockIdentity([issuer, otherIssuer]);
  const f = await fixture();

  try {
    await f.seed(issuer);
    await f.seed(otherIssuer, false);
    const cases = {
      受众指向其他应用: await idp.sign(
        issuer,
        { sub: "user-2", email: "a@example.test", scope: readScope },
        "https://another-app.test",
      ),
      缺少画布读权限: await idp.sign(issuer, {
        sub: "user-3",
        email: "b@example.test",
        scope: "openid profile",
      }),
      身份源已停用: await idp.sign(otherIssuer, {
        sub: "user-4",
        email: "c@example.test",
        scope: readScope,
      }),
    };

    for (const [name, token] of Object.entries(cases)) {
      const response = await f.request("/session", {
        headers: { Authorization: `Bearer ${token}` },
      });

      assert.equal(response.status, 200, name);
      assert.equal((await response.json()).user, null, name);
    }

    assert.equal((await f.users()).length, 0);
  } finally {
    await f.close();
  }
});

test("只有读权限的令牌不能调用写接口", async () => {
  const issuer = uniqueIssuer();
  const idp = await mockIdentity([issuer]);
  const f = await fixture();

  try {
    await f.seed(issuer);
    const readToken = await idp.sign(issuer, {
      sub: "user-5",
      email: "read@example.test",
      scope: readScope,
    });
    const writeToken = await idp.sign(issuer, {
      sub: "user-5",
      email: "read@example.test",
      scope: `${readScope} ${writeScope}`,
    });
    const denied = await f.request("/canvases/missing-canvas", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${readToken}` },
    });

    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).error.code, "UNAUTHENTICATED");
    const allowed = await f.request("/canvases/missing-canvas", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${writeToken}` },
    });

    // 认证通过，失败原因来自资源不存在而不是身份。
    assert.notEqual(allowed.status, 401);
  } finally {
    await f.close();
  }
});

test("白名单来源获得 CORS 预检响应，其他来源不获得", async () => {
  const f = await fixture({ corsOrigins: "https://workbench.test" });

  try {
    const preflight = await f.request("/session", {
      method: "OPTIONS",
      headers: {
        Origin: "https://workbench.test",
        "Access-Control-Request-Method": "GET",
      },
    });

    assert.equal(preflight.status, 204);
    assert.equal(
      preflight.headers.get("access-control-allow-origin"),
      "https://workbench.test",
    );
    assert.match(
      preflight.headers.get("access-control-allow-headers") ?? "",
      /Authorization/,
    );
    const echoed = await f.request("/session", {
      method: "OPTIONS",
      headers: {
        Origin: "https://workbench.test",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "if-none-match, x-brand-new",
      },
    });

    assert.equal(
      echoed.headers.get("access-control-allow-headers"),
      "if-none-match, x-brand-new",
    );
    const blocked = await f.request("/session", {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.test",
        "Access-Control-Request-Method": "GET",
      },
    });

    assert.equal(blocked.headers.get("access-control-allow-origin"), null);
    const crossOriginWrite = await f.request("/logout", {
      method: "POST",
      headers: { Origin: "https://evil.test" },
    });

    assert.equal(crossOriginWrite.status, 403);
  } finally {
    await f.close();
  }
});

test("资源元数据声明本部署标识、Identity 与画布 scope", async () => {
  const app = createApp();

  app.use(
    defineEventHandler((event) => {
      event.context.nitro = { runtimeConfig: { publicOrigin: origin } };
    }),
  );
  const router = createRouter();

  router.get("/.well-known/oauth-protected-resource", metadata);
  app.use(router);
  const response = await toWebHandler(app)(
    new Request(`${origin}/.well-known/oauth-protected-resource`),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.resource, origin);
  assert.deepEqual(body.authorization_servers, [
    "https://identity.chongqing-yusheng.cn",
  ]);
  assert.deepEqual(body.scopes_supported, [readScope, writeScope]);
  assert.deepEqual(body.bearer_methods_supported, ["header"]);
});
