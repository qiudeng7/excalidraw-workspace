export type ThemePreference = "light" | "dark" | "system";

export function useTheme() {
  const storedPreference = useCookie<ThemePreference>("workspace-theme", {
    default: () => "system",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
  const systemTheme = useState<"light" | "dark">("system-theme", () => "light");
  const preference = computed<ThemePreference>(() =>
    storedPreference.value === "light" || storedPreference.value === "dark"
      ? storedPreference.value
      : "system",
  );
  const theme = computed(() =>
    preference.value === "system" ? systemTheme.value : preference.value,
  );

  function setPreference(value: ThemePreference) {
    storedPreference.value = value;
  }

  return { preference, theme, systemTheme, setPreference };
}
