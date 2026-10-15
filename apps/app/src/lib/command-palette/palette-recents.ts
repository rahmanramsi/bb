export const PALETTE_RECENTS_KEY = "bb.palette.recents";
const PALETTE_RECENTS_LIMIT = 8;

export function readPaletteRecents(storageKey: string | null): string[] {
  if (storageKey === null) return [];
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === null) return [];
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === "string")
      .slice(0, PALETTE_RECENTS_LIMIT);
  } catch {
    return [];
  }
}

export function recordPaletteRecent(
  storageKey: string | null,
  recents: readonly string[],
  actionId: string,
): string[] {
  const next = [
    actionId,
    ...recents.filter((entry) => entry !== actionId),
  ].slice(0, PALETTE_RECENTS_LIMIT);
  if (storageKey === null) return next;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(next));
  } catch {}
  return next;
}
