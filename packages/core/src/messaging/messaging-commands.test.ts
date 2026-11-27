import { expectLinearTime } from "@rakazo/contracts/test-timing";
import { describe, expect, it } from "vitest";
import { parseMessagingCommand } from "./messaging-commands.js";

describe("parseMessagingCommand", () => {
  it("parses the minimal command set case-insensitively", () => {
    expect(parseMessagingCommand("YES")).toBe("approve");
    expect(parseMessagingCommand("yes")).toBe("approve");
    expect(parseMessagingCommand(" yes ")).toBe("approve");
    expect(parseMessagingCommand("NO")).toBe("decline");
    expect(parseMessagingCommand("no")).toBe("decline");
    expect(parseMessagingCommand("LEAVE")).toBe("leave");
    expect(parseMessagingCommand("leave")).toBe("leave");
  });

  it("stays fast on long runs of punctuation, commas, and slashes", () => {
    expectLinearTime(() => {
      expect(parseMessagingCommand(`${"!".repeat(200_000)}a`)).toBeNull();
      expect(parseMessagingCommand(`${",".repeat(200_000)}stop`)).toBeNull();
      expect(parseMessagingCommand(`stop${",".repeat(200_000)}now`)).toBeNull();
      expect(parseMessagingCommand(`${"/".repeat(200_000)}stop`)).toBeNull();
      expect(parseMessagingCommand(`stop${"!".repeat(200_000)}`)).toBe("stop");
    });
  });

  it("reads bare stop imperatives and slash cancel commands across app languages", () => {
    for (const text of [
      "stop",
      "Stop now.",
      "STOP!",
      "  stop   now ",
      "stop…",
      "stop it",
      "stop this",
      "stop that",
      "stop all",
      "stop everything",
      "please stop",
      "stop please",
      "stop, now",
      "stop, please",
      "please, stop",
      "abort",
      "halt",
      "/stop",
      "/stop!",
      "/cancel",
      "/cancel all",
      "/abort",
      // Polish (with and without diacritics, plus NFD)
      "zatrzymaj",
      "zatrzymaj to",
      "zatrzymaj wszystko",
      "zatrzymaj się",
      "zatrzymaj sie",
      "przestań",
      "przestan",
      "przestan\u0301",
      "/anuluj",
      "przerwij",
      "przerwij to",
      "stop teraz",
      // Other app languages
      "Stopp!",
      "stopp es",
      "/abbrechen",
      "detente",
      "¡Detente!",
      "detente ya",
      "/cancelar",
      "stop nu",
      "stop ermee",
      "/annuleer",
      "Стоп",
      "/отмена",
      "/отмени",
      "прекрати",
      "停止。",
      "/キャンセル",
      "中止",
      "やめて",
      "停下！",
      "/取消",
      "别做了",
      "Arrête !",
      "arrete",
      "arrête ça",
      "arrete ca",
      "/annule",
      "/annuler",
      "pare",
      "멈춰",
      "/취소",
      "그만",
      "Dur.",
      "durdur",
      "/iptal",
      "/İptal",
      "रुको",
      "/रद्द करो",
      "बंद करो",
      "עצור",
      "/בטל",
      "/ยกเลิก",
    ])
      expect(parseMessagingCommand(text), text).toBe("stop");
    for (const text of [
      // Bare cancel replies can answer a bot's question (e.g. "Should I cancel the meeting?").
      "cancel",
      "cancel it",
      "cancel this",
      "cancel that",
      "cancel all",
      "anuluj",
      "anuluj to",
      "abbrechen",
      "cancelar",
      "annuler",
      "annuleer",
      "отмена",
      "キャンセル",
      "取消",
      "취소",
      "iptal",
      "İptal",
      "रद्द करो",
      "בטל",
      "ยกเลิก",
      "para",
      "¿Para?",
      "stopper",
      "don't stop",
      "do not cancel",
      "stop by the store",
      "can you stop this timer?",
      "cancel my flight",
      "why did it stop?",
      "nie zatrzymuj",
      "nie przerywaj",
      "//stop",
      "//cancel",
      "/ stop",
      "stop,",
      ", stop",
      "stop,, now",
    ])
      expect(parseMessagingCommand(text), text).toBeNull();
  });

  it("recognizes standalone Thai stop commands", () => {
    expect(parseMessagingCommand("หยุด")).toBe("stop");
    expect(parseMessagingCommand("หยุด!")).toBe("stop");
    expect(parseMessagingCommand("วันหยุด")).toBeNull();
    expect(parseMessagingCommand("หยุดพัก")).toBeNull();
    expect(parseMessagingCommand("ฉันจะหยุดพรุ่งนี้")).toBeNull();
  });

  it("treats everything else as a normal message", () => {
    expect(parseMessagingCommand("yes please")).toBeNull();
    expect(parseMessagingCommand("YES!")).toBeNull();
    expect(parseMessagingCommand("")).toBeNull();
    expect(parseMessagingCommand("hello")).toBeNull();
    expect(parseMessagingCommand("leave the group")).toBeNull();
  });
});
