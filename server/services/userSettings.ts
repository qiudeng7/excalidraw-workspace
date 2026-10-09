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
