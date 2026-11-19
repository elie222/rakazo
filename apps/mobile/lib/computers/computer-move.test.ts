import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), alert: vi.fn() }));
vi.mock("../api/api", () => ({ rpc: mocks.rpc }));
vi.mock("react-native", () => ({ Alert: { alert: mocks.alert } }));

import { askComputerMoveFiles } from "./computer-move";

type Button = { text: string; onPress: () => void };

/** The alert shown, once the server has said what the other computer holds. */
async function shown() {
  await vi.waitFor(() => expect(mocks.alert).toHaveBeenCalledOnce());
  const [title, message, buttons, options] = mocks.alert.mock.calls[0]! as [
    string,
    string | undefined,
    Button[],
    { onDismiss: () => void },
  ];
  const press = (text: string) => buttons.find((button) => button.text === text)!.onPress();
  return { title, message, labels: buttons.map((button) => button.text), press, options };
}

afterEach(() => {
  mocks.rpc.mockReset();
  mocks.alert.mockReset();
});

it("asks whether the bot's files come along to its own computer", async () => {
  mocks.rpc.mockResolvedValue({ replacesFiles: false });
  const answer = askComputerMoveFiles({ botId: "bot-1", botName: "Ada", mode: "dedicated" });
  const alert = await shown();
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("bots/computerMove", {
    botId: "bot-1",
    mode: "dedicated",
  });
  expect(alert.title).toBe("Bring Ada's files from the Team Computer?");
  expect(alert.message).toBeUndefined();
  expect(alert.labels).toEqual(["Cancel", "Start empty", "Bring files"]);
  alert.press("Bring files");
  await expect(answer).resolves.toBe("bring");
});

it("says when the files replace an older copy on the Team Computer", async () => {
  mocks.rpc.mockResolvedValue({ replacesFiles: true });
  const answer = askComputerMoveFiles({ botId: "bot-1", botName: "Ada", mode: "team" });
  const alert = await shown();
  expect(alert.title).toBe("Bring Ada's files from its own computer?");
  expect(alert.message).toBe("They replace the older files on the Team Computer.");
  alert.press("Start empty");
  await expect(answer).resolves.toBe("leave");
});

it("moves nothing when the question is cancelled or dismissed", async () => {
  mocks.rpc.mockResolvedValue({ replacesFiles: false });
  const cancelled = askComputerMoveFiles({ botId: "bot-1", botName: "Ada", mode: "dedicated" });
  (await shown()).press("Cancel");
  await expect(cancelled).resolves.toBeNull();
  mocks.alert.mockReset();
  const dismissed = askComputerMoveFiles({ botId: "bot-1", botName: "Ada", mode: "dedicated" });
  (await shown()).options.onDismiss();
  await expect(dismissed).resolves.toBeNull();
});

it("still asks when the server cannot say what the other computer holds", async () => {
  mocks.rpc.mockRejectedValue(new Error("offline"));
  const answer = askComputerMoveFiles({ botId: "bot-1", botName: "Ada", mode: "dedicated" });
  const alert = await shown();
  expect(alert.message).toBeUndefined();
  alert.press("Bring files");
  await expect(answer).resolves.toBe("bring");
});
