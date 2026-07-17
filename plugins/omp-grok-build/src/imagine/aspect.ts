export const VALID_ASPECT_RATIOS = [
  "auto",
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "2:1",
  "1:2",
  "19.5:9",
  "9:19.5",
  "20:9",
  "9:20",
] as const;

export type AspectRatio = (typeof VALID_ASPECT_RATIOS)[number];

export function isValidAspectRatio(value: string): value is AspectRatio {
  return (VALID_ASPECT_RATIOS as readonly string[]).includes(value);
}

/** Validate and return a normalized aspect ratio. Throws on unrecognised values. */
export function normalizeAspectRatio(value: string | undefined): AspectRatio {
  if (!value) return "auto";
  const normalized = value.trim();
  if (isValidAspectRatio(normalized)) return normalized;
  throw new Error(
    `Invalid aspect ratio "${value}". Valid values: ${VALID_ASPECT_RATIOS.join(", ")}`,
  );
}
