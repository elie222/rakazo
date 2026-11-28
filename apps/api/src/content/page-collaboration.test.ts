import { onError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import { PAGE_REVISION_NOT_FOUND, pageRevisionFloor } from "@rakazo/contracts";
import { IsolationError } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRpcError } from "../rpc-errors.js";
import { getPageReview, PageRevisionNotFoundError } from "./page-collaboration.js";

const owner: Actor = {
  spaceId: "space-1",
  userId: "owner-1",
  email: "owner@rakazo.test",
  isDeploymentOwner: false,
};
const reviewer: Actor = { ...owner, userId: "reviewer-1", email: "reviewer@rakazo.test" };
const input = { pageId: "page-1" };
const path = ["pageReviews", "get"];

type Page = { currentVersion: number; grantFirstVersion?: number } | null;

/**
 * A page that `reviewer` may read from `grantFirstVersion`, and the revisions it stores. Without
 * a page, the database answers a reader who is neither the owner nor a grant holder.
 */
function fakePrisma(page: Page, stored: number[]) {
  const findPage = vi.fn(async () =>
    page
      ? {
          id: input.pageId,
          userId: owner.userId,
          spaceId: owner.spaceId,
          title: "Plan",
          visibility: "people",
          currentVersion: page.currentVersion,
          user: { deactivatedAt: null },
          bot: { id: "bot-1", spaceId: owner.spaceId, archivedAt: null },
          grants:
            page.grantFirstVersion === undefined
              ? []
              : [{ id: "grant-1", firstVersion: page.grantFirstVersion }],
        }
      : null,
  );
  // A revision is looked up by its page and its number together.
  const findVersion = vi.fn(
    async ({ where }: { where: { pageId_version: { pageId: string; version: number } } }) =>
      where.pageId_version.pageId === input.pageId && stored.includes(where.pageId_version.version)
        ? { title: "Plan", code: "<main>Plan</main>", images: null }
        : null,
  );
  const tx = {
    page: { findFirst: findPage },
    pageVersion: { findUnique: findVersion },
    spaceMember: { findFirst: vi.fn(async () => ({ userId: owner.userId })) },
  };
  const prisma = {
    ...tx,
    $transaction: (work: (client: typeof tx) => Promise<unknown>) => work(tx),
  };
  return { prisma: prisma as never, findVersion };
}

/** The answer `handleRpcError` gives a refusal, as the RPC layer throws it. */
function translated(refusal: Error) {
  try {
    handleRpcError(refusal, path);
  } catch (answer) {
    return answer;
  }
  throw new Error("expected the refusal to be answered");
}

describe("getPageReview refusals", () => {
  afterEach(() => {
    installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] }));
  });

  it("keeps the not-found generic for a revision while the reader may no longer read the page", async () => {
    const db = fakePrisma(null, [1, 2, 3]);
    await expect(
      getPageReview(db.prisma, reviewer, { ...input, version: 1 }),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(db.findVersion).not.toHaveBeenCalled();
  });

  it("names a revision older than the reader's grant once their access to the page is verified", async () => {
    const db = fakePrisma({ currentVersion: 3, grantFirstVersion: 2 }, [1, 2, 3]);
    await expect(
      getPageReview(db.prisma, reviewer, { ...input, version: 1 }),
    ).rejects.toMatchObject({
      kind: "NOT_FOUND",
      code: PAGE_REVISION_NOT_FOUND,
      data: { readableFrom: 2 },
    });
    expect(db.findVersion).not.toHaveBeenCalled();
  });

  it("names a revision the page does not store from the reader's grant, and reads one it stores", async () => {
    const db = fakePrisma({ currentVersion: 3, grantFirstVersion: 2 }, [1, 2, 3]);
    await expect(
      getPageReview(db.prisma, reviewer, { ...input, version: 9 }),
    ).rejects.toMatchObject({ code: PAGE_REVISION_NOT_FOUND, data: { readableFrom: 2 } });
    await expect(getPageReview(db.prisma, reviewer, { ...input, version: 2 })).resolves.toEqual({
      id: "page-1",
      title: "Plan",
      code: "<main>Plan</main>",
      images: {},
      currentVersion: 3,
      version: 2,
      owner: false,
      canRequestRevision: true,
    });
  });

  it("names the page's first revision for an owner, who may read a revision the page stores", async () => {
    const db = fakePrisma({ currentVersion: 3 }, [1, 2, 3]);
    await expect(getPageReview(db.prisma, owner, { ...input, version: 9 })).rejects.toMatchObject({
      code: PAGE_REVISION_NOT_FOUND,
      data: { readableFrom: 1 },
    });
    await expect(getPageReview(db.prisma, owner, { ...input, version: 2 })).resolves.toEqual({
      id: "page-1",
      title: "Plan",
      code: "<main>Plan</main>",
      images: {},
      currentVersion: 3,
      version: 2,
      owner: true,
      canRequestRevision: true,
    });
  });

  it("answers the revision's own not-found as a 404 that names the lowest readable revision", () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));

    const revisionOnly = translated(new PageRevisionNotFoundError(3));
    expect(revisionOnly).toMatchObject({ code: PAGE_REVISION_NOT_FOUND, status: 404 });
    expect(pageRevisionFloor(revisionOnly)).toBe(3);
    // A reader without access to the page is told no such revision.
    const plain = translated(new IsolationError());
    expect(plain).toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(pageRevisionFloor(plain)).toBeUndefined();
    expect(sink.events.filter((event) => event.level === "error")).toEqual([]);
  });

  it("sends the lowest readable revision with the refusal over RPC", async () => {
    installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] }));
    const rpc = new RPCHandler(
      {
        read: os.handler(() => {
          throw new PageRevisionNotFoundError(3);
        }),
      },
      { clientInterceptors: [onError((error, { path }) => handleRpcError(error, path))] },
    );

    const { response } = await rpc.handle(
      new Request("http://rakazo.test/rpc/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: {} }),
      }),
      { prefix: "/rpc", context: {} },
    );

    expect(response?.status).toBe(404);
    expect(await response?.json()).toMatchObject({
      json: { code: PAGE_REVISION_NOT_FOUND, status: 404, data: { readableFrom: 3 } },
    });
  });
});
