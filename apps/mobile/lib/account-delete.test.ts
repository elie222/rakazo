import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const screen = readFileSync(resolve(mobileRoot, "app/account.tsx"), "utf8");

function sliceBetween(source: string, start: string, end: string) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("Account delete", () => {
  it("uses one destructive row and asks for the password only after it is tapped", () => {
    expect(screen).not.toContain("dangerZone");
    expect(screen).not.toContain("styles.deleteButton");
    expect(screen).not.toContain("styles.password");
    const row = sliceBetween(screen, "function requestDeletion(", "function applyLocale(");
    expect(row).toContain("promptAccountDeletion({");
    expect(row).toContain('deleteLabel: t("Delete")');
    expect(row).toContain("onSubmit: (password) => void handleDeletion(password)");
    expect(row).toContain("setDeleteOpen(true)");
    const press = screen.indexOf("onPress={requestDeletion}");
    expect(screen.slice(screen.lastIndexOf("<SettingsRow", press), press)).toContain("destructive");
    const visible = sliceBetween(screen, "onPress={requestDeletion}", "{deleteOpen ?");
    expect(visible).toContain('t("Delete account")');
    expect(visible).not.toContain("secureTextEntry");
    expect(visible).not.toContain("<TextInput");
  });

  it("keeps the password check, shows the failure, and signs out after a successful delete", () => {
    const deletion = sliceBetween(screen, "async function handleDeletion(", "return (");
    expect(deletion).toContain("await deleteAccount(password)");
    expect(deletion).toContain('router.replace("/sign-in")');
    expect(deletion).toContain('t("Could not delete account")');
    expect(deletion).toContain("setDeleteError");
    const dialog = sliceBetween(screen, "{deleteOpen ?", "</Modal>");
    expect(dialog).toContain("secureTextEntry");
    expect(dialog).toContain('t("Current password")');
    expect(dialog).toContain('t("Delete")');
    expect(dialog).toContain('accessibilityRole="alert"');
    expect(dialog).toContain("deleteError");
    expect(dialog).toContain("void handleDeletion(deletePassword)");
    expect(dialog).toContain('keyboardShouldPersistTaps="handled"');
    expect(dialog).toContain("<ScrollView");
    expect(dialog).toContain("styles.dialogAction");
  });

  it("shows sign-out failures next to Sign out and deletion failures on the delete row", () => {
    const signOut = sliceBetween(
      screen,
      "async function handleSignOut(",
      "async function updateNotifications(",
    );
    expect(signOut).toContain("setSignOutError");
    expect(signOut).toContain('t("Could not sign out")');
    expect(signOut).not.toContain("setDeleteError");
    const signOutControl = sliceBetween(screen, 't("Sign out")', 't("Archived bots")');
    expect(signOutControl).toContain("signOutError");
    expect(signOutControl).toContain('accessibilityRole="alert"');
    expect(signOutControl).not.toContain("deleteError");
    const visible = sliceBetween(screen, "onPress={requestDeletion}", "{deleteOpen ?");
    expect(visible).toContain("deleteError");
    expect(visible).not.toContain("signOutError");
    const actions = sliceBetween(screen, "dialogAction: {", "dialogCancel:");
    expect(actions).toContain("minHeight: 48");
    const scroll = sliceBetween(screen, "dialogScroll: {", "dialog: {");
    expect(scroll).toContain('maxHeight: "100%"');
    expect(scroll).toContain("flexShrink: 1");
  });
});
