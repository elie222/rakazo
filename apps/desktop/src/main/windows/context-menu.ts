import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";
import { clipboard } from "electron";
import { t } from "../i18n.js";

/** A link whose address is worth copying: a page or a mail address, never a script or file. */
function copyableLink(linkURL: string): boolean {
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(linkURL).protocol);
  } catch {
    return false;
  }
}

export function contextMenuTemplate(
  params: Pick<ContextMenuParams, "isEditable" | "selectionText" | "linkURL" | "editFlags">,
): MenuItemConstructorOptions[] {
  const { isEditable, selectionText, linkURL, editFlags } = params;
  const template: MenuItemConstructorOptions[] = [];
  if (copyableLink(linkURL))
    template.push({
      label: t("Copy Link Address"),
      click: () => clipboard.writeText(linkURL),
    });
  if (isEditable) template.push({ role: "cut", label: t("Cut"), enabled: editFlags.canCut });
  if (isEditable || selectionText.length > 0)
    template.push({ role: "copy", label: t("Copy"), enabled: editFlags.canCopy });
  if (isEditable) template.push({ role: "paste", label: t("Paste"), enabled: editFlags.canPaste });
  if (template.length) template.push({ type: "separator" });
  template.push({ role: "selectAll", label: t("Select All"), enabled: editFlags.canSelectAll });
  return template;
}
