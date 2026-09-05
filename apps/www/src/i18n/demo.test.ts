import { describe, expect, it } from "vitest";
import { DEMO_BOTS } from "../demo";
import { demoText, getDemoBots } from "./demo";

describe("Chinese product demo", () => {
  it("localizes every display-bearing field in the seeded demo data", () => {
    const localized = getDemoBots("zh");

    expect(localized).toHaveLength(DEMO_BOTS.length);
    for (const [index, source] of DEMO_BOTS.entries()) {
      const translated = localized[index];
      expect(translated).toBeDefined();
      if (!translated) continue;

      expect(translated.time).not.toBe(source.time);
      expect(translated.preview).not.toBe(source.preview);
      expect(translated.reply).not.toBe(source.reply);
      expect(translated.screen.title).not.toBe(source.screen.title);
      expect(translated.screen.lines).toHaveLength(source.screen.lines.length);
      source.screen.lines.forEach((line, lineIndex) => {
        expect(translated.screen.lines[lineIndex]).toBeDefined();
        expect(translated.screen.lines[lineIndex]).not.toBe(line);
      });
      expect(translated.routines).toHaveLength(source.routines.length);
      source.routines.forEach((routine, routineIndex) => {
        expect(translated.routines[routineIndex]?.name).toBeDefined();
        expect(translated.routines[routineIndex]?.name).not.toBe(routine.name);
      });
      expect(translated.thread).toHaveLength(source.thread.length);
      source.thread.forEach((message, messageIndex) => {
        const localizedMessage = translated.thread[messageIndex];
        expect(localizedMessage).toBeDefined();
        expect(localizedMessage?.type).toBe(message.type);
        if (!localizedMessage || message.type === "typing" || localizedMessage.type === "typing") {
          return;
        }
        if (message.type === "card" && localizedMessage.type === "card") {
          expect(localizedMessage.lines).toHaveLength(message.lines.length);
          message.lines.forEach((line, lineIndex) => {
            expect(localizedMessage.lines[lineIndex]).toBeDefined();
            expect(localizedMessage.lines[lineIndex]?.k).not.toBe(line.k);
            expect(localizedMessage.lines[lineIndex]?.v).not.toBe(line.v);
          });
          return;
        }
        if ("text" in message && "text" in localizedMessage) {
          expect(localizedMessage.text).not.toBe(message.text);
        }
      });
    }
  });

  it("translates seeded custom schedules for display without rewriting them to daily 9:00 AM", () => {
    const localized = getDemoBots("zh");
    const schedules = localized.flatMap((bot) => bot.routines.map((routine) => routine.when));
    // English `when` stays on the bot so ProductDemo parseWhen still works when editing.
    expect(schedules).toContain("Tue + Thu");
    expect(schedules).toContain("Last Friday");
    // displayedWhen uses demoText(locale, when) for the list label.
    expect(demoText("zh", "Tue + Thu")).toBe("周二和周四");
    expect(demoText("zh", "Last Friday")).toBe("每月最后一个周五");
    expect(demoText("zh", "Tue + Thu")).not.toBe("每天 9:00 AM");
    expect(demoText("zh", "Last Friday")).not.toBe("每天 9:00 AM");
  });

  it("translates routine instructions when present", () => {
    const source = DEMO_BOTS.flatMap((bot) =>
      bot.routines.map((routine) => routine.instruction).filter(Boolean),
    );
    const localized = getDemoBots("zh").flatMap((bot) =>
      bot.routines.map((routine) => routine.instruction).filter(Boolean),
    );
    for (const [index, instruction] of source.entries()) {
      expect(localized[index]).toBe(demoText("zh", instruction as string));
    }
  });

  it("formats localized interactive labels without losing values", () => {
    expect(demoText("zh", "Message {name}", { name: "Inbox Manager" })).toBe(
      "给 Inbox Manager 发消息",
    );
    expect(demoText("zh", "{answer} is a sweet spot for me.", { answer: "调研和写作" })).toBe(
      "调研和写作正是我擅长的。",
    );
    expect(demoText("en", "Message {name}", { name: "Inbox Manager" })).toBe(
      "Message Inbox Manager",
    );
  });
});
