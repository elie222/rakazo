import { createHmac } from "node:crypto";
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { emailLocale } from "@rakazo/auth";
import type { RouterDeps } from "./router.js";

/** Names an invited address in the security log, so its daily limit outlives any deletion. */
export function invitationRecipientKey(deps: RouterDeps) {
  return (email: string) =>
    createHmac("sha256", deps.env.invitationRecipientKey).update(email).digest("hex");
}

/** Whether the email went out; when it did not, the inviter shares the link by hand. */
export async function sendInvitationEmail(
  deps: RouterDeps,
  inviterId: string,
  to: string,
  build: (locale: string) => Promise<TransactionalEmail>,
): Promise<boolean> {
  if (!deps.email) return false;
  // The invitation is saved by now: whatever stops the email, the inviter still gets the link.
  try {
    // The invitee's own language when they have an account here, else the inviter's.
    const [invitee, inviter] = await Promise.all([
      deps.prisma.user.findFirst({
        where: { email: { equals: to, mode: "insensitive" } },
        select: { locale: true },
      }),
      deps.prisma.user.findUnique({ where: { id: inviterId }, select: { locale: true } }),
    ]);
    await deps.email.send(await build(emailLocale(invitee?.locale ?? inviter?.locale)));
    return true;
  } catch (error) {
    deps.onEmailError?.(error);
    return false;
  }
}
