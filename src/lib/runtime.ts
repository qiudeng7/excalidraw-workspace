/** Single exit for every URL the frontend builds; default base "" keeps same-origin behavior. */
interface RuntimeConfig {
  base: string;
  realtimeBase?: string;
  accessToken?: () => Promise<string | undefined>;
}

const config: RuntimeConfig = { base: "" };

function trimBase(value: string) {
  return value.replace(/\/+$/, "");
}

export function configureApi(options: {
  base: string;
  realtimeBase?: string;
  accessToken?: () => Promise<string | undefined>;
}) {
  config.base = trimBase(options.base);
  config.realtimeBase =
    options.realtimeBase === undefined
      ? undefined
      : trimBase(options.realtimeBase);
  config.accessToken = options.accessToken;
  // Editor fonts are resolved by Excalidraw from this global; only override a non-default base.
  if (config.base && typeof window !== "undefined")
    (window as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH =
      assetUrl("/editor-assets/");
}

/** True only when a host supplies tokens; keeps the same-origin path free of extra awaits. */
export function hasAccessTokenProvider() {
  return config.accessToken !== undefined;
}

/** Resolve one short-lived Identity access token; undefined keeps the Cookie session. */
export async function accessToken() {
  return config.accessToken ? await config.accessToken() : undefined;
}

export function apiUrl(path: string) {
  return `${config.base}${path}`;
}

export function assetUrl(path: string) {
  return `${config.base}${path}`;
}

/** Absolute ws(s) URL. realtimeBase wins; otherwise the API base resolved against the page origin. */
export function realtimeUrl(path: string) {
  const url = new URL(
    `${config.realtimeBase ?? config.base}${path}`,
    location.origin,
  );

  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";

  return url.href;
}
