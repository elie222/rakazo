import { describe, expect, it, vi } from "vitest";
import { getPage, listPages, removePage, setPageVisibility } from "./pages.js";

type Row = { id: string; title: string; visibility: string; shareSecretId: string | null };

/** An in-memory page and its secrets, with transactions that roll back on a throw. */
function fakeDeps(hooks: { onUpdate?: (attempt: number) => void } = {}) {
  let page: Row | null = {
    id: "page-1",
    title: "Plan",
    visibility: "private",
    shareSecretId: null,
  };
  let secrets = new Map<string, { id: string; ciphertext: string }>();
  const tokens = new Map<string, string>();
  let sealed = 0;
  let updates = 0;
  // A write another request committed; a rollback of this one never undoes it.
  let committedElsewhere: (() => void) | undefined;
  const summary = (row: Row) => ({
    ...row,
    userId: "user-1",
    botId: "bot-1",
    groupId: null,
    currentVersion: 1,
    pinnedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
  const install = (id: string, ciphertext: string) => {
    secrets.set(id, { id, ciphertext });
    page = { ...page!, visibility: "link", shareSecretId: id };
  };
  const tx = {
    page: {
      findUnique: async () => (page ? { shareSecretId: page.shareSecretId } : null),
      updateMany: async ({ where, data }: { where: Row; data: Partial<Row> }) => {
        hooks.onUpdate?.(updates++);
        if (!page || page.shareSecretId !== where.shareSecretId) return { count: 0 };
        page = { ...page, ...data };
        return { count: 1 };
      },
      delete: async () => {
        const deleted = page!;
        page = null;
        return { shareSecretId: deleted.shareSecretId };
      },
    },
    secret: {
      create: async ({ data }: { data: { id: string; ciphertext: string } }) => {
        secrets.set(data.id, { id: data.id, ciphertext: data.ciphertext });
      },
      findUnique: async ({ where }: { where: { id: string } }) => secrets.get(where.id) ?? null,
      deleteMany: async ({ where }: { where: { id: string } }) => {
        secrets.delete(where.id);
      },
    },
  };
  const prisma = {
    page: { findFirst: async () => (page ? summary(page) : null) },
    pageVersion: { findUnique: async () => ({ code: "compiled" }) },
    user: { findUnique: async () => ({ name: "Owner", image: null }) },
    secret: tx.secret,
    $transaction: async (work: (client: typeof tx) => Promise<unknown>) => {
      const saved = { page, secrets: new Map(secrets) };
      try {
        return await work(tx);
      } catch (error) {
        page = saved.page;
        secrets = saved.secrets;
        committedElsewhere?.();
        throw error;
      }
    },
  };
  const store = {
    put: vi.fn(async (token: string) => {
      sealed++;
      const record = { id: `secret-${sealed}`, ciphertext: `ref-${sealed}` };
      tokens.set(record.ciphertext, token);
      return record;
    }),
    load: vi.fn(async (ref: string) => tokens.get(ref)!),
    delete: vi.fn(async (ref: string) => {
      tokens.delete(ref);
    }),
  };
  const deps = { prisma, secrets: store, webOrigin: "https://rakazo.test" } as never;
  return {
    deps,
    store,
    install: (token: string) => {
      tokens.set("ref-winner", token);
      committedElsewhere = () => install("secret-winner", "ref-winner");
      committedElsewhere();
    },
    page: () => page,
    secretIds: () => [...secrets.keys()],
  };
}

const actor = { userId: "user-1", spaceId: "space-1" } as never;
const signal = new AbortController().signal;
const share = (deps: unknown, visibility: "link" | "private" | "space") =>
  setPageVisibility(deps as never, actor, { pageId: "page-1", visibility }, signal);

describe("page links", () => {
  it("gives a later or racing turn-on the link the page already has", async () => {
    const fake = fakeDeps();
    const first = await share(fake.deps, "link");
    const second = await share(fake.deps, "link");
    expect(second.shareUrl).toBe(first.shareUrl);
    expect(fake.store.put).toHaveBeenCalledTimes(1);
    expect(fake.secretIds()).toEqual(["secret-1"]);

    // Another turn-on lands after this one read the page and before its swap.
    const raced = fakeDeps({
      onUpdate: (attempt) => {
        if (attempt === 0) raced.install("WinnerToken");
      },
    });
    const result = await share(raced.deps, "link");
    expect(result.shareUrl).toContain("WinnerToken");
    expect(raced.page()?.shareSecretId).toBe("secret-winner");
    expect(raced.secretIds()).toEqual(["secret-winner"]);
    // The token this call sealed, which no page uses, leaves the secret store too.
    expect(raced.store.delete).toHaveBeenCalledWith(
      "ref-1",
      expect.objectContaining({ recordId: "secret-1" }),
    );
    expect(raced.store.delete).not.toHaveBeenCalledWith("ref-winner", expect.anything());
  });

  it("removes a turned-off or deleted page's token from the secret store", async () => {
    const fake = fakeDeps();
    await share(fake.deps, "link");
    await share(fake.deps, "private");
    expect(fake.store.delete).toHaveBeenCalledWith(
      "ref-1",
      expect.objectContaining({ recordId: "secret-1" }),
    );
    await share(fake.deps, "link");
    await removePage(fake.deps, actor, "page-1");
    expect(fake.store.delete).toHaveBeenCalledWith(
      "ref-2",
      expect.objectContaining({ recordId: "secret-2" }),
    );
    expect(fake.secretIds()).toEqual([]);
  });

  it("keeps the page working when the store cannot drop a retired token", async () => {
    const fake = fakeDeps();
    fake.store.delete.mockRejectedValue(new Error("provider down"));
    await share(fake.deps, "link");
    await expect(share(fake.deps, "private")).resolves.toEqual({
      visibility: "private",
      shareUrl: null,
    });
    expect(fake.page()?.shareSecretId).toBeNull();
  });

  it("issues a new link when the page's link token cannot be read", async () => {
    const fake = fakeDeps();
    await share(fake.deps, "link");
    fake.store.load.mockRejectedValueOnce(new Error("provider down"));
    fake.store.delete.mockRejectedValueOnce(new Error("provider down"));
    const result = await share(fake.deps, "link");
    expect(result.shareUrl).toMatch(/^https:\/\/rakazo\.test\//);
    expect(fake.page()).toMatchObject({ visibility: "link", shareSecretId: "secret-2" });
    expect(fake.secretIds()).toEqual(["secret-2"]);
    expect(fake.store.delete).toHaveBeenCalledWith(
      "ref-1",
      expect.objectContaining({ recordId: "secret-1" }),
    );
    // The new link reads back on the next turn-on.
    await expect(share(fake.deps, "link")).resolves.toEqual(result);
  });

  it("reads a shared page's link from the secret store only when asked for it", async () => {
    const fake = fakeDeps();
    const { shareUrl } = await share(fake.deps, "link");
    fake.store.load.mockClear();
    const card = await getPage(fake.deps, actor, { pageId: "page-1" });
    expect(card).toMatchObject({ visibility: "link", shareUrl: null });
    expect(fake.store.load).not.toHaveBeenCalled();
    const opened = await getPage(fake.deps, actor, { pageId: "page-1", link: true });
    expect(opened.shareUrl).toBe(shareUrl);
    expect(fake.store.load).toHaveBeenCalledTimes(1);
  });

  it("opens a shared page for its owner when its link token cannot be read", async () => {
    const fake = fakeDeps();
    await share(fake.deps, "link");
    fake.store.load.mockRejectedValue(new Error("provider down"));
    const detail = await getPage(fake.deps, actor, { pageId: "page-1", link: true });
    expect(detail).toMatchObject({ code: "compiled", visibility: "link", shareUrl: null });
  });
});

describe("page title search", () => {
  it.each([
    ["release_", "release\\_"],
    ["10%", "10\\%"],
    ["folder\\draft", "folder\\\\draft"],
    ["Release notes", "Release notes"],
  ])("treats %s as literal text", async (query, contains) => {
    const findMany = vi.fn().mockResolvedValue([]);
    await listPages({ page: { findMany } } as never, actor, { query });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          spaceId: "space-1",
          userId: "user-1",
          title: { contains, mode: "insensitive" },
        },
      }),
    );
  });

  it("omits the title filter for an empty query", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await listPages({ page: { findMany } } as never, actor, { query: "" });
    expect(findMany.mock.calls[0]?.[0].where).toEqual({
      spaceId: "space-1",
      userId: "user-1",
    });
  });
});

