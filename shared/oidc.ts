/** 身份源类型；预设类型由界面自动带出名称与 issuer，custom 由管理员填写并上传图标。 */
export const oidcProviderTypes = [
  "microsoft",
  "gitlab",
  "google",
  "custom",
] as const;

export type OidcProviderType = (typeof oidcProviderTypes)[number];

export interface OidcProviderPreset {
  label: string;
  /** 新建时的默认 issuer；空字符串表示由管理员填写。 */
  issuer: string;
  /** 前端内置图标路径；null 表示使用管理员上传的图标。 */
  icon: string | null;
}

export const oidcProviderPresets: Record<OidcProviderType, OidcProviderPreset> =
  {
    microsoft: {
      label: "Microsoft",
      // 多租户端点：discovery 的 issuer 是 {tenantid} 模板，id_token 的 iss 带实际租户。
      issuer: "https://login.microsoftonline.com/common/v2.0",
      icon: "/oidc/microsoft.svg",
    },
    gitlab: {
      label: "GitLab",
      issuer: "https://gitlab.com",
      icon: "/oidc/gitlab.svg",
    },
    google: {
      label: "Google",
      issuer: "https://accounts.google.com",
      icon: "/oidc/google.svg",
    },
    custom: { label: "自定义 OIDC", issuer: "", icon: null },
  };

/** 登录页与管理列表都需要的最小身份源信息。 */
export interface OidcProviderSummary {
  id: string;
  type: OidcProviderType;
  name: string;
  /** 预设类型为内置图标路径，custom 为上传图标的公开读取地址；缺图标时为 null。 */
  iconUrl: string | null;
}

/** 仅管理员接口返回；clientSecret 按约定以明文保存并返回。 */
export interface OidcProviderRecord extends OidcProviderSummary {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  enabled: boolean;
  autoRegister: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AuthMethods {
  local: boolean;
  /** 仅包含已启用的身份源。 */
  oidc: OidcProviderSummary[];
}
