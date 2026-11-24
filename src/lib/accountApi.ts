import type { Bootstrap, User } from "#shared/contracts";
import { api } from "~/lib/api";
import { apiUrl } from "~/lib/runtime";

export interface Credentials {
  email: string;
  password: string;
  name?: string;
}

export type AuthenticationMode = "setup" | "register" | "login";

export interface AccountApi {
  bootstrap(): Promise<Bootstrap>;
  session(): Promise<User | null>;
  authenticate(
    mode: AuthenticationMode,
    credentials: Credentials,
  ): Promise<User>;
  logout(): Promise<void>;
  changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void>;
  setRegistration(enabled: boolean): Promise<boolean>;
}

/** Browser navigation target for one identity provider (a redirect flow, not a fetch). */
/** Navigated to directly (not via api()), so the runtime base is applied at call time. */
export const oidcStartUrl = (providerId: string) =>
  apiUrl(`/api/auth/oidc/${encodeURIComponent(providerId)}/start`);

export const accountApi: AccountApi = {
  bootstrap: () => api<Bootstrap>("/api/bootstrap"),
  session: async () => (await api<{ user: User | null }>("/api/session")).user,
  authenticate: async (mode, credentials) =>
    (
      await api<{ user: User }>(`/api/${mode}`, {
        method: "POST",
        body: JSON.stringify(credentials),
      })
    ).user,
  logout: async () => {
    await api("/api/logout", { method: "POST", body: "{}" });
  },
  setRegistration: async (enabled) =>
    (
      await api<{ registrationEnabled: boolean }>("/api/admin/settings", {
        method: "PATCH",
        body: JSON.stringify({ registrationEnabled: enabled }),
      })
    ).registrationEnabled,
  changePassword: async (userId, currentPassword, newPassword) => {
    await api("/api/account/password", {
      method: "PUT",
      headers: { "X-Account-Owner": userId },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  },
};
