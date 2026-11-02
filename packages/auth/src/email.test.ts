import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  accountDeletionEmail,
  emailLocale,
  identityCodeEmail,
  passwordResetEmail,
  signInCodeEmail,
  verificationEmail,
} from "./email.js";
import { ES_MESSAGES } from "./locales/es.js";

import {
  pluginSubmissionAdminEmail,
  pluginSubmissionReceivedEmail,
  pluginSubmissionReviewedEmail,
} from "./plugin-submission-email.js";
import { referralEmail } from "./referral-email.js";
import { welcomeEmail } from "./welcome-email.js";

describe("account email templates", () => {
  const url = "https://app.example.test/verify?token=fake-token&callbackURL=%2Fsign-in";

  it.each([
    ["verification", () => verificationEmail("user@example.test", url)],
    [
      "password reset",
      () => passwordResetEmail({ id: "user-1", email: "user@example.test", name: "Test" }, url),
    ],
  ] as const)("preserves the exact %s link in HTML and text", async (_name, create) => {
    const message = await create();
    expect(message.to).toBe("user@example.test");
    expect(message.text).toContain(url);
    expect(message.html).toContain(`href="${url.replaceAll("&", "&amp;")}"`);
  });

  it.each([signInCodeEmail, accountDeletionEmail])(
    "escapes code content and includes a plain-text fallback",
    async (create) => {
      const message = await create("user@example.test", "<script>fake-code</script>");
      expect(message.text).toContain("<script>fake-code</script>");
      expect(message.html).toContain("&lt;script&gt;fake-code&lt;/script&gt;");
      expect(message.html).not.toContain("<script>");
      expect(message.html).not.toContain("<a ");
    },
  );
});

// Every template must retain the same layout and a text alternative.
it("shares the layout across account, product and marketplace emails", async () => {
  const user = { id: "user-1", name: "Alex", email: "alex@example.com" };
  const url = "https://app.example.com";
  const messages = await Promise.all([
    verificationEmail(user.email, url),
    signInCodeEmail(user.email, "123456"),
    passwordResetEmail(user, url),
    accountDeletionEmail(user.email, "123456"),
    identityCodeEmail(user.email, "123456"),
    welcomeEmail(user, url),
    referralEmail(user, url, url),
    pluginSubmissionReceivedEmail(user.email),
    pluginSubmissionAdminEmail(
      user.email,
      { name: "Example plugin", source: "https://example.com/plugin", email: user.email },
      url,
    ),
    pluginSubmissionReviewedEmail({
      email: user.email,
      name: "Example plugin",
      status: "approved",
      reason: null,
    }),
    pluginSubmissionReviewedEmail({
      email: user.email,
      name: "Example plugin",
      status: "rejected",
      reason: "Example reason",
    }),
  ]);
  for (const message of messages) {
    expect(message.html!.match(/class="email-card"/g)).toHaveLength(1);
    expect(message.html).toContain('role="presentation"');
    expect(message.text.length).toBeGreaterThan(0);
    expect(message.text).not.toContain("<table");
  }
});

describe("email languages", () => {
  const headers = (value: string) => new Headers({ "accept-language": value });

  it("writes in the saved app language, else the asking browser's, else English", () => {
    expect(emailLocale("es", headers("de-DE,de;q=0.9"))).toBe("es");
    expect(emailLocale(null, headers("es-CL,es;q=0.9,en;q=0.8"))).toBe("es");
    expect(emailLocale(undefined, headers("ja-JP"))).toBe("en");
    expect(emailLocale("de", headers("es-ES"))).toBe("en");
    expect(emailLocale(null, headers("de-DE,es;q=0.9"))).toBe("es");
    expect(emailLocale(null, headers("en-US,es;q=0.9"))).toBe("en");
    expect(emailLocale(null, headers("*"))).toBe("en");
    expect(emailLocale(null, null)).toBe("en");
  });

  it("writes a code email in Spanish", async () => {
    const message = await signInCodeEmail("user@example.test", "123456", "es");
    expect(message.subject).toBe("Tu código para iniciar sesión en Rakazo");
    expect(message.html).toContain('lang="es"');
    expect(message.text).toContain("Introduce este código para iniciar sesión en Rakazo:");
  });

  it("greets by name in Spanish and keeps English as written", async () => {
    const user = { id: "user-1", email: "user@example.test", name: "Ana" };
    expect((await passwordResetEmail(user, "https://example.test/r", "es")).text).toContain(
      "Hola, Ana:",
    );
    const english = await welcomeEmail(user, "https://example.test/u");
    expect(english.subject).toBe("Welcome to Rakazo");
    expect(english.text).toContain("Hi Ana,");
    expect(english.text).toContain("Rakazo also has apps for iPhone");
  });

  it("translates every email string into Spanish with its placeholders", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const ids = readdirSync(dir)
      .filter((file) => file.endsWith(".tsx"))
      .flatMap((file) =>
        [...readFileSync(join(dir, file), "utf8").matchAll(/say\(\s*("(?:[^"\\]|\\.)*")/g)].map(
          (match) => JSON.parse(match[1] ?? '""') as string,
        ),
      );
    expect(ids.length).toBeGreaterThan(30);
    const placeholders = (text: string) => [...text.matchAll(/\{\w+\}/g)].map(String).sort();
    for (const id of ids) {
      expect(ES_MESSAGES[id], id).toBeTruthy();
      expect(placeholders(ES_MESSAGES[id] ?? ""), id).toEqual(placeholders(id));
    }
  });
});
