// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  PALETTE_RECENTS_KEY,
  readPaletteRecents,
  recordPaletteRecent,
} from "./palette-recents";

afterEach(() => window.localStorage.clear());

describe("palette recents", () => {
  it("keeps each signed-in user's recents apart", () => {
    const alexKey = `${PALETTE_RECENTS_KEY}:user:usr_alex`;
    const samKey = `${PALETTE_RECENTS_KEY}:user:usr_sam`;

    recordPaletteRecent(alexKey, [], "thread.search");

    expect(readPaletteRecents(alexKey)).toEqual(["thread.search"]);
    expect(readPaletteRecents(samKey)).toEqual([]);
    expect(readPaletteRecents(PALETTE_RECENTS_KEY)).toEqual([]);
  });

  it("neither reads nor writes while nobody is signed in", () => {
    window.localStorage.setItem(
      PALETTE_RECENTS_KEY,
      JSON.stringify(["thread.new"]),
    );

    expect(readPaletteRecents(null)).toEqual([]);
    expect(recordPaletteRecent(null, [], "thread.search")).toEqual([
      "thread.search",
    ]);
    expect(window.localStorage.length).toBe(1);
  });
});
