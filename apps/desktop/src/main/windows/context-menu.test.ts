import type { ContextMenuParams } from "electron";
import { afterEach, expect, it, vi } from "vitest";
import { contextMenuTemplate } from "./context-menu.js";

const state = vi.hoisted(() => ({ translate: (message: string) => message }));
vi.mock("../i18n.js", () => ({ t: (message: string) => state.translate(message) }));
afterEach(() => {
  state.translate = (message) => message;
});

const editFlags: ContextMenuParams["editFlags"] = {
  canUndo: false,
  canRedo: false,
  canCut: true,
  canCopy: true,
  canPaste: true,
  canDelete: false,
  canSelectAll: true,
  canEditRichly: false,
};

it("offers Copy for selected text without Cut or Paste", () => {
  expect(contextMenuTemplate({ selectionText: "text", isEditable: false, editFlags })).toEqual([
    { role: "copy", label: "Copy", enabled: true },
    { type: "separator" },
    { role: "selectAll", label: "Select All", enabled: true },
  ]);
});

it("offers only Select All on unselected non-editable content", () => {
  expect(contextMenuTemplate({ selectionText: "", isEditable: false, editFlags })).toEqual([
    { role: "selectAll", label: "Select All", enabled: true },
  ]);
});

it.each([true, false])("uses edit flags for all editable actions (%s)", (enabled) => {
  expect(
    contextMenuTemplate({
      selectionText: "",
      isEditable: true,
      editFlags: {
        ...editFlags,
        canCut: enabled,
        canCopy: enabled,
        canPaste: enabled,
        canSelectAll: enabled,
      },
    }),
  ).toEqual([
    { role: "cut", label: "Cut", enabled },
    { role: "copy", label: "Copy", enabled },
    { role: "paste", label: "Paste", enabled },
    { type: "separator" },
    { role: "selectAll", label: "Select All", enabled },
  ]);
});

it("uses the active app language for edit labels while retaining native roles", () => {
  const params = { selectionText: "", isEditable: true, editFlags };
  expect(contextMenuTemplate(params).map((item) => item.label)).toEqual([
    "Cut",
    "Copy",
    "Paste",
    undefined,
    "Select All",
  ]);
  const labels: Record<string, string> = {
    Cut: "Couper",
    Copy: "Copier",
    Paste: "Coller",
    "Select All": "Tout sélectionner",
  };
  state.translate = (message) => labels[message] ?? message;
  expect(contextMenuTemplate(params)).toEqual([
    { role: "cut", label: "Couper", enabled: true },
    { role: "copy", label: "Copier", enabled: true },
    { role: "paste", label: "Coller", enabled: true },
    { type: "separator" },
    { role: "selectAll", label: "Tout sélectionner", enabled: true },
  ]);
});
