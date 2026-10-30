/** @jsxRuntime automatic */
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { displayName, matchUiLocale, translate } from "@rakazo/core";
import { webLightTokens as lightTokens, webDarkTokens } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Link,
  render,
  Section,
  Text,
  toPlainText,
} from "react-email";
import { ES_MESSAGES } from "./locales/es.js";

/** Email copy by app language, keyed by the English text. Any other language reads English. */
const CATALOGS: Readonly<Record<string, Readonly<Record<string, string>>>> = { es: ES_MESSAGES };
const LOCALES = Object.keys(CATALOGS);

/**
 * The language to write an email in: the person's saved app language, else the language of the
 * browser that asked for it, else English.
 */
export function emailLocale(saved: string | null | undefined, headers?: Headers | null): string {
  if (saved) return matchUiLocale(saved, LOCALES);
  // Browsers list languages best first: take the first one emails are written in.
  for (const part of headers?.get("accept-language")?.split(",") ?? []) {
    const tag = part.split(";")[0]?.trim() ?? "";
    if (/^en(?:-|$)/i.test(tag)) return "en";
    const locale = matchUiLocale(tag, LOCALES);
    if (locale !== "en") return locale;
  }
  return "en";
}

/** The language to email an account in, given the headers of the request that asked. */
export type EmailLocaleOf = (
  account: { id: string } | { email: string },
  headers?: Headers | null,
) => Promise<string>;

/** Translates email copy into `locale`, filling `{name}` placeholders. */
export function emailText(locale: string) {
  const catalog = CATALOGS[locale];
  return (text: string, values?: Record<string, string | number>) =>
    translate(catalog, text, values);
}

export function greeting(say: ReturnType<typeof emailText>, name: string): string {
  const shown = displayName(name, "");
  return shown ? say("Hi {name},", { name: shown }) : say("Hi there,");
}

export async function message(
  to: string,
  locale: string,
  subject: string,
  content: ReactNode,
  unsubscribeUrl?: string,
): Promise<TransactionalEmail> {
  const html = await render(
    <Html lang={locale}>
      <Head>
        <meta name="color-scheme" content="light dark" />
        <meta name="supported-color-schemes" content="light dark" />
        <style>{`@media (prefers-color-scheme: dark) {
          .email-body, .email-body > table > tbody > tr > td { background-color: ${webDarkTokens.background} !important; }
          .email-card { background-color: ${webDarkTokens.dialog} !important; color: ${webDarkTokens.foreground} !important; border-color: ${webDarkTokens.primary} !important; }
          .email-card p, .email-card a { color: ${webDarkTokens.foreground} !important; }
        }`}</style>
      </Head>
      <Body
        className="email-body"
        style={{
          backgroundColor: lightTokens.muted,
          color: lightTokens.foreground,
          fontFamily: "Arial, Helvetica, sans-serif",
          margin: 0,
          padding: "32px 12px",
        }}
      >
        <Container
          className="email-card"
          style={{
            maxWidth: "520px",
            backgroundColor: lightTokens.dialog,
            color: lightTokens.foreground,
            borderRadius: "8px",
            borderTop: `3px solid ${lightTokens.primary}`,
          }}
        >
          <Section style={{ padding: "20px 28px 24px" }}>
            <Text
              style={{
                margin: "0 0 24px",
                fontSize: "22px",
                fontWeight: 600,
                letterSpacing: "-0.5px",
              }}
            >
              rakazo
            </Text>
            {content}
            {unsubscribeUrl ? (
              <>
                <Hr style={{ borderColor: lightTokens.border, marginTop: "28px" }} />
                <Text style={{ fontSize: "12px", marginBottom: 0 }}>
                  <Link href={unsubscribeUrl} style={{ color: lightTokens.mutedForeground }}>
                    {emailText(locale)("Unsubscribe")}
                  </Link>
                </Text>
              </>
            ) : null}
          </Section>
        </Container>
      </Body>
    </Html>,
  );
  return {
    to,
    subject,
    html,
    text: toPlainText(html),
    ...(unsubscribeUrl
      ? {
          headers: {
            "List-Unsubscribe": `<${unsubscribeUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
        }
      : {}),
  };
}

export const linkStyle = { color: lightTokens.primary, textDecoration: "underline" };

export function verificationEmail(
  email: string,
  url: string,
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  return message(
    email,
    locale,
    say("Verify your Rakazo email"),
    <>
      <Text>
        <Link href={url} style={linkStyle}>
          {say("Verify email")}
        </Link>
      </Text>
      <Text>{say("Then return to Rakazo to sign in.")}</Text>
      <Text>
        {say("This link expires in one hour. If you did not register, ignore this email.")}
      </Text>
    </>,
  );
}

export function signInCodeEmail(
  email: string,
  code: string,
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  return message(
    email,
    locale,
    say("Your Rakazo sign-in code"),
    <>
      <Text>{say("Enter this code to sign in to Rakazo:")}</Text>
      <Text>
        <strong>{code}</strong>
      </Text>
      <Text>
        {say("This code expires in ten minutes. If you did not request it, ignore this email.")}
      </Text>
    </>,
  );
}

export function passwordResetEmail(
  user: { id: string; email: string; name: string },
  resetUrl: string,
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  return message(
    user.email,
    locale,
    say("Reset your Rakazo password"),
    <>
      <Text>{greeting(say, user.name)}</Text>
      <Text>{say("Reset your Rakazo password:")}</Text>
      <Text>
        <Link href={resetUrl} style={linkStyle}>
          {say("Reset password")}
        </Link>
      </Text>
      <Text>
        {say(
          "This link expires in one hour. If you did not request this, you can ignore this email.",
        )}
      </Text>
    </>,
  );
}

export function accountDeletionEmail(
  email: string,
  code: string,
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  return message(
    email,
    locale,
    say("Confirm Rakazo account deletion"),
    <>
      <Text>{say("Enter this code in Rakazo to delete your account:")}</Text>
      <Text>{code}</Text>
      <Text>
        {say(
          "This code expires in ten minutes. If you did not request deletion, ignore this email.",
        )}
      </Text>
    </>,
  );
}

export function identityCodeEmail(
  email: string,
  code: string,
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  return message(
    email,
    locale,
    say("Your Rakazo confirmation code"),
    <>
      <Text>{say("Enter this code in Rakazo to confirm it's you:")}</Text>
      <Text>
        <strong>{code}</strong>
      </Text>
      <Text>
        {say("This code expires in ten minutes. If you did not request it, ignore this email.")}
      </Text>
    </>,
  );
}
