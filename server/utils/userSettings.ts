import type { UserSettings } from "../../shared/contracts";

/** Full versioned payload only: reject unknown fields instead of storing arbitrary data. */
export function validateUserSettings(value: unknown): value is UserSettings {
  const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
  const keys = (value: Record<string, unknown>, allowed: string[]) =>
    Object.keys(value).length === allowed.length &&
    allowed.every((key) => Object.hasOwn(value, key));
  const booleans = (value: unknown, allowed: string[]) =>
    object(value) &&
    keys(value, allowed) &&
    allowed.every((key) => typeof value[key] === "boolean");

  if (
    !object(value) ||
    !keys(value, ["version", "features", "debug"]) ||
    value.version !== 1
  )
    return false;
  if (
    !booleans(value.features, [
      "edgeBinding",
      "nunitoFont",
      "formalLines",
      "solidFill",
      "shortArrowheads",
      "disableDefaultSidebar",
    ])
  )
    return false;
  if (
    !object(value.debug) ||
    !keys(value.debug, ["sampling", "renderingOptions"]) ||
    ![1, 1.5, 2].includes(value.debug.sampling as number)
  )
    return false;

  return booleans(value.debug.renderingOptions, [
    "smoothCache",
    "highQualitySmoothing",
    "directText",
    "directShapes",
    "alignPixels",
    "smoothCanvas",
  ]);
}

/** Upgrade saved v1 settings without resetting existing preferences or revisions. */
export function readStoredUserSettings(value: unknown): UserSettings | null {
  if (value && typeof value === "object" && "features" in value) {
    const features = value.features;

    if (
      features &&
      typeof features === "object" &&
      !Array.isArray(features) &&
      !Object.hasOwn(features, "disableDefaultSidebar")
    ) {
      value = {
        ...value,
        features: { ...features, disableDefaultSidebar: true },
      };
    }
  }

  return validateUserSettings(value) ? value : null;
}
