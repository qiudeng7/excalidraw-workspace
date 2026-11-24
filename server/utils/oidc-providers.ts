import { blob } from "@nuxthub/blob";
import { getRouterParam, type H3Event } from "h3";
import type {
  OidcProviderRecord,
  OidcProviderSummary,
  OidcProviderType,
} from "#shared/oidc";
import { oidcProviderPresets, oidcProviderTypes } from "#shared/oidc";
import type { OidcProviderRow } from "#server/db/oidc-providers";
import { ApiError, fail, name } from "#server/utils/http";

const DEFAULT_SCOPES = "openid profile email";
const MAX_ICON_BYTES = 256 * 1024;
const MAX_ISSUER_LENGTH = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 微软多租户端点：issuer 只是 discovery 入口，id_token 的 iss 带实际租户。
const MULTI_TENANT_ISSUER =
  /^https:\/\/login\.microsoftonline\.com\/(?:common|organizations|consumers|\{tenantid\})\/v2\.0$/i;
const ICON_TYPES = {
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
} as const;
const ICON_CONTENT_TYPES = {
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
} as const;

export type IconExtension = keyof typeof ICON_CONTENT_TYPES;

export interface OidcProviderInput {
  id: string;
  type: OidcProviderType;
  name: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  enabled: boolean;
  autoRegister: boolean;
}

export function providerSummary(row: OidcProviderRow): OidcProviderSummary {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    iconUrl: providerIconUrl(row),
  };
}

export function providerRecord(row: OidcProviderRow): OidcProviderRecord {
  return {
    ...providerSummary(row),
    issuer: row.issuer,
    clientId: row.clientId,
    clientSecret: row.clientSecret,
    scopes: row.scopes,
    enabled: row.enabled,
    autoRegister: row.autoRegister,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 预设类型回落到前端内置图标，custom 用上传图标的公开读取地址。 */
export function providerIconUrl(row: OidcProviderRow) {
  if (row.icon) return `/api/auth/oidc/${encodeURIComponent(row.id)}/icon`;

  return oidcProviderPresets[row.type].icon;
}

export function oidcCallbackUrl(origin: string, id: string) {
  return `${origin}/api/auth/oidc/${encodeURIComponent(id)}/callback`;
}

/** 路由参数只能是 UUID；其余一律按不存在处理。 */
export function oidcProviderId(event: H3Event) {
  const id = getRouterParam(event, "providerId", { decode: true });

  return id && UUID.test(id) ? id.toLowerCase() : "";
}

export function isMultiTenantMicrosoft(type: OidcProviderType, issuer: string) {
  return type === "microsoft" && MULTI_TENANT_ISSUER.test(issuer);
}

export function providerIdInput(value: unknown) {
  if (typeof value !== "string" || !UUID.test(value.trim()))
    return fail(400, "INVALID_PROVIDER_ID", "身份源标识无效");

  return value.trim().toLowerCase();
}

export function providerTypeInput(value: unknown): OidcProviderType {
  if (
    typeof value !== "string" ||
    !oidcProviderTypes.includes(value as OidcProviderType)
  )
    return fail(400, "INVALID_PROVIDER_TYPE", "请选择身份源类型");

  return value as OidcProviderType;
}

export function providerIssuerInput(value: unknown) {
  if (typeof value !== "string" || !value.trim())
    return fail(400, "INVALID_ISSUER", "填写身份源的 issuer 地址");
  const issuer = value.trim().replace(/\/+$/, "");
  let url: URL;

  try {
    url = new URL(issuer);
  } catch (error) {
    throw new ApiError(
      400,
      "INVALID_ISSUER",
      "issuer 需为完整的 HTTP(S) 地址",
      {
        cause: error,
      },
    );
  }

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    issuer.length > MAX_ISSUER_LENGTH
  )
    return fail(400, "INVALID_ISSUER", "issuer 需为完整的 HTTP(S) 地址");

  return issuer;
}

export function providerScopesInput(value: unknown) {
  const scopes =
    typeof value === "string" && value.trim()
      ? value.trim().replace(/\s+/g, " ")
      : DEFAULT_SCOPES;
  const tokens = scopes.split(" ");

  if (
    scopes.length > 200 ||
    !tokens.every((token) => /^[A-Za-z0-9._:/+-]+$/.test(token))
  )
    return fail(400, "INVALID_SCOPES", "scope 需为空格分隔的标识");
  if (!tokens.includes("openid"))
    return fail(400, "INVALID_SCOPES", "scope 必须包含 openid");

  return scopes;
}

export function providerField(value: unknown, label: string, maximum: number) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > maximum
  )
    return fail(400, "INVALID_PROVIDER", `${label}需为 1–${maximum} 个字符`);

  return value.trim();
}

function flagValue(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

export function providerInput(
  data: Record<string, unknown>,
  defaults: { enabled?: boolean; autoRegister?: boolean } = {},
): OidcProviderInput {
  return {
    id: providerIdInput(data.id),
    type: providerTypeInput(data.type),
    name: name(data.name, "未命名身份源"),
    issuer: providerIssuerInput(data.issuer),
    clientId: providerField(data.clientId, "客户端 ID", 200),
    clientSecret: providerField(data.clientSecret, "客户端密钥", 500),
    scopes: providerScopesInput(data.scopes),
    enabled: flagValue(data.enabled, defaults.enabled ?? true),
    autoRegister: flagValue(data.autoRegister, defaults.autoRegister ?? true),
  };
}

/** 图标以 data URL 上传，仅接受 png、svg、webp 且不超过 256 KB。 */
export function iconInput(value: unknown) {
  const match =
    typeof value === "string"
      ? /^data:(image\/(?:png|svg\+xml|webp));base64,([A-Za-z0-9+/=]+)$/.exec(
          value,
        )
      : null;

  if (!match)
    return fail(400, "INVALID_ICON", "图标仅支持 png、svg、webp 图片");
  const bytes = decodeBase64(match[2]!);

  if (!bytes.length || bytes.length > MAX_ICON_BYTES)
    return fail(400, "ICON_TOO_LARGE", "图标不能超过 256 KB");

  return {
    extension: ICON_TYPES[match[1] as keyof typeof ICON_TYPES] as IconExtension,
    bytes,
  };
}

function decodeBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);

  return bytes;
}

export async function storeProviderIcon(
  id: string,
  icon: { extension: IconExtension; bytes: Uint8Array },
) {
  const key = `oidc-providers/${id}/icon.${icon.extension}`;

  await blob.put(key, icon.bytes, {
    contentType: ICON_CONTENT_TYPES[icon.extension],
  });

  return key;
}

export async function dropProviderIcon(keys: (string | null | undefined)[]) {
  const paths = keys.filter((key): key is string => !!key);

  if (paths.length) await blob.del(paths);
}

export async function readProviderIcon(key: string) {
  const extension = key.split(".").pop() as IconExtension | undefined;
  const contentType = extension ? ICON_CONTENT_TYPES[extension] : undefined;

  if (!contentType) return null;
  const object = await blob.get(key);

  return object ? { contentType, object } : null;
}