describe("pages shared with the Space", () => {
  const other = { userId: "user-2", spaceId: "space-1" } as never;
  const summary = {
    id: "page-1",
    title: "Trip",
    visibility: "space",
    userId: "user-1",
    botId: "bot-1",
    groupId: "group-1",
    currentVersion: 2,
    pinnedAt: new Date(0),
    shareSecretId: "secret-1",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const readDeps = (
    found: unknown,
    versionCode: { code: string } | null = { code: "compiled" },
  ) => {
    const findFirst = vi.fn().mockResolvedValue(found);
    const load = vi.fn();
    const deps = {
      prisma: {
        page: { findFirst },
        pageVersion: { findUnique: vi.fn().mockResolvedValue(versionCode) },
        user: { findUnique: vi.fn().mockResolvedValue({ name: "Ada", image: null }) },
      },
      secrets: { load },
      webOrigin: "https://rakazo.test",
    } as never;
    return { deps, findFirst, load };
  };

  it("opens another member's page read-only, without their bot, chat, pin or link", async () => {
    const { deps, findFirst, load } = readDeps(summary);
    const detail = await getPage(deps, other, { pageId: "page-1", link: true });
    expect(detail).toMatchObject({
      id: "page-1",
      visibility: "space",
      mine: false,
      botId: null,
      groupId: null,
      pinned: false,
      shareUrl: null,
      owner: { name: "Ada" },
    });
    expect(load).not.toHaveBeenCalled();
    // The read is the caller's own page, or a shared one whose owner is still in the Space.
    expect(findFirst.mock.calls[0]?.[0].where).toMatchObject({
      id: "page-1",
      spaceId: "space-1",
      OR: [
        { userId: "user-2" },
        { visibility: { in: ["space"] }, user: { members: expect.anything() } },
      ],
    });
  });

  it("shows another member only a page's current version", async () => {
    const { deps } = readDeps(summary);
    await expect(getPage(deps, other, { pageId: "page-1", version: 1 })).rejects.toThrow();
    await expect(getPage(deps, other, { pageId: "page-1", version: 2 })).resolves.toMatchObject({
      version: 2,
    });
  });

  it("keeps a page no one may read as not found", async () => {
    const { deps } = readDeps(null);
    await expect(getPage(deps, other, { pageId: "page-1" })).rejects.toThrow();
  });

  it("lists the Space's shared pages newest first with their owners, never another member's pin", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { ...summary, user: { name: "Ada" } },
      { ...summary, id: "page-2", userId: "user-2", pinnedAt: new Date(0), user: { name: "Bo" } },
    ]);
    const { items, nextCursor } = await listPages({ page: { findMany } } as never, other, {
      scope: "space",
    });
    expect(nextCursor).toBeNull();
    expect(items).toMatchObject([
      { id: "page-1", mine: false, ownerName: "Ada", pinned: false },
      { id: "page-2", mine: true, ownerName: null, pinned: true },
    ]);
    const query = findMany.mock.calls[0]?.[0];
    expect(query.where).toMatchObject({
      spaceId: "space-1",
      visibility: { in: ["space"] },
    });
    expect(query.where).not.toHaveProperty("userId");
    expect(query.orderBy).toEqual([{ updatedAt: "desc" }, { id: "desc" }]);
  });

  it("pages the Space list by update time without a pin in the cursor", async () => {
    const rows = [1, 2, 3].map((n) => ({
      ...summary,
      id: `page-${n}`,
      updatedAt: new Date(10_000 - n),
      user: { name: "Ada" },
    }));
    const findMany = vi.fn().mockResolvedValue(rows);
    const first = await listPages({ page: { findMany } } as never, other, {
      scope: "space",
      limit: 2,
    });
    expect(first.items.map((item) => item.id)).toEqual(["page-1", "page-2"]);
    expect(first.nextCursor).not.toBeNull();
    findMany.mockResolvedValue([]);
    await listPages({ page: { findMany } } as never, other, {
      scope: "space",
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(findMany.mock.calls[1]?.[0].where.AND).toEqual([
      {
        OR: [
          { updatedAt: { lt: new Date(10_000 - 2) } },
          { updatedAt: new Date(10_000 - 2), id: { lt: "page-2" } },
        ],
      },
    ]);
  });

  it("does not list the Space's pages by bot or chat", async () => {
    const findMany = vi.fn();
    const list = (input: { botId?: string; groupId?: string }) =>
      listPages({ page: { findMany } } as never, other, { scope: "space", ...input });
    await expect(list({ botId: "bot-1" })).rejects.toThrow("not listed by bot or group");
    await expect(list({ groupId: "group-1" })).rejects.toThrow("not listed by bot or group");
    expect(findMany).not.toHaveBeenCalled();
  });

  it("ends a page's link when it is shared with the Space, and keeps it off the link", async () => {
    const fake = fakeDeps();
    const { shareUrl } = await share(fake.deps, "link");
    expect(shareUrl).not.toBeNull();
    expect(await share(fake.deps, "space")).toEqual({ visibility: "space", shareUrl: null });
    expect(fake.page()).toMatchObject({ visibility: "space", shareSecretId: null });
    expect(fake.secretIds()).toEqual([]);
    expect(fake.store.delete).toHaveBeenCalledTimes(1);
  });
});
