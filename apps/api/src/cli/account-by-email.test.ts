import { describe, expect, it } from "vitest";
import { accountByEmail } from "./account-by-email.js";

describe("accountByEmail", () => {
  const users = (emails: string[]) => ({
    user: {
      findUnique: async ({ where }: { where: { email: string } }) =>
        emails.includes(where.email) ? { id: where.email } : null,
      findMany: async ({ where }: { where: { email: { equals: string } } }) =>
        emails.filter((email) => email.toLowerCase() === where.email.equals).map((id) => ({ id })),
    },
  });

  it("prefers the spelling typed, then the canonical one", async () => {
    const both = users(["cy@gmail.com", "cy@googlemail.com"]) as never;
    expect(await accountByEmail(both, "Cy@GoogleMail.com")).toEqual({ id: "cy@googlemail.com" });
    expect(await accountByEmail(both, "cy@gmail.com")).toEqual({ id: "cy@gmail.com" });
    const kept = users(["Cy@GoogleMail.com", "cy@gmail.com"]) as never;
    expect(await accountByEmail(kept, "cy@googlemail.com")).toEqual({ id: "Cy@GoogleMail.com" });
    const moved = users(["cy@gmail.com"]) as never;
    expect(await accountByEmail(moved, "cy@googlemail.com")).toEqual({ id: "cy@gmail.com" });
  });

  it("finds one account differing by case and refuses two", async () => {
    expect(await accountByEmail(users(["Old@Example.test"]) as never, "old@example.test")).toEqual({
      id: "Old@Example.test",
    });
    expect(
      await accountByEmail(
        users(["Old@Example.test", "OLD@example.test"]) as never,
        "old@example.test",
      ),
    ).toBeNull();
  });
});
