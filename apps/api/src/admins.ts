import type { RouterDeps } from "./router.js";

/** Accounts listed in RAKAZO_ADMIN_EMAILS, once their email is verified. */
export async function isAdmin(
  deps: Pick<RouterDeps, "prisma" | "env">,
  userId: string,
): Promise<boolean> {
  const admins = deps.env.adminEmails ?? [];
  if (admins.length === 0) return false;
  const user = await deps.prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });
  return Boolean(user?.emailVerified && admins.includes(user.email.toLowerCase()));
}
