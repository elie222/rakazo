import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";

export function contextMenuTemplate(
  params: Pick<ContextMenuParams, "isEditable" | "selectionText" | "editFlags">,
): MenuItemConstructorOptions[] {
  const { isEditable, selectionText, editFlags } = params;
  const template: MenuItemConstructorOptions[] = [];
  if (isEditable) template.push({ role: "cut", enabled: editFlags.canCut });
  if (isEditable || selectionText.length > 0)
    template.push({ role: "copy", enabled: editFlags.canCopy });
  if (isEditable) template.push({ role: "paste", enabled: editFlags.canPaste });
  if (template.length) template.push({ type: "separator" });
  template.push({ role: "selectAll", enabled: editFlags.canSelectAll });
  return template;
}
