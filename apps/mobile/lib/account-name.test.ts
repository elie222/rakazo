import { expect, it, vi } from "vitest";
import { createAccountNameEditor } from "./account-name-editor";

function nameEditor(os: "ios" | "android" = "android", currentName = "Old Name") {
  const dependencies = {
    currentName,
    pending: { current: false },
    saveVersion: { current: 0 },
    Platform: { OS: os },
    Alert: { alert: vi.fn(), prompt: vi.fn() },
    setNameDraft: vi.fn(),
    setNamePending: vi.fn(),
    setNameError: vi.fn(),
    setNameDialogOpen: vi.fn(),
    updateAccountName: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    refresh: vi.fn<() => Promise<unknown>>().mockResolvedValue({}),
    onSaved: vi.fn(),
    onRefreshed: vi.fn(),
    errorText: (_error: unknown, fallback: string) => fallback,
    t: (value: string) => value,
  };
  return { ...dependencies, ...createAccountNameEditor(dependencies) };
}

it("saves the trimmed name, closes the dialog, and ignores a failed refresh", async () => {
  const editor = nameEditor();
  let rejectRefresh!: (error: Error) => void;
  editor.refresh.mockReturnValue(
    new Promise((_resolve, reject) => {
      rejectRefresh = reject;
    }),
  );
  await editor.saveName("  Sam Rivera  ");
  expect(editor.updateAccountName).toHaveBeenCalledWith("Sam Rivera");
  expect(editor.setNameDialogOpen).toHaveBeenCalledExactlyOnceWith(false);
  expect(editor.setNamePending).toHaveBeenLastCalledWith(false);
  expect(editor.refresh).toHaveBeenCalledWith();
  rejectRefresh(new Error("offline"));
  await Promise.resolve();
  await Promise.resolve();
  expect(editor.setNameError).toHaveBeenCalledExactlyOnceWith(null);
  expect(editor.onSaved).toHaveBeenCalledExactlyOnceWith("Sam Rivera");
});

it("updates the account data when refresh succeeds", async () => {
  const editor = nameEditor();
  const me = { name: "Sam Rivera" };
  editor.refresh.mockResolvedValue(me);
  await editor.saveName("Sam Rivera");
  expect(editor.onRefreshed).toHaveBeenCalledWith(me);
  expect(editor.setNameDialogOpen).toHaveBeenCalledWith(false);
});

it("ignores a refresh from an earlier save across editor renders", async () => {
  const editor = nameEditor();
  let finishFirstRefresh!: (account: unknown) => void;
  editor.refresh.mockReturnValueOnce(
    new Promise((resolve) => {
      finishFirstRefresh = resolve;
    }),
  );
  await editor.saveName("First Name");
  const nextEditor = createAccountNameEditor({ ...editor, currentName: "First Name" });
  const latestAccount = { name: "Latest Name" };
  editor.refresh.mockResolvedValueOnce(latestAccount);
  await nextEditor.saveName("Latest Name");
  finishFirstRefresh({ name: "First Name" });
  await Promise.resolve();
  expect(editor.onSaved.mock.calls).toEqual([["First Name"], ["Latest Name"]]);
  expect(editor.onRefreshed).toHaveBeenCalledExactlyOnceWith(latestAccount);
});

it("closes without saving when the name is unchanged or blank", async () => {
  const editor = nameEditor();
  await editor.saveName(" Old Name ");
  expect(editor.setNameDialogOpen).toHaveBeenCalledWith(false);
  await editor.saveName("   ");
  expect(editor.updateAccountName).not.toHaveBeenCalled();
});

it("keeps the Android dialog open with an inline error when saving fails", async () => {
  const editor = nameEditor("android");
  editor.updateAccountName.mockRejectedValue(new Error("offline"));
  await editor.saveName("Sam Rivera");
  expect(editor.setNameDialogOpen).not.toHaveBeenCalled();
  expect(editor.refresh).not.toHaveBeenCalled();
  expect(editor.setNameError).toHaveBeenLastCalledWith("Could not update name");
  expect(editor.Alert.alert).not.toHaveBeenCalled();
  expect(editor.setNamePending).toHaveBeenLastCalledWith(false);
  expect(editor.setNameDraft).not.toHaveBeenCalled();
});

it("reopens the iOS prompt with the exact failed draft and error", async () => {
  const editor = nameEditor("ios");
  editor.updateAccountName.mockRejectedValue(new Error("offline"));
  await editor.saveName(" New name ");
  expect(editor.Alert.alert).not.toHaveBeenCalled();
  expect(editor.Alert.prompt.mock.lastCall).toMatchObject({
    1: "Could not update name",
    4: " New name ",
  });
  expect(editor.pending.current).toBe(false);
  editor.updateAccountName.mockResolvedValue(undefined);
  await editor.Alert.prompt.mock.lastCall![2][1].onPress(" New name ");
  expect(editor.onSaved).toHaveBeenCalledWith("New name");
});

it("reopens overlong iOS drafts without saving and accepts 80 trimmed characters", async () => {
  const editor = nameEditor("ios");
  const draft = ` ${"a".repeat(81)} `;
  await editor.saveName(draft);
  expect(editor.updateAccountName).not.toHaveBeenCalled();
  expect(editor.Alert.prompt.mock.lastCall).toMatchObject({
    1: "Use 80 characters or fewer",
    4: draft,
  });
  await editor.saveName(` ${"a".repeat(80)} `);
  expect(editor.updateAccountName).toHaveBeenCalledWith("a".repeat(80));
});

it.each(["   ", " Old Name "])("closes iOS without reopening for %j", async (draft) => {
  const editor = nameEditor("ios");
  await editor.saveName(draft);
  expect(editor.Alert.prompt).not.toHaveBeenCalled();
  expect(editor.updateAccountName).not.toHaveBeenCalled();
});

it("ignores duplicate submissions and dismissal during a save", async () => {
  const editor = nameEditor();
  let finish!: () => void;
  editor.updateAccountName.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const saving = editor.saveName("New name");
  await editor.saveName("Another name");
  editor.closeNameDialog();
  expect(editor.updateAccountName).toHaveBeenCalledOnce();
  expect(editor.setNameDialogOpen).not.toHaveBeenCalled();
  finish();
  await saving;
});

it("opens the system prompt prefilled on iOS and saves its value", async () => {
  const editor = nameEditor("ios");
  editor.editName();
  expect(editor.setNameDialogOpen).not.toHaveBeenCalled();
  const [title, message, buttons, type, value] = editor.Alert.prompt.mock.calls[0]!;
  expect([title, message, type, value]).toEqual(["Edit name", undefined, "plain-text", "Old Name"]);
  expect(buttons[0].style).toBe("cancel");
  expect(buttons[0].onPress).toBeUndefined();
  expect(buttons[1].isPreferred).toBe(true);
  expect(buttons.map((b: { text: string }) => b.text)).toEqual(["Cancel", "Save"]);
  await buttons[1].onPress(" Sam Rivera ");
  expect(editor.updateAccountName).toHaveBeenCalledWith("Sam Rivera");
});

it("opens the Android dialog prefilled", () => {
  const editor = nameEditor("android");
  editor.editName();
  expect(editor.Alert.prompt).not.toHaveBeenCalled();
  expect(editor.setNameDraft).toHaveBeenCalledWith("Old Name");
  expect(editor.setNameError).toHaveBeenCalledWith(null);
  expect(editor.setNameDialogOpen).toHaveBeenCalledWith(true);
});
