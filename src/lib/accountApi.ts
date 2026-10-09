import type { Bootstrap, User } from "../../shared/contracts";
import { api } from "./api";

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
  setRegistration(enabled: boolean): Promise<boolean>;
}

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
};
