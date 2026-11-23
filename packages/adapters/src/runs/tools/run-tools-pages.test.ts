import type { PageVisibility } from "@rakazo/contracts";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunContext } from "../assembly/run-context.js";

const publishMessage = vi.fn();
vi.mock("../assembly/run-messages.js", async (importActual) => ({
  ...(await importActual<typeof import("../assembly/run-messages.js")>()),
  publishMessage: (...args: unknown[]) => publishMessage(...args),
}));

const { holdSharedPageSave, pageTools } = await import("./run-tools-pages.js");
const { redactBlocks } = await import("../assembly/run-messages.js");

const source = (heading: string) =>
  `const App = () => (\n  <Page title="${heading}">\n    <Text>Hi</Text>\n  </Page>\n);\nexport default App;\n`;

function context(
  tx: Record<string, unknown>,
  existing?: { currentVersion: number; visibility?: PageVisibility },
  secrets: string[] = [],
  skipApprovals = false,
) {
  const prisma = {
    page: {
      findFirst: vi.fn(async () =>
        existing
          ? {
              id: "page-1",
              title: "Plan",
              visibility: existing.visibility ?? "private",
              currentVersion: existing.currentVersion,
              versions: [{ source: source("Plan") }],
            }
          : null,
      ),
    },
    $transaction: vi.fn(async (work: (client: unknown) => unknown) => work(tx)),
  };
  return {
    deps: { prisma },
    run: { id: "run-1", spaceId: "space-1", userId: "user-1", threadId: "t-1", botId: "bot-1" },
    bot: { id: "bot-1" },
    thread: { groupId: null },
    secrets,
    state: { tainted: false },
    trust: { loadAutoReviewPreference: async () => ({ skipApprovals }) },
  } as never;
}

const call = (args: Record<string, unknown>, approval: Record<string, unknown> = {}) =>
  ({ args, bypassApproval: false, ...approval, finish: (result: unknown) => result }) as never;

const request = (args: Record<string, unknown>, nextApprovedTool?: string) =>
  ({ args, nextApprovedTool, heldForApproval: false, fleetSummary: undefined }) as {
    args: Record<string, unknown>;
    effectRequest?: unknown;
    nextApprovedTool: string | undefined;
    heldForApproval: boolean;
    fleetSummary: { title: string; lines: string[] } | undefined;
  };

