import { i18n } from "@lingui/core";
import { beforeEach, describe, expect, it } from "vitest";
import de from "../../scripts/translations-de.json";
import es from "../../scripts/translations-es.json";
import hi from "../../scripts/translations-hi.json";
import ko from "../../scripts/translations-ko.json";
import ptBR from "../../scripts/translations-pt-BR.json";
import tr from "../../scripts/translations-tr.json";
import zhCN from "../../scripts/translations-zh-CN.json";

describe("lingui catalogs", () => {
  beforeEach(() => {
    i18n.load("en", {});
    i18n.activate("en");
  });

  it("falls back to the English source message when a translation is missing", () => {
    i18n.load("de", {});
    i18n.activate("de");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("Settings");
    expect(
      i18n._({
        id: "Cancel new bot",
        message: "Cancel new bot",
      }),
    ).toBe("Cancel new bot");
  });

  it("formats ICU cron-style messages with reordered placeholders", () => {
    i18n.load("de", {
      "every {intervalAmountSelect} {intervalUnitSelect}":
        "alle {intervalAmountSelect} {intervalUnitSelect}",
      "at {timeSelect}": "um {timeSelect}",
    });
    i18n.activate("de");
    expect(
      i18n._({
        id: "every {intervalAmountSelect} {intervalUnitSelect}",
        message: "every {intervalAmountSelect} {intervalUnitSelect}",
        values: { intervalAmountSelect: "5", intervalUnitSelect: "minutes" },
      }),
    ).toBe("alle 5 minutes");
    expect(
      i18n._({
        id: "at {timeSelect}",
        message: "at {timeSelect}",
        values: { timeSelect: "9:00 AM" },
      }),
    ).toBe("um 9:00 AM");

    i18n.load("ko", {
      "every {intervalAmountSelect} {intervalUnitSelect}":
        "{intervalAmountSelect} {intervalUnitSelect}마다",
      "at {timeSelect}": "{timeSelect}에",
    });
    i18n.activate("ko");
    expect(
      i18n._({
        id: "every {intervalAmountSelect} {intervalUnitSelect}",
        message: "every {intervalAmountSelect} {intervalUnitSelect}",
        values: { intervalAmountSelect: "5", intervalUnitSelect: "분" },
      }),
    ).toBe("5 분마다");

    i18n.load("tr", {
      "every {intervalAmountSelect} {intervalUnitSelect}":
        "her {intervalAmountSelect} {intervalUnitSelect}",
      "at {timeSelect}": "saat {timeSelect}",
    });
    i18n.activate("tr");
    expect(
      i18n._({
        id: "every {intervalAmountSelect} {intervalUnitSelect}",
        message: "every {intervalAmountSelect} {intervalUnitSelect}",
        values: { intervalAmountSelect: "5", intervalUnitSelect: "dakika" },
      }),
    ).toBe("her 5 dakika");
    expect(
      i18n._({
        id: "at {timeSelect}",
        message: "at {timeSelect}",
        values: { timeSelect: "09:00" },
      }),
    ).toBe("saat 09:00");

    i18n.load("hi", {
      "every {intervalAmountSelect} {intervalUnitSelect}":
        "हर {intervalAmountSelect} {intervalUnitSelect}",
      "at {timeSelect}": "{timeSelect} बजे",
    });
    i18n.activate("hi");
    expect(
      i18n._({
        id: "every {intervalAmountSelect} {intervalUnitSelect}",
        message: "every {intervalAmountSelect} {intervalUnitSelect}",
        values: { intervalAmountSelect: "5", intervalUnitSelect: "मिनट" },
      }),
    ).toBe("हर 5 मिनट");
    expect(
      i18n._({
        id: "at {timeSelect}",
        message: "at {timeSelect}",
        values: { timeSelect: "09:00" },
      }),
    ).toBe("09:00 बजे");

    i18n.load("zh-CN", {
      "every {intervalAmountSelect} {intervalUnitSelect}":
        "每 {intervalAmountSelect} {intervalUnitSelect}",
      "at {timeSelect}": "{timeSelect}",
      "{0, plural, one {# model} other {# models}}": "{0, plural, one {# 个模型} other {# 个模型}}",
      "{botName} · {0, plural, one {# peer} other {# peers}}":
        "{botName} · {0, plural, one {# 个同事 Bot} other {# 个同事 Bot}}",
    });
    i18n.activate("zh-CN");
    expect(
      i18n._({
        id: "every {intervalAmountSelect} {intervalUnitSelect}",
        message: "every {intervalAmountSelect} {intervalUnitSelect}",
        values: { intervalAmountSelect: "5", intervalUnitSelect: "分钟" },
      }),
    ).toBe("每 5 分钟");
    expect(
      i18n._({
        id: "at {timeSelect}",
        message: "at {timeSelect}",
        values: { timeSelect: "09:00" },
      }),
    ).toBe("09:00");
    expect(
      i18n._({
        id: "{0, plural, one {# model} other {# models}}",
        message: "{0, plural, one {# model} other {# models}}",
        values: { 0: 1 },
      }),
    ).toBe("1 个模型");
    expect(
      i18n._({
        id: "{0, plural, one {# model} other {# models}}",
        message: "{0, plural, one {# model} other {# models}}",
        values: { 0: 3 },
      }),
    ).toBe("3 个模型");
    expect(
      i18n._({
        id: "{botName} · {0, plural, one {# peer} other {# peers}}",
        message: "{botName} · {0, plural, one {# peer} other {# peers}}",
        values: { botName: "Scout", 0: 2 },
      }),
    ).toBe("Scout · 2 个同事 Bot");

    i18n.load("es", {
      "every {intervalAmountSelect} {intervalUnitSelect}":
        "cada {intervalAmountSelect} {intervalUnitSelect}",
      "at {timeSelect}": "a las {timeSelect}",
    });
    i18n.activate("es");
    expect(
      i18n._({
        id: "every {intervalAmountSelect} {intervalUnitSelect}",
        message: "every {intervalAmountSelect} {intervalUnitSelect}",
        values: { intervalAmountSelect: "5", intervalUnitSelect: "minutos" },
      }),
    ).toBe("cada 5 minutos");
    expect(
      i18n._({
        id: "at {timeSelect}",
        message: "at {timeSelect}",
        values: { timeSelect: "09:00" },
      }),
    ).toBe("a las 09:00");
  });

  it("uses seeded catalog strings for German, Korean, Turkish, Hindi, Brazilian Portuguese, Simplified Chinese, and Spanish chrome", () => {
    i18n.load("de", de as Record<string, string>);
    i18n.activate("de");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("Einstellungen");
    expect(i18n._({ id: "Cancel", message: "Cancel" })).toBe("Abbrechen");

    i18n.load("ko", ko as Record<string, string>);
    i18n.activate("ko");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("설정");
    expect(i18n._({ id: "Cancel", message: "Cancel" })).toBe("취소");

    i18n.load("tr", tr as Record<string, string>);
    i18n.activate("tr");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("Ayarlar");
    expect(i18n._({ id: "Cancel", message: "Cancel" })).toBe("İptal");

    i18n.load("hi", hi as Record<string, string>);
    i18n.activate("hi");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("सेटिंग्स");
    expect(i18n._({ id: "Cancel", message: "Cancel" })).toBe("रद्द करें");

    i18n.load("pt-BR", ptBR as Record<string, string>);
    i18n.activate("pt-BR");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("Configurações");
    expect(i18n._({ id: "Cancel", message: "Cancel" })).toBe("Cancelar");

    i18n.load("zh-CN", zhCN as Record<string, string>);
    i18n.activate("zh-CN");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("设置");
    expect(i18n._({ id: "Cancel", message: "Cancel" })).toBe("取消");

    i18n.load("es", es as Record<string, string>);
    i18n.activate("es");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("Configuración");
    expect(i18n._({ id: "Cancel", message: "Cancel" })).toBe("Cancelar");
  });
});
