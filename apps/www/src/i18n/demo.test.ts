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
      source.screen.lines.forEach((line, lineIndex) => {
        expect(translated.screen.lines[lineIndex]).not.toBe(line);
      });
      source.routines.forEach((routine, routineIndex) => {
        expect(translated.routines[routineIndex]?.name).not.toBe(routine.name);
      });
      source.thread.forEach((message, messageIndex) => {
        const localizedMessage = translated.thread[messageIndex];
        expect(localizedMessage?.type).toBe(message.type);
        if (!localizedMessage || message.type === "typing" || localizedMessage.type === "typing") {
          return;
        }
        if (message.type === "card" && localizedMessage.type === "card") {
          message.lines.forEach((line, lineIndex) => {
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