describe("save_page", () => {
  beforeEach(() => publishMessage.mockReset());

  it("keeps a saved page when its chat card cannot be posted, and says how to link it", async () => {
    publishMessage.mockRejectedValueOnce(new Error("run was cancelled"));
    const tx = { page: { create: vi.fn(async () => ({ id: "page-1", title: "Plan" })) } };
    const result = (await pageTools.save_page!(
      context(tx),
      call({ title: "Plan", source: source("Plan") }),
    )) as Record<string, unknown>;
    expect(tx.page.create).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ pageId: "page-1", version: 1, title: "Plan" });
    expect(result.error).toMatch(/saved, but its card could not be posted/);
    expect(result.error).toContain("[Plan](page:page-1)");
  });

  it("signals the owner's page list even when the page is new", async () => {
    const tx = { page: { create: vi.fn(async () => ({ id: "page-2", title: "New" })) } };
    const ctx = context(tx);
    const publishSpaceChange = vi.fn(async () => {});
    Object.assign((ctx as RunContext).deps, { events: { publishSpaceChange } });
    await pageTools.save_page!(ctx, call({ title: "New", source: source("New") }));
    expect(publishSpaceChange).toHaveBeenCalledExactlyOnceWith("pages:user-1", "pages");
  });

  it("taints the run when it reads a page's stored source, but not when it saves one", async () => {
    const read = context({}, { currentVersion: 2 });
    const result = (await pageTools.save_page!(read, call({ pageId: "page-1" }))) as Record<
      string,
      unknown
    >;
    expect(result.source).toBe(source("Plan"));
    expect((read as { state: { tainted: boolean } }).state.tainted).toBe(true);

    const tx = { page: { create: vi.fn(async () => ({ id: "page-2", title: "New" })) } };
    const save = context(tx);
    await pageTools.save_page!(save, call({ title: "New", source: source("New") }));
    expect(tx.page.create).toHaveBeenCalledTimes(1);
    expect((save as { state: { tainted: boolean } }).state.tainted).toBe(false);
  });

  it("treats an empty edits list as not sent, as it does a blank title or source", async () => {
    const tx = { page: { create: vi.fn(async () => ({ id: "page-1", title: "Plan" })) } };
    const created = (await pageTools.save_page!(
      context(tx),
      call({ title: "Plan", source: source("Plan"), edits: [] }),
    )) as Record<string, unknown>;
    expect(created).toMatchObject({ pageId: "page-1", version: 1 });
    expect(tx.page.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        versions: { create: expect.objectContaining({ code: expect.stringContaining("Plan") }) },
      }),
    });
    // Reading a page back with an empty list returns its source rather than an error.
    const read = (await pageTools.save_page!(
      context({}, { currentVersion: 3 }),
      call({ pageId: "page-1", edits: [], source: "" }),
    )) as Record<string, unknown>;
    expect(read).toEqual({ pageId: "page-1", version: 3, title: "Plan", source: source("Plan") });
  });

  it("never stores a run secret in a page's source, title or chat card", async () => {
    const secret = "FAKE_PAGE_SECRET_7246";
    const tx = {
      page: {
        create: vi.fn(async ({ data }: { data: { title: string } }) => ({
          id: "page-1",
          title: data.title,
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      pageVersion: { create: vi.fn() },
    };
    const refused = [
      call({ title: "Plan", source: source(secret) }),
      call({ pageId: "page-1", source: source(secret) }),
      call({ pageId: "page-1", edits: [{ find: 'title="Plan"', replace: `title="${secret}"` }] }),
    ];
    for (const [index, args] of refused.entries()) {
      const existing = index === 0 ? undefined : { currentVersion: 1 };
      const result = (await pageTools.save_page!(context(tx, existing, [secret]), args)) as Record<
        string,
        unknown
      >;
      expect(result).toMatchObject({ unchanged: true, error: expect.stringMatching(/secret/) });
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    expect(tx.page.create).not.toHaveBeenCalled();
    expect(tx.pageVersion.create).not.toHaveBeenCalled();
    expect(publishMessage).not.toHaveBeenCalled();

    const titled = (await pageTools.save_page!(
      context(tx, undefined, [secret]),
      call({ title: `Keys ${secret}`, source: source("Plan") }),
    )) as Record<string, unknown>;
    expect(titled.title).toBe("Keys [redacted]");
    expect(JSON.stringify(tx.page.create.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(publishMessage.mock.calls)).not.toContain(secret);
    // A page card in a run's reply is redacted like its text.
    expect(
      redactBlocks(
        [{ kind: "page", pageId: "page-1", version: 1, title: `A ${secret}` }],
        [secret],
      ),
    ).toEqual([{ kind: "page", pageId: "page-1", version: 1, title: "A [redacted]" }]);
    // Step labels can come from tool arguments, so they are redacted like notes.
    expect(
      redactBlocks([{ kind: "steps", steps: [{ label: `Run ${secret}`, count: 1 }] }], [secret]),
    ).toEqual([{ kind: "steps", steps: [{ label: "Run [redacted]", count: 1 }] }]);
  });

  it("redacts a kept title that holds a secret this run learned after it was saved", async () => {
    const secret = "FAKE_PAGE_SECRET_9132";
    const tx = {
      page: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUniqueOrThrow: vi.fn(async () => ({ title: `Keys ${secret}` })),
        update: vi.fn(),
      },
      pageVersion: { create: vi.fn() },
    };
    const result = (await pageTools.save_page!(
      context(tx, { currentVersion: 1 }, [secret]),
      call({ pageId: "page-1", source: source("Plan") }),
    )) as Record<string, unknown>;
    expect(result.title).toBe("Keys [redacted]");
    expect(tx.page.update).toHaveBeenCalledWith({
      where: { id: "page-1" },
      data: { title: "Keys [redacted]" },
    });
    expect(JSON.stringify(tx.pageVersion.create.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(publishMessage.mock.calls)).not.toContain(secret);
  });
});

describe("saving a shared page", () => {
  const edit = { find: "Hi", replace: "Hello" };

  it.each(["link", "people"] as const)(
    "holds a %s share for approval, showing what changes",
    async (visibility) => {
      const held = request({ pageId: "page-1", edits: [edit], approvedVersion: 9 });
      await holdSharedPageSave(context({}, { currentVersion: 1, visibility }), held as never);
      expect(held.heldForApproval).toBe(true);
      expect(held.fleetSummary).toEqual({
        title: "Update shared page “Plan”?",
        lines: ["-     <Text>Hi</Text>", "+     <Text>Hello</Text>"],
      });
      // The approval pins the version the card was shown against, never one the model sent.
      expect(held.args).toMatchObject({ approvedVersion: 1, approvedVisibility: visibility });
      expect(held.effectRequest).toBe(held.args);

      // A whole new source shows only the lines that change too.
      const whole = request({ pageId: "page-1", source: source("Plan").replace("Hi", "Bye") });
      await holdSharedPageSave(
        context({}, { currentVersion: 1, visibility: "link" }),
        whole as never,
      );
      expect(whole.fleetSummary?.lines).toEqual([
        "-     <Text>Hi</Text>",
        "+     <Text>Bye</Text>",
      ]);
    },
  );

  it("lets a save that would fail anyway fail without a card", async () => {
    const shared = { currentVersion: 1, visibility: "link" as const };
    for (const args of [
      { pageId: "page-1", edits: [{ find: "Hi" }] },
      { pageId: "page-1", edits: [{ find: "Missing", replace: "x" }] },
      { pageId: "page-1", source: "not a page" },
    ]) {
      const held = request(args);
      expect(await holdSharedPageSave(context({}, shared), held as never)).toBeUndefined();
      expect(held.heldForApproval).toBe(false);
    }
  });

  it("shows only the changed part of a long line", async () => {
    const row = `const rows = [${Array.from({ length: 300 }, (_, index) => `"r${index}"`).join(", ")}];`;
    const withRow = source("Plan").replace("const App", `${row}\nconst App`);
    const ctx = context({}, { currentVersion: 1, visibility: "link" });
    (
      ctx as { deps: { prisma: { page: { findFirst: () => Promise<unknown> } } } }
    ).deps.prisma.page.findFirst = async () => ({
      title: "Plan",
      visibility: "link",
      currentVersion: 1,
      versions: [{ source: withRow }],
    });
    const held = request({ pageId: "page-1", edits: [{ find: '"r150"', replace: '"changed"' }] });
    expect(await holdSharedPageSave(ctx, held as never)).toBeUndefined();
    const [removed, added] = held.fleetSummary!.lines;
    expect(removed).toMatch(/^- ….*"r150".*…$/);
    expect(added).toMatch(/^\+ ….*"changed".*…$/);
    expect(removed!.length).toBeLessThan(120);
  });

  it("shows the title as it will be saved, and skips a save the secret check would refuse", async () => {
    const shared = { currentVersion: 1, visibility: "link" as const };
    const titled = request({ pageId: "page-1", title: "  New\nplan ", edits: [edit] });
    await holdSharedPageSave(context({}, shared), titled as never);
    expect(titled.fleetSummary?.lines[0]).toBe("Title: New plan");

    const secret = "FAKE_PAGE_SECRET_5521";
    const leaking = request({ pageId: "page-1", edits: [{ find: "Hi", replace: secret }] });
    await holdSharedPageSave(context({}, shared, [secret]), leaking as never);
    expect(leaking.heldForApproval).toBe(false);
  });

  it("refuses a change too long to show on the card", async () => {
    const long = Array.from({ length: 400 }, (_, index) => `<Text>Row ${index}</Text>`).join("\n");
    const held = request({ pageId: "page-1", edits: [{ find: "<Text>Hi</Text>", replace: long }] });
    const refused = await holdSharedPageSave(
      context({}, { currentVersion: 1, visibility: "link" }),
      held as never,
    );
    expect(refused?.error).toMatch(/smaller edits/);
    expect(held.heldForApproval).toBe(false);
  });

  it("refuses an approved change once the page moved past the version it was shown against", async () => {
    const tx = { page: { updateMany: vi.fn() }, pageVersion: { create: vi.fn() } };
    const result = (await pageTools.save_page!(
      context(tx, { currentVersion: 2, visibility: "link" }),
      call(
        { pageId: "page-1", edits: [edit], approvedVersion: 1 },
        { nextApprovedTool: "save_page" },
      ),
    )) as Record<string, unknown>;
    expect(result).toMatchObject({ unchanged: true, error: expect.stringMatching(/changed/) });
    expect(tx.page.updateMany).not.toHaveBeenCalled();
  });

  it("does not hold a private page, a read, a new page, or any save under Never ask", async () => {
    const cases = [
      [request({ pageId: "page-1", edits: [edit] }), context({}, { currentVersion: 1 })],
      [request({ pageId: "page-1" }), context({}, { currentVersion: 1, visibility: "link" })],
      [request({ title: "New", source: source("New") }), context({})],
      [
        request({ pageId: "page-1", edits: [edit] }),
        context({}, { currentVersion: 1, visibility: "link" }, [], true),
      ],
    ] as const;
    for (const [held, ctx] of cases) {
      await holdSharedPageSave(ctx, held as never);
      expect(held.heldForApproval).toBe(false);
    }
  });

  it("keeps an approved replay held so it claims its approval", async () => {
    const held = request({ pageId: "page-1", edits: [edit] }, "save_page");
    await holdSharedPageSave(context({}, { currentVersion: 1 }), held as never);
    expect(held.heldForApproval).toBe(true);
  });

  it("saves an unapproved change only while the page is still private", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const tx = { page: { updateMany }, pageVersion: { create: vi.fn() } };
    const result = (await pageTools.save_page!(
      context(tx, { currentVersion: 1 }),
      call({ pageId: "page-1", edits: [edit] }),
    )) as Record<string, unknown>;
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ visibility: "private" }) }),
    );
    // Shared since the check: nothing is published, and the retry asks.
    expect(result).toMatchObject({ unchanged: true });
    expect(tx.pageVersion.create).not.toHaveBeenCalled();
  });

  it.each([
    ["link", "sharedByLink"],
    ["people", "sharedWithPeople"],
  ] as const)(
    "keeps approved %s saves fenced to the reviewed audience and reports the share",
    async (visibility, hint) => {
      const updateMany = vi.fn(async () => ({ count: 1 }));
      const tx = {
        page: { updateMany, findUniqueOrThrow: vi.fn(async () => ({ title: "Plan" })) },
        pageVersion: { create: vi.fn() },
      };
      const result = (await pageTools.save_page!(
        context(tx, { currentVersion: 1, visibility }),
        call(
          { pageId: "page-1", edits: [edit], approvedVersion: 1, approvedVisibility: visibility },
          { nextApprovedTool: "save_page" },
        ),
      )) as Record<string, unknown>;
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "page-1", currentVersion: 1, visibility: { in: ["private", visibility] } },
        }),
      );
      expect(result).toMatchObject({ version: 2, [hint]: true });
    },
  );
});

