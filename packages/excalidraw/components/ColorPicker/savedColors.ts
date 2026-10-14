export const MAX_SAVED_COLORS = 24;

// Store a bounded, canonical list, never arbitrary CSS read from localStorage.
export const canonicalSavedColor = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const color = value.trim().toLowerCase();

  if (color === "transparent") return color;
  if (/^#[0-9a-f]{3,4}$/.test(color)) {
    return `#${[...color.slice(1)].map((digit) => digit + digit).join("")}`;
  }

  return /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/.test(color) ? color : null;
};

export const parseSavedColors = (value: string | null): string[] => {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);

    if (!Array.isArray(parsed)) return [];

    return [...new Set(parsed.map(canonicalSavedColor).filter(Boolean))].slice(
      0,
      MAX_SAVED_COLORS,
    ) as string[];
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
};
