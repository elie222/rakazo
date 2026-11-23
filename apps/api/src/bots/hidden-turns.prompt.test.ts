import { describe, expect, it } from "vitest";
import { botIntroPrompt, HANG_UP_PROMPT, mcpConnectedPrompt } from "./hidden-turns.prompt.js";

describe("hidden turn prompts", () => {
  it("renders the creation intro with every tool and with none", () => {
    expect(
      botIntroPrompt({ userName: "Ada", spaceName: "Ops", disabledBuiltinTools: [] }),
    ).toMatchInlineSnapshot(`
      "You were just created. Ada made you. Their team space is called "Ops".
      Call ask_user right away, with no text before it. Its question greets them by first name in a few words and asks what they want you for, with two to four short options that fit your name, anything your description or instructions already say, and what you know about them, never a stock list. They can also type their own answer.
      If your profile already makes that clear, say in one line what you will do instead of asking.
      Once you know what you are for, use update_bot to set what is already clear: a one-line description of what you do, your instructions on how you do it, and a short name if yours is still a placeholder like "New Bot". Leave anything vague unset to fill in later as the work becomes clearer, and otherwise keep your name and look.
      Then get started, asking one follow-up only if you cannot start without it."
    `);
    expect(
      botIntroPrompt({
        userName: "",
        spaceName: null,
        disabledBuiltinTools: ["ask_user", "update_bot"],
      }),
    ).toMatchInlineSnapshot(`
      "You were just created.
      Greet them in a few words and ask in one sentence what they want you for, suggesting two to four short options that fit your name, anything your description or instructions already say, and what you know about them, never a stock list.
      If your profile already makes that clear, say in one line what you will do instead of asking.
      Then get started, asking one follow-up only if you cannot start without it."
    `);
  });

  it("does not ask for a first name it does not have", () => {
    const withName = botIntroPrompt({ userName: "Ada", spaceName: null, disabledBuiltinTools: [] });
    const noName = botIntroPrompt({ userName: "", spaceName: null, disabledBuiltinTools: [] });
    expect(withName).toContain("greets them by first name");
    expect(noName).toContain("Its question greets them in a few words");
    expect(noName).not.toContain("first name");
  });

  it("renders the hang-up and connected-server turns", () => {
    expect(HANG_UP_PROMPT).toMatchInlineSnapshot(
      `"The voice call just ended because the user hung up. First call end_call with a short title for the call (leave farewell empty). Then, if anything the user asked for during the call is still unfinished, complete it now as a normal chat reply with full formatting. If nothing is pending, reply with one short sentence."`,
    );
    expect(mcpConnectedPrompt('Docs "beta"')).toMatchInlineSnapshot(
      `"The user just connected the MCP server "Docs \\"beta\\"" from its approval card, so its tools are available now. Carry on with what they asked for. If nothing is left to do, confirm in one short sentence."`,
    );
  });
});
