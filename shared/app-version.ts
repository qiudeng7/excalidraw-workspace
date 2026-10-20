import packageInfo from "~~/package.json" with { type: "json" };

/** The application build version; independent of the bundled editor version. */
export const APP_VERSION = packageInfo.version;
