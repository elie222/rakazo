import type { ContextMenuParams } from "electron";
import { expect, it } from "vitest";
import { contextMenuTemplate } from "./context-menu.js";

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
    { role: "copy", enabled: true },
    { type: "separator" },
    { role: "selectAll", enabled: true },
  ]);
});

it("offers only Select All on unselected non-editable content", () => {
  expect(contextMenuTemplate({ selectionText: "", isEditable: false, editFlags })).toEqual([
    { role: "selectAll", enabled: true },
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
    { role: "cut", enabled },
    { role: "copy", enabled },
    { role: "paste", enabled },
    { type: "separator" },
    { role: "selectAll", enabled },
  ]);
});
