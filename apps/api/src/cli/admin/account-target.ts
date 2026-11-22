import type { PrismaClient } from "@rakazo/db";
import { z } from "zod";
import { AdminCommandError } from "./admin-command.js";

export function adminEmail(address: string | undefined) {
  return z.email().safeParse(address?.trim()).data;
}

export async function findAdminAccount(prisma: PrismaClient, email: string) {
  const accounts = await prisma.user.findMany({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true, email: true },
    take: 2,
  });
  if (accounts.length !== 1 || !accounts[0])
    throw new AdminCommandError("No single account has that email");
  return accounts[0];
}
