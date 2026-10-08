import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const screen = readFileSync(resolve(mobileRoot, "app/(settings)/account.tsx"), "utf8");

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
    expect(row).toContain("onSubmit: (password) => void handleDeletion(password, true)");
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
    expect(deletion).toContain('replaceWithSignIn("/sign-in")');
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

// Execute the screen's submit handler with native/session dependencies replaced.
// This exercises expiry during the open dialog without loading native modules.
const deletionHandler = sliceBetween(
  screen,
  "  async function handleDeletion(",
  "\n  return (",
).replace("password: string", "password");
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor;
function deletionHarness(freshOidcAuth: boolean, codeSent = false) {
  const fetchAccountSecurity = vi.fn(async () => ({ hasPassword: false, freshOidcAuth }));
  const deleteAccount = vi.fn();
  const setSecurity = vi.fn();
  const setSsoReauthenticated = vi.fn();
  const setPending = vi.fn();
  const setDeleteOpen = vi.fn();
  const replaceWithSignIn = vi.fn();
  const dependencies = {
    security: { hasPassword: false },
    ssoReauthenticated: true,
    pending: false,
    deletionCodeSent: codeSent,
    fetchAccountSecurity,
    deleteAccount,
    setSecurity,
    setSsoReauthenticated,
    setPending,
    setDeleteOpen,
    setDeleteError: vi.fn(),
    replaceWithSignIn,
    errorText: vi.fn(),
    t: (value: string) => value,
  };
  const run = new AsyncFunction(
    ...Object.keys(dependencies),
    "password",
    `${deletionHandler}; await handleDeletion(password);`,
  );
  return {
    ...dependencies,
    submit: (password = "") => run(...Object.values(dependencies), password),
  };
}
it("refreshes an expired proof and keeps the deletion dialog open", async () => {
  const h = deletionHarness(false);
  await h.submit();
  expect(h.fetchAccountSecurity).toHaveBeenCalledOnce();
  expect(h.setSsoReauthenticated).toHaveBeenCalledWith(false);
  expect(h.setSecurity).toHaveBeenCalledWith({ hasPassword: false, freshOidcAuth: false });
  expect(h.deleteAccount).not.toHaveBeenCalled();
  expect(h.setDeleteOpen).not.toHaveBeenCalled();
  expect(h.replaceWithSignIn).not.toHaveBeenCalled();
  expect(h.setPending).toHaveBeenLastCalledWith(false);
});
it.each([true, false])(
  "submits only a refreshed proof or deletion code (fresh: %s)",
  async (fresh) => {
    const h = deletionHarness(fresh, !fresh);
    await h.submit(fresh ? "" : " 123456 ");
    expect(h.fetchAccountSecurity).toHaveBeenCalledOnce();
    expect(h.deleteAccount).toHaveBeenCalledWith(undefined, fresh ? undefined : "123456");
    expect(h.replaceWithSignIn).toHaveBeenCalledWith("/sign-in");
  },
);
it("does not submit whitespace as a deletion code after expiry", async () => {
  const h = deletionHarness(false, true);
  await h.submit("   ");
  expect(h.deleteAccount).not.toHaveBeenCalled();
});

it.each([undefined, true, false])(
  "mobile respects password-change policy (%s) while retaining password deletion",
  (enabled) => {
    const expression = screen.match(/const canChangePassword = ([^;]+);/)![1]!;
    const canChange = new Function("security", `return ${expression}`);
    expect(canChange({ hasPassword: true, passwordChangeEnabled: enabled })).toBe(
      enabled !== false,
    );
    expect(canChange({ hasPassword: false, passwordChangeEnabled: enabled })).toBe(false);
    const action = screen.indexOf('title={t("Change password")}');
    expect(
      screen.slice(screen.lastIndexOf("{", screen.lastIndexOf("<SettingsRow", action)), action),
    ).toContain("canChangePassword");
    expect(deletionHandler).toContain("hasPassword = security?.hasPassword === true");
  },
);
