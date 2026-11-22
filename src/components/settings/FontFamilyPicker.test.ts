import { describe, expect, it } from "vitest";

import { DEFAULT_FONT_VALUE, fontPickerItems } from "./FontFamilyPicker";

const installed = ["Arial", "Cascadia Code", "Cascadia Mono", "Consolas"];
const anyInstalled = () => true;
const noneInstalled = () => false;

describe("fontPickerItems", () => {
  it("lists the default first, then every installed family, when nothing is typed", () => {
    expect(fontPickerItems(installed, "", noneInstalled)).toEqual({
      items: [DEFAULT_FONT_VALUE, ...installed],
      typed: null,
    });
    expect(fontPickerItems(installed, "   ", noneInstalled).items[0]).toBe(DEFAULT_FONT_VALUE);
  });

  it("filters case-insensitively and drops the default row while searching", () => {
    expect(fontPickerItems(installed, "CASCADIA", noneInstalled)).toEqual({
      items: ["Cascadia Code", "Cascadia Mono"],
      typed: null,
    });
  });

  it("offers a typed installed family the list does not know about", () => {
    expect(fontPickerItems(installed, " Segoe UI ", anyInstalled)).toEqual({
      items: ["Segoe UI"],
      typed: "Segoe UI",
    });
  });

  it("does not offer a typed row for a font that is not installed or already listed", () => {
    expect(fontPickerItems(installed, "Nope Sans", noneInstalled).typed).toBeNull();
    expect(fontPickerItems(installed, "arial", anyInstalled)).toEqual({ items: ["Arial"], typed: null });
  });

  it("still works as a typed-name picker when the font list is unavailable", () => {
    expect(fontPickerItems([], "", anyInstalled)).toEqual({ items: [DEFAULT_FONT_VALUE], typed: null });
    expect(fontPickerItems([], "Inter", anyInstalled)).toEqual({ items: ["Inter"], typed: "Inter" });
  });

  it("never treats the sentinel as a typed family", () => {
    expect(fontPickerItems([], DEFAULT_FONT_VALUE, anyInstalled).typed).toBeNull();
  });
});
