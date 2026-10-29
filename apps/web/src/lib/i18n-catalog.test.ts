import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { i18n } from "@lingui/core";
import { formatter } from "@lingui/format-po";
import { RUN_ERROR_LIMIT_MESSAGES } from "@rakazo/core";
import { beforeEach, describe, expect, it } from "vitest";
import { UI_LOCALES } from "./ui-locale";

describe("lingui catalogs", () => {
  it("translates sign-out failures in every supported language", () => {
    for (const locale of [
      "de",
      "es",
      "fr",
      "hi",
      "ja",
      "ko",
      "nl",
      "pt-BR",
      "ru",
      "tr",
      "zh-CN",
      "zh-TW",
    ]) {
      const catalog = readFileSync(
        fileURLToPath(new URL(`../locales/${locale}/messages.po`, import.meta.url)),
        "utf8",
      );
      const entry = catalog
        .split("\n\n")
        .find((block) => block.includes('msgid "Could not log out. Try again."\n'));
      const translated = entry?.split("msgstr ")[1];
      expect(translated, locale).toBeTruthy();
      expect(translated, locale).not.toBe('""');
      expect(translated, locale).not.toBe('"Could not log out. Try again."');
    }
  });

  it("localizes provider error guidance and retains its placeholders", () => {
    const messages = [
      ...Object.values(RUN_ERROR_LIMIT_MESSAGES).flatMap(Object.values),
      "{summary} Your backup models also failed.",
      "{summary} No backup model was usable for this request.",
      "{summary} Backup models failed or were unavailable for this request.",
      "Your OpenRouter",
      "Your OpenAI",
      "Your Anthropic",
      "Your model provider",
      "The model provider returned an error.",
      "Connect a model in Settings before running bots.",
      "Connect your own API key in Models or choose Rakazo credits in Billing.",
      "{provider} is rate limiting requests. Try again shortly.",
      "{summary} Resets {date}.",
      "{provider} rejected the API key. Check your connection settings.",
      "{provider} can't run this model.",
      "{provider} took too long to respond. Try again.",
      "{provider} is overloaded right now. Try again in a moment.",
      "{provider} couldn't be reached. Check that it's running.",
      "This conversation is too long for the model. Retrying won't help. Start a new chat or shorten your message.",
      "Details",
    ];
    for (const locale of [
      "de",
      "es",
      "fr",
      "he",
      "hi",
      "ja",
      "ko",
      "nl",
      "pt-BR",
      "ru",
      "tr",
      "zh-CN",
      "zh-TW",
    ]) {
      const catalog = readFileSync(
        fileURLToPath(new URL(`../locales/${locale}/messages.po`, import.meta.url)),
        "utf8",
      );
      for (const message of messages) {
        const entry = catalog
          .split("\n\n")
          .find((block) => block.includes(`msgid ${JSON.stringify(message)}\n`));
        const translated = entry?.split("msgstr ")[1];
        expect(translated, `${locale}: ${message}`).toBeTruthy();
        // "Details" is also the German and Dutch label.
        if ((locale !== "de" && locale !== "nl") || message !== "Details") {
          expect(translated, `${locale}: ${message}`).not.toBe(JSON.stringify(message));
        }
        for (const placeholder of message.match(/\{\w+\}/g) ?? []) {
          expect(translated).toContain(placeholder);
        }
      }
    }
  });

  it("translates bot settings labels and retains placeholders in every locale", () => {
    for (const locale of UI_LOCALES) {
      const catalog = readFileSync(
        fileURLToPath(new URL(`../locales/${locale}/messages.po`, import.meta.url)),
        "utf8",
      );
      for (const message of [
        "Advanced",
        "Notifications",
        "When it finishes or needs input",
        "Model",
        "Add open work",
        "Disable a tool",
        "Edit name",
        "Enable {0}",
        "Model connections",
        "Permissions",
        "Skills",
      ]) {
        const entry = catalog
          .split("\n\n")
          .find((block) => block.includes(`msgid ${JSON.stringify(message)}\n`));
        expect(entry, `${locale}: ${message}`).toMatch(/msgstr ".+"/);
        const translated = entry?.split("msgstr ")[1] ?? "";
        expect(translated.match(/\{\w+\}/g) ?? [], `${locale}: ${message}`).toEqual(
          message.match(/\{\w+\}/g) ?? [],
        );
      }
    }
  });

  beforeEach(() => {
    i18n.load("en", {});
    i18n.activate("en");
  });

  it("translates command credential controls in every locale", () => {
    const messages = [
      "Command variable",
      "Available to shell commands as {commandVariable}",
      "{commandVariable} is reserved and cannot be used as a command variable. Choose another name.",
      "Show",
      "Hide",
      "Could not show the credential",
    ];
    for (const locale of [
      "en",
      "de",
      "es",
      "fr",
      "he",
      "hi",
      "ja",
      "ko",
      "nl",
      "pt-BR",
      "ru",
      "tr",
      "zh-CN",
      "zh-TW",
    ]) {
      const catalog = readFileSync(
        fileURLToPath(new URL(`../locales/${locale}/messages.po`, import.meta.url)),
        "utf8",
      );
      for (const message of messages) {
        const entry = catalog
          .split("\n\n")
          .find((block) => block.includes(`msgid ${JSON.stringify(message)}\n`));
        expect(entry, `${locale}: ${message}`).toMatch(/msgstr ".+"/);
        if (message.includes("{commandVariable}")) {
          expect(entry?.split("msgstr ")[1]).toContain("{commandVariable}");
        }
      }
    }
  });

  it("translates model connection preflight feedback in every non-English catalog", () => {
    const locales = [
      "de",
      "es",
      "fr",
      "he",
      "hi",
      "ja",
      "ko",
      "nl",
      "pt-BR",
      "ru",
      "tr",
      "zh-CN",
      "zh-TW",
    ];
    const messages = [
      "A subscription credential is stored securely.",
      'Model "{modelId}" was not listed.',
      "Models list OK. {modelCount, plural, one {# model} other {# models}} available. " +
        "Chat was not tested.",
      "Connection test failed.",
      "Test API key",
      "Testing…",
    ];
    for (const locale of locales) {
      const catalog = readFileSync(
        fileURLToPath(new URL(`../locales/${locale}/messages.po`, import.meta.url)),
        "utf8",
      );
      for (const msgid of messages) {
        const needle = `msgid ${JSON.stringify(msgid)}\nmsgstr "`;
        const at = catalog.indexOf(needle);
        expect(at, `${locale} ${msgid}`).toBeGreaterThanOrEqual(0);
        const end = catalog.indexOf('"\n', at + needle.length);
        const translated = catalog.slice(at + needle.length, end);
        expect(translated.length, `${locale} ${msgid}`).toBeGreaterThan(0);
        expect(translated, `${locale} ${msgid}`).not.toBe(msgid);
        if (msgid.includes("{modelId}")) expect(translated).toContain("{modelId}");
        if (msgid.includes("{modelCount")) {
          expect(translated).toContain("{modelCount, plural,");
          expect(translated).toContain("#");
        }
      }
    }

    const russian = readFileSync(
      fileURLToPath(new URL("../locales/ru/messages.po", import.meta.url)),
      "utf8",
    );
    expect(russian).toContain(
      "msgstr " +
        '"Список моделей в порядке. {modelCount, plural, one {Доступна # модель} ' +
        "few {Доступны # модели} many {Доступно # моделей} other {Доступно # модели}}. " +
        'Чат не проверялся."',
    );
  });

  it("translates the peer marker toggle names and fills in the marker label", () => {
    for (const locale of UI_LOCALES.filter((locale) => locale !== "en")) {
      const catalog = readFileSync(
        fileURLToPath(new URL(`../locales/${locale}/messages.po`, import.meta.url)),
        "utf8",
      );
      for (const message of ["Expand {label}", "Collapse {label}"]) {
        const msgstr = catalog
          .split("\n\n")
          .find((block) => block.includes(`msgid ${JSON.stringify(message)}\n`))
          ?.match(/msgstr "(.+)"/)?.[1];
        expect(msgstr, `${locale}: ${message}`).toBeTruthy();
        expect(msgstr, `${locale}: ${message}`).not.toBe(message);
        i18n.load(locale, { [message]: msgstr ?? "" });
        i18n.activate(locale);
        const name = i18n._({ id: message, message, values: { label: "Writer" } });
        expect(name, `${locale}: ${message}`).toContain("Writer");
        expect(name, `${locale}: ${message}`).not.toContain("{label}");
      }
    }
  });
});

it("keeps source placeholders and JSX markers in Traditional Chinese translations", async () => {
  const readCatalog = async (locale: string) => {
    const filename = fileURLToPath(new URL(`../locales/${locale}/messages.po`, import.meta.url));
    return formatter().parse(readFileSync(filename, "utf8"), {
      locale,
      sourceLocale: "en",
      filename,
    });
  };
  const source = await readCatalog("en");
  const translated = await readCatalog("zh-TW");
  expect(Object.keys(translated).sort()).toEqual(Object.keys(source).sort());
  const markers = (value: string) =>
    [...new Set(value.match(/\{\w+(?=\s*[,}])|<\/?\d+\s*\/?>/g) ?? [])].sort();
  for (const [id, entry] of Object.entries(source)) {
    const message = entry.message ?? entry.translation ?? id;
    // Untranslated entries fall back to English, as in every other catalog.
    const translation = translated[id]?.translation;
    if (!translation?.trim()) continue;
    expect(markers(translation), message).toEqual(markers(message));
  }
});
