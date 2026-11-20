import { describe, expect, it } from "vitest";
import {
  connectedPluginsInstruction,
  taughtSkillsInstruction,
  workspaceInstruction,
} from "./run-instructions.prompt.js";

describe("connectedPluginsInstruction", () => {
  it("names each connected plugin and prefers its tools to browsing", () => {
    expect(
      connectedPluginsInstruction([
        { displayName: "Mail", connectorId: "apps", provider: "mail" },
        { displayName: "Code", connectorId: "apps", provider: "code" },
      ]),
    ).toBe(
      "Connected plugins: Mail (apps:mail), Code (apps:code). Prefer those plugin tools over the computer browser or web search when reading app data (repos, releases, mail, calendar, and similar).",
    );
  });

  it("says so when nothing is connected", () => {
    expect(connectedPluginsInstruction([])).toBe("No plugins are connected yet.");
  });
});

describe("taughtSkillsInstruction", () => {
  it("lists each taught skill with when to use it", () => {
    expect(
      taughtSkillsInstruction([
        { name: "File expenses", whenToUse: "When a receipt arrives" },
        { name: "Book travel", whenToUse: "Book a trip" },
      ]),
    ).toBe(
      "Saved taught skills:\n- File expenses: When a receipt arrives\n- Book travel: Book a trip\nWhen the user asks to run a taught skill by name, follow that skill's playbook exactly. The full playbook is included in the user task when they invoke it.",
    );
  });

  it("adds nothing when no skill was taught", () => {
    expect(taughtSkillsInstruction([])).toBeUndefined();
  });
});

describe("workspaceInstruction", () => {
  it("tells a bot on the Team Computer where its home folder is", () => {
    expect(
      workspaceInstruction({ mode: "team", botId: "bot1", runsOnUserMachine: false }),
    ).toContain("Your Team Computer home is bots/bot1.");
  });

  it("tells a bot on its own computer that it is there and that the whole workspace is its home", () => {
    expect(
      workspaceInstruction({ mode: "dedicated", botId: "bot1", runsOnUserMachine: false }),
    ).toBe(
      "You are on your own computer, not the Team Computer. This entire computer workspace is your private home. Relative file paths and shell working directories start at its root.",
    );
  });

  it("does not call a person's own machine the bot's computer", () => {
    expect(
      workspaceInstruction({ mode: "dedicated", botId: "bot1", runsOnUserMachine: true }),
    ).toBe(
      "This entire computer workspace is your private home. Relative file paths and shell working directories start at its root.",
    );
  });
});