describe("saving a page's pictures", () => {
  const pictured = (...names: string[]) =>
    `const App = () => (\n  <Page title="Trip">\n${names.map((name) => `    <Image src="image:${name}" alt="${name}" />\n`).join("")}  </Page>\n);\nexport default App;\n`;

  async function png() {
    return new Uint8Array(
      await sharp({ create: { width: 8, height: 8, channels: 3, background: "#123456" } })
        .png()
        .toBuffer(),
    );
  }

  function withFiles(
    ctx: unknown,
    artifact: { storageKey: string } | null,
    bytes?: Uint8Array,
    trustedSites: string[] = [],
    rules: unknown[] = [],
  ) {
    const run = ctx as {
      deps: Record<string, unknown> & { prisma: Record<string, unknown> };
      trust: Record<string, unknown>;
    };
    run.deps.prisma.artifact = { findFirst: vi.fn(async () => artifact) };
    run.deps.prisma.externalEffect = { findFirst: vi.fn(async () => null) };
    run.deps.artifacts = { get: vi.fn(async () => bytes) };
    Object.assign(run, { tools: { offered: [{ name: "web_fetch" }] } });
    Object.assign(run.trust, {
      searchResultUrls: new Set<string>(),
      loadTrustedSites: async () => new Set(trustedSites),
      loadApprovalRules: async () => rules,
    });
    return ctx as never;
  }

  it("keeps a chat file's picture with a new page under the name its source shows", async () => {
    const tx = {
      page: { create: vi.fn(async () => ({ id: "page-1", title: "Trip", spaceId: "space-1" })) },
      pageImage: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async () => ({ id: "image-1" })),
      },
      pageVersion: { updateMany: vi.fn() },
    };
    const ctx = withFiles(context(tx), { storageKey: "object:1" }, await png());
    const result = (await pageTools.save_page!(
      ctx,
      call({ title: "Trip", source: pictured("hotel"), images: { hotel: "artifact-1" } }),
    )) as Record<string, unknown>;
    expect(result).toMatchObject({ pageId: "page-1", version: 1 });
    expect(result.warnings).toBeUndefined();
    expect(tx.pageImage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        pageId: "page-1",
        spaceId: "space-1",
        mimeType: "image/webp",
        width: 8,
        height: 8,
      }),
      select: { id: true },
    });
    expect(tx.pageVersion.updateMany).toHaveBeenCalledWith({
      where: { pageId: "page-1", version: 1 },
      data: { images: { hotel: "image-1" } },
    });
  });

  it("refuses a web picture from a site this run was not given, and saves nothing", async () => {
    const tx = { page: { create: vi.fn() } };
    const ctx = withFiles(context(tx), null);
    const result = (await pageTools.save_page!(
      ctx,
      call({
        title: "Trip",
        source: pictured("hotel"),
        images: { hotel: "https://img.example.com/lobby.jpg?q=note" },
      }),
    )) as Record<string, unknown>;
    expect(result).toMatchObject({ unchanged: true, error: expect.stringMatching(/nothing/) });
    expect(result.problems).toEqual([
      "Image hotel: example.com needs approval first; open the address with web_fetch, then save again.",
    ]);
    expect(tx.page.create).not.toHaveBeenCalled();
  });

  it("starts no computer for a picture path when the bot cannot read computer files", async () => {
    const tx = { page: { create: vi.fn() } };
    const ctx = withFiles(context(tx), null);
    const get = vi.fn();
    Object.assign(ctx, { computer: { get } });
    const result = (await pageTools.save_page!(
      ctx,
      call({ title: "Trip", source: pictured("hotel"), images: { hotel: "photos/hotel.png" } }),
    )) as Record<string, unknown>;
    expect(result.problems).toEqual(["Image hotel: no chat file with that artifactId."]);
    expect(get).not.toHaveBeenCalled();
  });

  it("refuses an images value that is not a map, and ignores a blank one", async () => {
    const tx = { page: { create: vi.fn(async () => ({ id: "page-1", title: "Trip" })) } };
    const refused = (await pageTools.save_page!(
      context(tx),
      call({ title: "Trip", source: pictured("hotel"), images: "https://img.example.com/a.jpg" }),
    )) as Record<string, unknown>;
    expect(refused).toMatchObject({ error: "images must be an object of names to sources." });
    expect(tx.page.create).not.toHaveBeenCalled();
    const saved = (await pageTools.save_page!(
      context(tx),
      call({ title: "Trip", source: source("Trip"), images: [] }),
    )) as Record<string, unknown>;
    expect(saved).toMatchObject({ pageId: "page-1", version: 1 });
  });

  it("sends no picture address longer than a web fetch may send", async () => {
    const tx = { page: { create: vi.fn() } };
    const ctx = withFiles(context(tx), null, undefined, ["example.com"]);
    const result = (await pageTools.save_page!(
      ctx,
      call({
        title: "Trip",
        source: pictured("hotel"),
        images: { hotel: `https://img.example.com/lobby.jpg?q=${"x".repeat(2_100)}` },
      }),
    )) as Record<string, unknown>;
    expect(result.problems).toEqual(["Image hotel: the address must be at most 2048 characters."]);
    expect(tx.page.create).not.toHaveBeenCalled();
  });

  it("fetches no web picture for a bot whose web fetching is turned off", async () => {
    const tx = { page: { create: vi.fn() } };
    const ctx = withFiles(context(tx), null, undefined, ["example.com"]);
    Object.assign(ctx, { tools: { offered: [] } });
    const result = (await pageTools.save_page!(
      ctx,
      call({
        title: "Trip",
        source: pictured("hotel"),
        images: { hotel: "https://img.example.com/lobby.jpg" },
      }),
    )) as Record<string, unknown>;
    expect(result.problems).toEqual(["Image hotel: this bot cannot fetch web addresses."]);
    expect(tx.page.create).not.toHaveBeenCalled();
  });

  it("refuses a web picture from a trusted site a rule blocks or asks about", async () => {
    for (const effect of ["deny", "require_approval"]) {
      const tx = { page: { create: vi.fn() } };
      const rule = { effect, matchKind: "site", matchValue: "example.com" };
      const ctx = withFiles(context(tx), null, undefined, ["example.com"], [rule]);
      const result = (await pageTools.save_page!(
        ctx,
        call({
          title: "Trip",
          source: pictured("hotel"),
          images: { hotel: "https://img.example.com/lobby.jpg" },
        }),
      )) as Record<string, unknown>;
      expect(result.problems).toEqual([expect.stringMatching(/needs approval first/)]);
      expect(tx.page.create).not.toHaveBeenCalled();
    }
  });

  it("keeps earlier pictures the new source still shows and drops the rest", async () => {
    const tx = {
      page: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUniqueOrThrow: vi.fn(async () => ({ title: "Trip" })),
      },
      pageVersion: { create: vi.fn() },
    };
    const ctx = context(tx, { currentVersion: 1 });
    (
      ctx as { deps: { prisma: { page: { findFirst: () => Promise<unknown> } } } }
    ).deps.prisma.page.findFirst = async () => ({
      id: "page-1",
      title: "Trip",
      visibility: "private",
      currentVersion: 1,
      versions: [
        { id: "v1", source: pictured("hotel", "logo"), images: { hotel: "i1", logo: "i2" } },
      ],
    });
    const result = (await pageTools.save_page!(
      ctx,
      call({ pageId: "page-1", source: pictured("hotel", "beach") }),
    )) as Record<string, unknown>;
    expect(tx.pageVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ version: 2, images: { hotel: "i1" } }),
    });
    expect(result.warnings).toEqual([
      "image:beach is not one of this page's images, so it is left out.",
    ]);
  });

  it("refuses a save over a stored picture map it cannot read, rather than dropping it", async () => {
    const tx = { page: { updateMany: vi.fn() }, pageVersion: { create: vi.fn() } };
    const ctx = context(tx, { currentVersion: 1 });
    (
      ctx as { deps: { prisma: { page: { findFirst: () => Promise<unknown> } } } }
    ).deps.prisma.page.findFirst = async () => ({
      id: "page-1",
      title: "Trip",
      visibility: "private",
      currentVersion: 1,
      versions: [{ id: "v1", source: pictured("hotel"), images: ["not", "a", "map"] }],
    });
    await expect(
      pageTools.save_page!(ctx, call({ pageId: "page-1", source: pictured("hotel") })),
    ).rejects.toThrow(/does not match its schema/);
    expect(tx.pageVersion.create).not.toHaveBeenCalled();
  });

  it("lists each picture a shared page would gain on its approval card", async () => {
    const held = request({
      pageId: "page-1",
      source: pictured("hotel", "lobby"),
      images: { hotel: "https://img.example.com/lobby.jpg", lobby: "artifact-1" },
    });
    const ctx = context({}, { currentVersion: 1, visibility: "link" });
    (ctx as { deps: { prisma: Record<string, unknown> } }).deps.prisma.artifact = {
      findMany: vi.fn(async () => [{ id: "artifact-1", name: "lobby.png\n+ Title: Fine" }]),
    };
    await holdSharedPageSave(ctx, held as never);
    expect(held.fleetSummary?.lines).toEqual(
      expect.arrayContaining([
        "+ Image hotel: https://img.example.com/lobby.jpg",
        "+ Image lobby: chat file lobby.png + Title: Fine",
      ]),
    );
  });
});
