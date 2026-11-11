import { expect, it } from "vitest";
import { createListRefresh } from "./list-refresh";

type Screen = {
  vault: string;
  changes: number;
  refresh: ReturnType<typeof createListRefresh<string>>;
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// Each row starts the screen, so its first read is out, does what it names while that read is
// out, then answers every read in turn ("read", or "fails") until none is left.
it.each<{
  state: string;
  during: (screen: Screen) => void;
  answers: ("read" | "fails")[];
  reads: string[];
  applied: string[];
}>([
  {
    state: "a request during an in-flight read",
    during: (screen) => screen.refresh.request(),
    answers: ["read", "read"],
    reads: ["account", "account"],
    applied: ["account", "account"],
  },
  {
    state: "a switch to another vault during a read",
    during: (screen) => {
      screen.vault = "space-work";
      screen.refresh.request();
    },
    answers: ["read", "read"],
    reads: ["account", "space-work"],
    applied: ["space-work"],
  },
  {
    state: "a save in the editor during a read",
    during: (screen) => {
      screen.changes += 1;
      screen.changes += 1;
      screen.refresh.request();
    },
    answers: ["read", "read"],
    reads: ["account", "account"],
    applied: ["account"],
  },
  {
    state: "a change made with no request during a read",
    during: (screen) => {
      screen.changes += 1;
    },
    answers: ["read", "read"],
    reads: ["account", "account"],
    applied: ["account"],
  },
  {
    state: "an import finishing during the read when the screen is shown",
    during: (screen) => {
      screen.changes += 1;
      screen.refresh.request();
    },
    answers: ["read", "read"],
    reads: ["account", "account"],
    applied: ["account"],
  },
  {
    state: "a failed read, then a successful one",
    during: (screen) => screen.refresh.request(),
    answers: ["fails", "read"],
    reads: ["account", "account"],
    applied: ["failed", "account"],
  },
  {
    state: "a failed read the screen changed during",
    during: (screen) => {
      screen.changes += 1;
      screen.refresh.request();
    },
    answers: ["fails", "read"],
    reads: ["account", "account"],
    applied: ["account"],
  },
  {
    state: "two imports back to back during a read",
    during: (screen) => {
      screen.changes += 1;
      screen.refresh.request();
      screen.changes += 1;
      screen.refresh.request();
    },
    answers: ["read", "read"],
    reads: ["account", "account"],
    applied: ["account"],
  },
  {
    state: "leaving the screen and coming back during a read",
    during: (screen) => {
      screen.refresh.stop();
      screen.refresh.start();
    },
    answers: ["read", "read"],
    reads: ["account", "account"],
    applied: ["account"],
  },
  {
    state: "leaving the screen during a read, and a request once it's gone",
    during: (screen) => {
      screen.refresh.stop();
      screen.refresh.request();
    },
    answers: ["read"],
    reads: ["account"],
    applied: [],
  },
])("reads and applies the list as it should after $state", async (row) => {
  const reads: string[] = [];
  const applied: string[] = [];
  const answers: (() => void)[] = [];
  const screen = { vault: "account", changes: 0 } as Screen;
  screen.refresh = createListRefresh<string>({
    vault: () => screen.vault,
    changes: () => screen.changes,
    read: (vault) => {
      reads.push(vault);
      const answer = row.answers[reads.length - 1];
      return new Promise((resolve, reject) =>
        answers.push(() => (answer === "fails" ? reject(new Error("offline")) : resolve(vault))),
      );
    },
    apply: (read) => applied.push(read.ok ? read.value : "failed"),
  });
  screen.refresh.start();
  row.during(screen);
  for (let answered = 0; answered < answers.length; answered += 1) {
    expect(answers.length, "one read out at a time").toBe(answered + 1);
    answers[answered]!();
    await tick();
  }
  expect(reads).toEqual(row.reads);
  expect(applied).toEqual(row.applied);
});
