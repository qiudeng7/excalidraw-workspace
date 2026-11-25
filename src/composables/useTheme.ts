import { computed, type ComputedRef } from "vue";

export type ThemePreference = "light" | "dark" | "system";

/**
 * An embedding WorkspaceApp publishes its resolved theme here so the editor follows the host.
 * A well-known global key is used instead of provide/inject: under federation this module can
 * be bundled more than once, and injection did not reach the canvas components.
 */
export const THEME_OVERRIDE_KEY = Symbol.for("workspace-theme-override");

type ThemeOverride = ComputedRef<"light" | "dark">;

export function setThemeOverride(value: ThemeOverride | undefined) {
  (globalThis as Record<symbol, unknown>)[THEME_OVERRIDE_KEY] = value;
}

export function useTheme() {
  const override = (globalThis as Record<symbol, unknown>)[
    THEME_OVERRIDE_KEY
  ] as ThemeOverride | undefined;
  const storedPreference = useCookie<ThemePreference>("workspace-theme", {
    default: () => "system",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
  const systemTheme = useState<"light" | "dark">("system-theme", () => "light");
  const preference = computed<ThemePreference>(() =>
    override
      ? override.value
      : storedPreference.value === "light" || storedPreference.value === "dark"
        ? storedPreference.value
        : "system",
  );
  const theme = computed(() =>
    override
      ? override.value
      : preference.value === "system"
        ? systemTheme.value
        : preference.value,
  );

  function setPreference(value: ThemePreference) {
    if (override) return;
    storedPreference.value = value;
  }

  return { preference, theme, systemTheme, setPreference };
}
