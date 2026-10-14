import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  applyDarkModeFilter,
  colorToHex,
  isTransparent,
} from "@excalidraw/common";

import { useAtom } from "../../editor-jotai";
import { t } from "../../i18n";

import { activeColorPickerSectionAtom } from "./colorPickerUtils";
import {
  canonicalSavedColor,
  MAX_SAVED_COLORS,
  parseSavedColors,
} from "./savedColors";

type Palette = {
  colors: string[];
  save: (colors: string[]) => void;
  error: boolean;
};

const SavedPaletteContext = createContext<Palette | null>(null);

export const useSavedColorPalette = () => useContext(SavedPaletteContext);

export const SavedColorPaletteProvider = ({
  storageKey,
  children,
}: {
  storageKey?: string;
  children: ReactNode;
}) => {
  const [error, setError] = useState(false);
  const [colors, setColors] = useState<string[]>(() => {
    if (!storageKey) return [];
    try {
      return parseSavedColors(window.localStorage.getItem(storageKey));
    } catch (error) {
      // Browsers can disable storage; keep this editor usable in memory.
      console.warn("Unable to read the personal color palette", error);

      return [];
    }
  });

  useEffect(() => {
    if (!storageKey) return;
    const changed = (event: StorageEvent) => {
      if (
        event.storageArea === window.localStorage &&
        (event.key === storageKey || event.key === null)
      ) {
        setColors(parseSavedColors(event.newValue));
      }
    };

    window.addEventListener("storage", changed);

    return () => window.removeEventListener("storage", changed);
  }, [storageKey]);

  const save = (next: string[]) => {
    setColors(next);
    try {
      window.localStorage.setItem(storageKey!, JSON.stringify(next));
      setError(false);
    } catch (error) {
      console.warn("Unable to persist the personal color palette", error);
      setError(true);
    }
  };

  return (
    <SavedPaletteContext.Provider
      value={storageKey ? { colors, save, error } : null}
    >
      {children}
    </SavedPaletteContext.Provider>
  );
};

export const SavedColorPalette = ({
  color,
  onChange,
  dark,
}: {
  color: string | null;
  onChange: (color: string) => void;
  dark: boolean;
}) => {
  const palette = useSavedColorPalette();
  const [section, setSection] = useAtom(activeColorPickerSectionAtom);
  const container = useRef<HTMLDivElement>(null);
  const current = color
    ? canonicalSavedColor(
        isTransparent(color) ? "transparent" : colorToHex(color),
      )
    : null;

  useEffect(() => {
    if (
      section === "saved" &&
      !container.current?.contains(document.activeElement)
    )
      container.current
        ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus();
  }, [section]);

  if (!palette) return null;
  const { colors, save, error } = palette;
  const included = !!current && colors.includes(current);

  return (
    <div
      ref={container}
      className="saved-color-palette"
      role="group"
      aria-label={t("colorPicker.savedPalette")}
      onFocus={() => setSection("saved")}
      onKeyDown={(event) => {
        if (event.key === "Escape") return;
        if (event.key === "Tab") {
          const buttons = [
            ...container.current!.querySelectorAll<HTMLButtonElement>(
              "button:not(:disabled)",
            ),
          ];
          const index = buttons.indexOf(event.target as HTMLButtonElement);

          // At either edge the picker's section navigation takes over.
          if (
            (event.shiftKey && index === 0) ||
            (!event.shiftKey && index === buttons.length - 1)
          )
            return;
        }

        event.stopPropagation();
      }}
    >
      <div className="saved-color-palette__heading">
        <span>{t("colorPicker.savedPalette")}</span>
        <span>
          {colors.length}/{MAX_SAVED_COLORS}
        </span>
      </div>
      {!!colors.length && (
        <div className="saved-color-palette__colors">
          {colors.map((saved) => (
            <button
              key={saved}
              type="button"
              className={`color-picker__button color-picker__button--large has-outline${saved === "transparent" ? " is-transparent" : ""}`}
              aria-label={`${t("colorPicker.applySavedColor")} ${saved}`}
              aria-pressed={saved === current}
              title={saved}
              style={{ "--swatch-color": applyDarkModeFilter(saved, dark) }}
              onClick={() => onChange(saved)}
              onKeyDown={(event) => {
                if (event.key === "Delete" || event.key === "Backspace") {
                  event.preventDefault();
                  save(colors.filter((value) => value !== saved));
                  const next =
                    event.currentTarget.nextElementSibling ??
                    event.currentTarget.previousElementSibling;

                  requestAnimationFrame(() => {
                    if (next) (next as HTMLButtonElement).focus();
                    else
                      container.current
                        ?.querySelector<HTMLButtonElement>(
                          ".saved-color-palette__add",
                        )
                        ?.focus();
                  });
                }
              }}
            >
              <div className="color-picker__button-outline" />
            </button>
          ))}
        </div>
      )}
      <div className="saved-color-palette__actions">
        <button
          className="saved-color-palette__add"
          type="button"
          disabled={!current || included || colors.length >= MAX_SAVED_COLORS}
          onClick={() => current && save([...colors, current])}
        >
          {included
            ? t("colorPicker.colorSaved")
            : t("colorPicker.saveCurrentColor")}
        </button>
        <button
          type="button"
          disabled={!included}
          aria-label={t("colorPicker.removeSavedColor")}
          title={t("colorPicker.removeSavedColor")}
          onClick={() => {
            save(colors.filter((value) => value !== current));
            requestAnimationFrame(() =>
              container.current
                ?.querySelector<HTMLButtonElement>(".saved-color-palette__add")
                ?.focus(),
            );
          }}
        >
          ×
        </button>
      </div>
      {error && (
        <div role="status" className="saved-color-palette__error">
          {t("colorPicker.paletteStorageError")}
        </div>
      )}
    </div>
  );
};
