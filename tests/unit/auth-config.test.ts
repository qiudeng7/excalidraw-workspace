import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AuthConfigError,
  oidcRedirectUri,
  parseAuthConfig,
} from "../../server/utils/auth-config";

const oidc = {
  AUTH_OIDC: "true",
  OIDC_ISSUER: "https://idp.test",
  OIDC_CLIENT_ID: "client",
  OIDC_CLIENT_SECRET: "secret",
};

test("defaults keep local accounts only", () => {
  assert.deepEqual(parseAuthConfig({}), { local: true, oidc: null });
  assert.deepEqual(parseAuthConfig({ AUTH_LOCAL: "", AUTH_OIDC: "false" }), {
    local: true,
    oidc: null,
  });
});

test("at least one account method is required", () => {
  assert.throws(
    () => parseAuthConfig({ AUTH_LOCAL: "false" }),
    AuthConfigError,
  );
  assert.throws(
    () => parseAuthConfig({ AUTH_LOCAL: "0", AUTH_OIDC: "0" }),
    AuthConfigError,
  );
});

test("flags reject unrecognised values instead of silently degrading", () => {
  assert.throws(() => parseAuthConfig({ AUTH_LOCAL: "nope" }), /AUTH_LOCAL/);
});

test("OIDC needs issuer, client id and secret", () => {
  for (const key of ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"]) {
    const env: Record<string, string> = { ...oidc };

    delete env[key];
    assert.throws(() => parseAuthConfig(env), new RegExp(key));
  }

  assert.throws(
    () => parseAuthConfig({ ...oidc, OIDC_ISSUER: "ftp://idp.test" }),
    /OIDC_ISSUER/,
  );
});

test("OIDC-only is valid and scopes and redirect URI have defaults", () => {
  const config = parseAuthConfig({ ...oidc, AUTH_LOCAL: "false" });

  assert.equal(config.local, false);
  assert.equal(config.oidc?.scopes, "openid profile email");
  assert.equal(
    oidcRedirectUri(config.oidc!, "https://app.test"),
    "https://app.test/api/auth/oidc/callback",
  );
  const custom = parseAuthConfig({
    ...oidc,
    OIDC_SCOPES: "openid",
    OIDC_REDIRECT_URI: "https://bff.test/cb",
  }).oidc!;

  assert.equal(custom.scopes, "openid");
  assert.equal(
    oidcRedirectUri(custom, "https://app.test"),
    "https://bff.test/cb",
  );
});

test("post-login path defaults to / and rejects off-origin redirects", () => {
  assert.equal(parseAuthConfig(oidc).oidc?.postLoginPath, "/");
  assert.equal(
    parseAuthConfig({ ...oidc, OIDC_POST_LOGIN_PATH: "/apps/canvas?x=1" }).oidc
      ?.postLoginPath,
    "/apps/canvas?x=1",
  );
  for (const value of [
    "https://evil.test/",
    "//evil.test",
    "/\\evil.test",
    "apps",
  ])
    assert.throws(
      () => parseAuthConfig({ ...oidc, OIDC_POST_LOGIN_PATH: value }),
      AuthConfigError,
      value,
    );
});
