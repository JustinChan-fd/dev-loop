// Seed module for the app-layout eval scenario (clean-app).

/** Drops leading and trailing dashes: "--a-b--" -> "a-b". */
export function trimDashes(s) {
  return String(s).replace(/^-+|-+$/g, "");
}
