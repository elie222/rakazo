import { createAuth } from "@rakazo/auth";
import { createDb } from "@rakazo/db";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const { prisma, pool } = createDb(required("DATABASE_URL"));
try {
  const settings = await prisma.deploymentSettings.findUnique({ where: { id: "default" } });
  if (!settings?.ownerUserId) {
    const email = required("OWNER_EMAIL").trim().toLowerCase();
    const password = required("OWNER_PASSWORD");
    if (password.length < 16) throw new Error("OWNER_PASSWORD must contain at least 16 characters");
    const baseURL = required("BETTER_AUTH_URL");
    await prisma.deploymentSettings.upsert({
      where: { id: "default" },
      create: {
        id: "default",
        signupsEnabled: true,
        signupAllowlist: "",
        signupPolicyInitialized: true,
      },
      update: { signupAllowlist: "", signupsEnabled: true },
    });
    const auth = createAuth(prisma, {
      secret: required("BETTER_AUTH_SECRET"),
      baseURL,
      webOrigin: baseURL,
      signupsEnabled: "true",
      signupAllowlist: "",
    });
    const existing = await prisma.user.findUnique({ where: { email } });
    // A failed first boot may have created the account before its owner claim.
    const response = await auth.handler(
      new Request(`${baseURL}/api/auth/${existing ? "sign-in" : "sign-up"}/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: baseURL },
        body: JSON.stringify({ email, password, name: "Owner" }),
      }),
    );
    if (!response.ok) throw new Error(`Owner bootstrap failed (${response.status})`);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    await prisma.deploymentSettings.updateMany({
      where: { id: "default", ownerUserId: null },
      data: { ownerUserId: user.id },
    });
    const owner = await prisma.deploymentSettings.findUnique({ where: { id: "default" } });
    if (owner?.ownerUserId !== user.id) throw new Error("Owner bootstrap did not complete");
    await prisma.session.deleteMany({ where: { userId: user.id } });
    process.stdout.write("Owner account created\n");
  }
  await prisma.deploymentSettings.update({
    where: { id: "default" },
    data: { signupsEnabled: false, signupPolicyInitialized: true },
  });
} finally {
  await prisma.$disconnect();
  await pool.end();
}
