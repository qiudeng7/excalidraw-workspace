import assert from "node:assert/strict";

export function localOrigin(value) {
  const base = new URL(value);
  assert.ok(
    ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) &&
      base.protocol === "http:",
    "仅允许本地回环 HTTP",
  );
  assert.ok(
    !base.username &&
      !base.password &&
      base.pathname === "/" &&
      !base.search &&
      !base.hash,
    "仅提供本地 origin",
  );
  return base;
}

export function localClient(origin) {
  const base = localOrigin(origin);
  async function request(
    path,
    method = "GET",
    data,
    cookie,
    owner,
    settingsOwner = false,
  ) {
    const response = await fetch(new URL(`/api${path}`, base), {
      method,
      headers: {
        Origin: base.origin,
        "Content-Type": "application/json",
        "X-Requested-With": "excalidraw-demo",
        ...(cookie ? { Cookie: cookie } : {}),
        ...(owner
          ? { [settingsOwner ? "X-Settings-Owner" : "X-Resource-Owner"]: owner }
          : {}),
      },
      signal: AbortSignal.timeout(15000),
      redirect: "error",
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(
        `${method} ${path}: HTTP ${response.status} 返回非 JSON：${text.slice(0, 200)}`,
      );
    }
    return {
      status: response.status,
      body,
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  }
  return request;
}

export const report = (message) => console.log(`✓ ${message}`);
export const expect = (result, status) => {
  assert.equal(result.status, status);
  return result.body;
};
