export default defineNuxtPlugin((nuxtApp) => {
  const { theme, systemTheme } = useTheme();
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const updateSystemTheme = () => {
    systemTheme.value = media.matches ? "dark" : "light";
  };

  updateSystemTheme();
  media.addEventListener("change", updateSystemTheme);
  const stop = watch(
    theme,
    (value) => {
      document.documentElement.dataset.theme = value;
    },
    { immediate: true, flush: "sync" },
  );

  nuxtApp.vueApp.onUnmount(() => {
    media.removeEventListener("change", updateSystemTheme);
    stop();
  });
});
