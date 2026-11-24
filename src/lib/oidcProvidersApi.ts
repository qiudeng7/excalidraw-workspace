import type { OidcProviderRecord, OidcProviderType } from "#shared/oidc";
import { api } from "~/lib/api";

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

/** 仅管理员可用；clientSecret 明文提交，界面默认遮蔽。 */
export const oidcProvidersApi = {
  async list(): Promise<OidcProviderRecord[]> {
    return (
      await api<{ providers: OidcProviderRecord[] }>(
        "/api/admin/oidc-providers",
      )
    ).providers;
  },
  async create(input: OidcProviderInput): Promise<OidcProviderRecord> {
    return (
      await api<{ provider: OidcProviderRecord }>("/api/admin/oidc-providers", {
        method: "POST",
        body: JSON.stringify(input),
      })
    ).provider;
  },
  async update(
    id: string,
    input: Partial<OidcProviderInput>,
  ): Promise<OidcProviderRecord> {
    return (
      await api<{ provider: OidcProviderRecord }>(
        `/api/admin/oidc-providers/${encodeURIComponent(id)}`,
        { method: "PATCH", body: JSON.stringify(input) },
      )
    ).provider;
  },
  async remove(id: string): Promise<void> {
    await api(`/api/admin/oidc-providers/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: "{}",
    });
  },
  async uploadIcon(id: string, dataUrl: string): Promise<OidcProviderRecord> {
    return (
      await api<{ provider: OidcProviderRecord }>(
        `/api/admin/oidc-providers/${encodeURIComponent(id)}/icon`,
        { method: "PUT", body: JSON.stringify({ dataUrl }) },
      )
    ).provider;
  },
};
