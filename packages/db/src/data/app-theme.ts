import {
  defaultAppTheme,
  defaultFaviconColor,
  faviconColorPreferenceSchema,
  type FaviconColorPreference,
} from "@bb/domain";
import type { DbConnection } from "../connection.js";
import {
  getStoredUserSetting,
  overwriteStoredUiPreference,
} from "./ui-preferences.js";

const APPEARANCE_SETTING_KEY = "appearance";

interface StoredAppearance {
  faviconColor: FaviconColorPreference;
  themeId: string;
}

function parseStoredAppearance(valueJson: string): StoredAppearance | null {
  let value: unknown;
  try {
    value = JSON.parse(valueJson);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const themeId = Reflect.get(value, "themeId");
  const faviconColor = faviconColorPreferenceSchema.safeParse(
    Reflect.get(value, "faviconColor"),
  );
  return {
    themeId:
      typeof themeId === "string" && themeId.length > 0
        ? themeId
        : defaultAppTheme.themeId,
    faviconColor: faviconColor.success
      ? faviconColor.data
      : defaultFaviconColor,
  };
}

export function getStoredAppearance(
  db: DbConnection,
  userId: string,
): StoredAppearance {
  const stored = getStoredUserSetting(db, {
    key: APPEARANCE_SETTING_KEY,
    userId,
  });
  return (
    (stored === null ? null : parseStoredAppearance(stored.valueJson)) ?? {
      themeId: defaultAppTheme.themeId,
      faviconColor: defaultFaviconColor,
    }
  );
}

export function getStoredThemeId(db: DbConnection, userId: string): string {
  return getStoredAppearance(db, userId).themeId;
}

export function getStoredFaviconColor(
  db: DbConnection,
  userId: string,
): FaviconColorPreference {
  return getStoredAppearance(db, userId).faviconColor;
}

export function setStoredAppearance(
  db: DbConnection,
  userId: string,
  appearance: StoredAppearance,
): void {
  overwriteStoredUiPreference(db, {
    key: APPEARANCE_SETTING_KEY,
    userId,
    valueJson: JSON.stringify({
      themeId: appearance.themeId,
      faviconColor: appearance.faviconColor,
    }),
  });
}
