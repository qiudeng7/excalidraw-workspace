import { test } from "node:test";
import assert from "node:assert/strict";
import { createDefaultUserSettings } from "../../shared/contracts";
import {
  completeUserSettingsWrite,
  readStoredUserSettings,
  validateUserSettings,
  validateUserSettingsWrite,
} from "../../server/utils/userSettings";
import { featureControls } from "../../src/lib/settingsControls";

test("arrow selection defaults on, appears in editor controls and upgrades stored settings", () => {
  const defaults = createDefaultUserSettings();

  assert.equal(defaults.features.arrowSelectionHighlight, true);
  assert.equal(
    featureControls.find(([key]) => key === "arrowSelectionHighlight")?.[1],
    "箭头沿线选中高亮",
  );
  const old: any = structuredClone(defaults);

  delete old.features.arrowSelectionHighlight;
  old.features.ctrlMultiSelect = false;
  assert.equal(validateUserSettings(old), false);
  assert.equal(validateUserSettingsWrite(old), true);
  const upgraded = readStoredUserSettings(old)!;

  assert.equal(upgraded.features.arrowSelectionHighlight, true);
  assert.equal(upgraded.features.ctrlMultiSelect, false);
  defaults.features.arrowSelectionHighlight = false;
  assert.equal(
    readStoredUserSettings(defaults)?.features.arrowSelectionHighlight,
    false,
  );
  assert.equal(
    completeUserSettingsWrite(old, defaults).features.arrowSelectionHighlight,
    false,
  );
});

test("new selection flag rejects invalid types, unknown fields and unreleased field combinations", () => {
  const defaults = createDefaultUserSettings();

  for (const value of [null, "true", 1]) {
    const invalid: any = structuredClone(defaults);

    invalid.features.arrowSelectionHighlight = value;
    assert.equal(validateUserSettingsWrite(invalid), false);
  }

  const invalid: any = structuredClone(defaults);

  delete invalid.features.ctrlMultiSelect;
  assert.equal(validateUserSettingsWrite(invalid), false);
  assert.equal(
    validateUserSettingsWrite({
      ...defaults,
      features: { ...defaults.features, unknownArrowSelectionFlag: false },
    }),
    false,
  );
});
