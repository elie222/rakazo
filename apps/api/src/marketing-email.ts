import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import {
  UNSUBSCRIBE_PATH,
  unsubscribeUrl,
  validUnsubscribeToken as validToken,
  welcomeEmail,
} from "@rakazo/auth";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { Hono } from "hono";

export { unsubscribeUrl } from "@rakazo/auth";

// Accounts older than this never get a welcome, including those created before the email existed.
const WELCOME_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function sendWelcomeEmail(
  deps: {
    prisma: PrismaClient;
    email: TransactionalEmailProvider;
    origin: string;
    secret: string;
    onError: (error: unknown) => void;
  },
  userId: string,
): Promise<void> {
  try {
    const user = await deps.prisma.user.findFirst({
      where: { id: userId, createdAt: { gte: new Date(Date.now() - WELCOME_WINDOW_MS) } },
      select: { email: true, name: true },
    });
    if (!user) return;
    const claim = await deps.prisma.emailSend.createMany({
      data: { userId, kind: "welcome" },
      skipDuplicates: true,
    });
    if (claim.count === 0) return;
    const message = await welcomeEmail(user, unsubscribeUrl(deps.origin, deps.secret, userId));
    // The provider tracks the send, so shutdown drains it; sign-in does not wait on delivery.
    void deps.email.send(message).catch(deps.onError);
  } catch (error) {
    deps.onError(error);
  }
}

// GET only confirms: link scanners open every URL in an email. Mail clients POST (RFC 8058).
export function marketingEmailRoutes(
  prisma: PrismaClient,
  secret: string,
  productEmailSecret?: string,
) {
  const app = new Hono();
  const verifiedUser = (url: string) => {
    const params = new URL(url).searchParams;
    const userId = params.get("user") ?? "";
    const token = params.get("token") ?? "";
    // Workers already hold the encryption key; never give them the session-signing secret.
    return userId &&
      (validToken(secret, userId, token) ||
        (productEmailSecret && validToken(productEmailSecret, userId, token)))
      ? userId
      : null;
  };
  app.get(UNSUBSCRIBE_PATH, (c) =>
    verifiedUser(c.req.url)
      ? page(
          `<form method="post"><button type="submit">Unsubscribe from Rakazo emails</button></form>`,
        )
      : page("This link is not valid.", 400),
  );
  app.post(UNSUBSCRIBE_PATH, async (c) => {
    const userId = verifiedUser(c.req.url);
    if (!userId) return page("This link is not valid.", 400);
    await runAsSystem("unsubscribe a user from product email", () =>
      prisma.user.updateMany({
        where: { id: userId, marketingEmailOptOutAt: null },
        data: { marketingEmailOptOutAt: new Date() },
      }),
    );
    return page("You're unsubscribed.");
  });
  return app;
}

function page(content: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Rakazo</title></head><body style="font-family: Arial, sans-serif; max-width: 480px; margin: 48px auto; padding: 0 24px">${content}</body></html>`,
    {
      status,
      headers: { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" },
    },
  );
}
