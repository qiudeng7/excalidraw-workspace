import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { nodeStorage } from "./support/storage";
import { handleApi } from "./support/api";
import { withDatabase } from "../lib/database";
import * as tables from "../../server/db/schema";
import { findOrCreateOidcUser } from "../../server/utils/oidc-accounts";

const issuer = "https://idp.test";
const savedEnv = { ...process.env };
const savedFetch = globalThis.fetch;

beforeEach(() => {
  Object.assign(process.env, {
    AUTH_LOCAL: "true",
    AUTH_OIDC: "true",
    OIDC_ISSUER: issuer,
    OIDC_CLIENT_ID: "client",
    OIDC_CLIENT_SECRET: "secret",
  });
});

afterEach(() => {
  for (const key of Object.keys(process.env))
    if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  globalThis.fetch = savedFetch;
});

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

  return {
    storage,
    request,
    users: () =>
      withDatabase(storage.database, () =>
        storage.database.select().from(tables.users),
      ),
    async close() {
      storage.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("claims map to users by (issuer, sub); first becomes admin; email clashes get a suffix", async () => {
  const f = await fixture();

  try {
    const run = <T>(work: () => Promise<T>) =>
      withDatabase(f.storage.database, work);
    const first = await run(() =>
      findOrCreateOidcUser(issuer, {
        sub: "a",
        email: "Ann@Example.com",
        name: "Ann",
      }),
    );
    const again = await run(() =>
      findOrCreateOidcUser(issuer, { sub: "a", email: "other@example.com" }),
    );
    const second = await run(() =>
      findOrCreateOidcUser(issuer, { sub: "b", email: "ann@example.com" }),
    );
    const otherIdp = await run(() =>
      findOrCreateOidcUser("https://other.test", { sub: "a" }),
    );

    assert.equal(first.role, "admin");
    assert.equal(first.email, "ann@example.com");
    assert.equal(again.id, first.id);
    assert.equal(second.role, "user");
    assert.match(second.email, /^ann\+oidc-[0-9a-f]{8}@example\.com$/);
    assert.notEqual(
      otherIdp.id,
      first.id,
      "same sub at another issuer is a different user",
    );
    assert.match(otherIdp.email, /@oidc\.invalid$/);
    const rows = await f.users();

    assert.equal(rows.length, 3);
    assert.ok(
      rows.every(
        (row) => row.provider === "oidc" && row.passwordHash === "!oidc",
      ),
    );
  } finally {
    await f.close();
  }
});

test("AUTH_LOCAL=false rejects local account endpoints and bootstrap reports methods", async () => {
  process.env.AUTH_LOCAL = "false";
  const f = await fixture();

  try {
    const credentials = { email: "a@b.co", password: "long-enough-password" };

    for (const [path, method] of [
      ["/login", "POST"],
      ["/register", "POST"],
      ["/setup", "POST"],
    ] as const) {
      const response = await f.request(path, {
        method,
        body: JSON.stringify(credentials),
      });

      assert.equal(response.status, 403, path);
      assert.equal((await response.json()).error.code, "AUTH_METHOD_DISABLED");
    }

    const bootstrap = await (await f.request("/bootstrap")).json();

    assert.deepEqual(bootstrap.authMethods, { local: false, oidc: true });
    assert.equal((await f.users()).length, 0);
  } finally {
    await f.close();
  }
});

test("invalid configuration returns CONFIGURATION_INVALID instead of degrading", async () => {
  process.env.AUTH_LOCAL = "false";
  process.env.AUTH_OIDC = "false";
  const f = await fixture();

  try {
    const response = await f.request("/bootstrap");

    assert.equal(response.status, 500);
    assert.equal((await response.json()).error.code, "CONFIGURATION_INVALID");
  } finally {
    await f.close();
  }
});

async function idp() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: "k1",
    alg: "ES256",
    use: "sig",
  };
  const sign = (claims: Record<string, unknown>, audience = "client") =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256", kid: "k1" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setExpirationTime("5m")
      .sign(privateKey);
  let idToken = "";

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.endsWith("/.well-known/openid-configuration"))
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      });
    if (url === `${issuer}/token`) return Response.json({ id_token: idToken });
    if (url === `${issuer}/jwks`) return Response.json({ keys: [jwk] });

    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return { sign, setToken: (token: string) => (idToken = token) };
}

async function begin(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await f.request("/auth/oidc/start");
  const location = new URL(response.headers.get("location")!);
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;

  return {
    response,
    location,
    cookie,
    state: location.searchParams.get("state")!,
  };
}

