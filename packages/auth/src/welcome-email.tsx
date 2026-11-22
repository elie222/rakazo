/** @jsxRuntime automatic */
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { ANDROID_APP_STORE_URL, IOS_APP_STORE_URL } from "@rakazo/contracts";
import { Link, Text } from "react-email";
import { emailText, greeting, linkStyle, message, withNodes } from "./email.js";
import { emailCopy } from "./email-copy/deployment-copy.js";

const APPS: Readonly<Record<string, string>> = {
  iPhone: IOS_APP_STORE_URL,
  Android: ANDROID_APP_STORE_URL,
  Mac: "https://rakazo.com/api/download?platform=mac",
  Windows: "https://rakazo.com/api/download?platform=windows",
  Linux: "https://rakazo.com/api/download?platform=linux",
};

const stepStyle = { margin: "20px 0 4px" };

export function welcomeEmail(
  user: { email: string; name: string },
  unsubscribeUrl: string,
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  const copy = emailCopy("welcome", locale);
  return message(
    user.email,
    locale,
    copy("subject"),
    <>
      <Text>{greeting(say, user.name)}</Text>
      <Text>{copy("intro")}</Text>
      <Text style={stepStyle}>
        <strong>1. {copy("appsTitle")}</strong>
      </Text>
      <Text style={{ marginTop: 0 }}>
        {withNodes(copy("apps"), {
          // The language's own list ("A, B, and C", "A, B y C"), with each app a link.
          platforms: new Intl.ListFormat(locale, { type: "conjunction" })
            .formatToParts(Object.keys(APPS))
            .map((part, index) =>
              part.type === "element" ? (
                <Link key={part.value} href={APPS[part.value]} style={linkStyle}>
                  {part.value}
                </Link>
              ) : (
                <span key={`${index}${part.value}`}>{part.value}</span>
              ),
            ),
        })}
      </Text>
      <Text style={stepStyle}>
        <strong>2. {copy("communityTitle")}</strong>
      </Text>
      <Text style={{ marginTop: 0 }}>
        {withNodes(copy("community"), {
          discord: (
            <Link href="https://discord.gg/RWwKa2Sn7h" style={linkStyle}>
              Discord
            </Link>
          ),
        })}
      </Text>
      <Text style={stepStyle}>
        <strong>3. {copy("starTitle")}</strong>
      </Text>
      <Text style={{ marginTop: 0 }}>
        {withNodes(copy("star"), {
          star: (
            <Link href="https://github.com/elie222/rakazo" style={linkStyle}>
              {copy("starLink")}
            </Link>
          ),
        })}
      </Text>
      <Text style={{ marginTop: "28px" }}>{copy("closing")}</Text>
      <Text>{copy("signature")}</Text>
    </>,
    unsubscribeUrl,
    { src: "https://rakazo.com/email/welcome.jpg", alt: "Rakazo" },
  );
}
