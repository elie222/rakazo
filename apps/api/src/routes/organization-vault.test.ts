import { expect, it, vi } from "vitest";
import type { RouterContext } from "./context.js";
import { organizationVaultRoutes } from "./organization-vault.js";

it("propagates a lease database failure even after the protected sign-in deadline", async () => {
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
  const dbError = new Error("fake lease database failure");
  const tx = {
    space: { findUnique: async () => ({ organizationId: "org" }) },
    member: { findFirst: async () => ({ role: "owner" }) },
    organizationLogin: {
      findFirst: async () => ({ id: "login", origin: "https://example.test", sessionVersion: 0 }),
    },
  };
  type Handler = (options: unknown) => Promise<unknown>;
  const handler = { handler: (work: Handler) => work };
  const routes = organizationVaultRoutes({
    deps: {
      prisma: {
        $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
        $queryRaw: async () => {
          deadline.abort(new DOMException("Deadline expired", "TimeoutError"));
          throw dbError;
        },
      },
      organizationLoginBrowser: { launch: vi.fn() },
    },
    authed: {
      organizations: {
        vault: {
          signIn: handler,
          settings: handler,
          revokeSession: handler,
          list: handler,
          create: handler,
          setAgents: handler,
          remove: handler,
        },
      },
    },
  } as unknown as RouterContext);
  const signIn = routes.signIn as unknown as Handler;
  await expect(
    signIn({
      context: { actor: { userId: "user", spaceId: "space" } },
      input: { loginId: "login", url: "https://example.test/sign-in" },
    }),
  ).rejects.toBe(dbError);
});