test("authorization code flow with PKCE creates a cookie session", async () => {
  const provider = await idp();
  const f = await fixture();

  try {
    const { response, location, cookie, state } = await begin(f);

    assert.equal(response.status, 302);
    assert.equal(location.origin + location.pathname, `${issuer}/authorize`);
    assert.equal(location.searchParams.get("code_challenge_method"), "S256");
    assert.equal(
      location.searchParams.get("redirect_uri"),
      "https://demo.test/api/auth/oidc/callback",
    );
    assert.match(response.headers.get("set-cookie")!, /HttpOnly/);
    provider.setToken(
      await provider.sign({
        sub: "u1",
        email: "u1@example.com",
        nonce: location.searchParams.get("nonce"),
      }),
    );
    const callback = await f.request(
      `/auth/oidc/callback?code=abc&state=${state}`,
      {
        headers: { Cookie: cookie },
      },
    );

    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("location"), "/");
    const cookies = callback.headers.getSetCookie();
    const session = cookies.find((value) =>
      value.startsWith("excalidraw_session="),
    )!;

    assert.ok(session, "session cookie issued");
    const current = await (
      await f.request("/session", {
        headers: { Cookie: session.split(";")[0]! },
      })
    ).json();

    assert.equal(current.user.email, "u1@example.com");
    assert.equal(current.user.role, "admin");
    const needsSetup = (await (await f.request("/bootstrap")).json())
      .needsSetup;

    assert.equal(needsSetup, false);
    // Password change is refused once local accounts are disabled.
    process.env.AUTH_LOCAL = "false";
    const change = await f.request("/account/password", {
      method: "PUT",
      headers: { Cookie: session.split(";")[0]! },
      body: JSON.stringify({
        currentPassword: "x",
        newPassword: "long-enough-password",
      }),
    });

    assert.equal(change.status, 403);
    assert.equal((await change.json()).error.code, "AUTH_METHOD_DISABLED");
    process.env.AUTH_LOCAL = "true";
    // An OIDC account has no local password to change.
    const noPassword = await f.request("/account/password", {
      method: "PUT",
      headers: { Cookie: session.split(";")[0]! },
      body: JSON.stringify({
        currentPassword: "x",
        newPassword: "long-enough-password",
      }),
    });

    assert.equal(noPassword.status, 403);
    // The OIDC account has no usable local password.
    const login = await f.request("/login", {
      method: "POST",
      body: JSON.stringify({
        email: "u1@example.com",
        password: "anything-long-enough",
      }),
    });

    assert.equal(login.status, 401);
    assert.equal(
      (await f.users()).filter((row) => eq(tables.users.provider, "oidc"))
        .length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("callback rejects wrong state, wrong audience and wrong nonce with /?authError", async () => {
  const provider = await idp();
  const f = await fixture();

  try {
    const flow = await begin(f);
    const nonce = flow.location.searchParams.get("nonce");
    const attempt = async (state: string, token: string) => {
      provider.setToken(token);
      const response = await f.request(
        `/auth/oidc/callback?code=abc&state=${state}`,
        {
          headers: { Cookie: flow.cookie },
        },
      );

      assert.equal(response.status, 302);
      assert.equal(
        response.headers
          .getSetCookie()
          .some((value) => value.startsWith("excalidraw_session=")),
        false,
      );

      return response.headers.get("location");
    };

    assert.equal(await attempt("bad", ""), "/?authError=oidc_state");
    assert.equal(
      await attempt(
        flow.state,
        await provider.sign({ sub: "x", nonce }, "someone-else"),
      ),
      "/?authError=oidc_invalid_token",
    );
    assert.equal(
      await attempt(
        flow.state,
        await provider.sign({ sub: "x", nonce: "wrong" }),
      ),
      "/?authError=oidc_invalid_token",
    );
    assert.equal(
      (
        await f.request("/auth/oidc/callback?error=access_denied&state=x")
      ).headers.get("location"),
      "/?authError=oidc_denied",
    );
    assert.equal((await f.users()).length, 0);
  } finally {
    await f.close();
  }
});

test("OIDC endpoints redirect with oidc_disabled when OIDC is off", async () => {
  process.env.AUTH_OIDC = "false";
  const f = await fixture();

  try {
    const response = await f.request("/auth/oidc/start");

    assert.equal(response.headers.get("location"), "/?authError=oidc_disabled");
    assert.equal(
      (await f.request("/auth/oidc/start", { method: "POST" })).status,
      405,
    );
  } finally {
    await f.close();
  }
});
