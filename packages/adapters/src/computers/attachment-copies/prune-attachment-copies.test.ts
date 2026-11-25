import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { createLogger, createTestSink, getLogger, installLogger } from "@rakazo/logging";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { LocalAgentHomeStore } from "../../storage/home.js";
import { createAttachmentCopiesPruner } from "./prune-attachment-copies.js";

const DAY = 24 * 60 * 60_000;
const NOW = new Date("2026-11-17T12:00:00Z");

type ComputerRow = {
  id: string;
  spaceId: string;
  userId: string;
  scope: string;
  homeKey: string;
  kind: string;
  providerRef: string | null;
  state: string;
  updatedAt: Date;
};

const team: ComputerRow = {
  id: "computer-1",
  spaceId: "space-1",
  userId: "user-1",
  scope: "team",
  homeKey: "team-home",
  kind: "docker",
  providerRef: null,
  state: "stopped",
  updatedAt: new Date("2026-11-01T00:00:00Z"),
};

async function setup(
  computers: ComputerRow[],
  files: Record<string, string[]>,
  /** The rows a read under the lease finds, when they changed since the page was read. */
  current: ComputerRow[] = computers,
  /** The attachment rows, by id, with their space and age. */
  artifacts: Array<{ id: string; spaceId: string; createdAt: Date }> = [],
  settings: Partial<{ intervalMs: number }> = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "rakazo-prune-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const home = new LocalAgentHomeStore(root);
  for (const [homeKey, list] of Object.entries(files)) {
    for (const file of list) {
      const full = path.join(home.pathFor(homeKey), file);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, "x");
    }
  }
  const queryRaw = vi.fn(async (query: TemplateStringsArray) =>
    query.join("").includes("INSERT INTO") ? [{ fence: 1n }] : [{}],
  );
  const prisma = {
    computer: {
      findMany: vi.fn(async () => computers),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          current.find((row) => row.id === where.id) ?? null,
      ),
    },
    artifact: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] }; spaceId: string } }) =>
        artifacts.filter((row) => where.id.in.includes(row.id) && row.spaceId === where.spaceId),
      ),
    },
    $queryRaw: queryRaw,
  } as unknown as PrismaClient;
  const sandbox = {
    describe: () => ({ capabilities: { persistentHome: false } }),
  } as unknown as SandboxProvider;
  let now = NOW;
  const prune = createAttachmentCopiesPruner({
    prisma,
    home,
    sandbox,
    settings: {
      attachments: true,
      received: false,
      created: false,
      maxAgeMs: 31 * DAY,
      intervalMs: DAY,
      ...settings,
    },
    now: () => now,
  });
  const names = async (homeKey: string, dir: string) =>
    readdir(path.join(home.pathFor(homeKey), dir)).catch(() => []);
  return {
    prune: prune!,
    prisma,
    queryRaw,
    home,
    names,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

const artifactId = (name: string) => `c${name.padEnd(24, "0")}`;

const OLD = "bots/b1/attachments/2026/09/2026-09-28_0900_alice_old.pdf";
const FRESH = "bots/b1/attachments/2026/11/2026-11-07_0900_alice_fresh.pdf";

describe("createAttachmentCopiesPruner", () => {
  it("does nothing while the cleanup is off", () => {
    const off = createAttachmentCopiesPruner({
      prisma: {} as PrismaClient,
      home: {} as LocalAgentHomeStore,
      sandbox: {} as SandboxProvider,
      settings: {
        attachments: false,
        received: false,
        created: false,
        maxAgeMs: 31 * DAY,
        intervalMs: DAY,
      },
    });
    expect(off).toBeUndefined();
  });

  it("deletes a 40-day-old copy, keeps a 10-day-old one and tidies emptied folders", async () => {
    const { prune, names } = await setup([team], {
      "team-home": [
        "bots/b1/attachments/2026/10/2026-10-08_0900_alice_old.pdf",
        FRESH,
        OLD,
        "bots/b1/attachments/2026/11/notes.txt",
      ],
    });

    await prune();

    expect(await names("team-home", "bots/b1/attachments/2026")).toEqual(["11"]);
    expect(await names("team-home", "bots/b1/attachments/2026/11")).toEqual([
      "2026-11-07_0900_alice_fresh.pdf",
      "notes.txt",
    ]);
  });

  it("removes emptied month and year folders but keeps the attachments folder", async () => {
    const { prune, names } = await setup([team], { "team-home": [OLD] });

    await prune();

    expect(await names("team-home", "bots/b1/attachments")).toEqual([]);
  });

  it("goes by the date in the name and leaves other files alone", async () => {
    const { prune, names } = await setup([{ ...team, scope: "dedicated" }], {
      "team-home": [
        "attachments/2026/11/notes.txt",
        "attachments/2026/11/2026-11-07_0900_alice_fresh.pdf",
        "attachments/2025/readme.md",
        "notes/2026-01-01_0900_alice_keep.pdf",
        "attachments/2026/09/2026-09-01_0900_a_b.pdf",
      ],
    });

    await prune();

    expect(await names("team-home", "attachments/2026/11")).toHaveLength(2);
    expect(await names("team-home", "attachments/2025")).toEqual(["readme.md"]);
    expect(await names("team-home", "attachments/2026/09")).toEqual([]);
    expect(await names("team-home", "notes")).toHaveLength(1);
  });

  it("keeps names whose date is not real or does not match their folders", async () => {
    const kept = [
      "attachments/2026/08/2026-13-45_0900_x.pdf",
      "attachments/2026/08/2026-08-31_2460_x.pdf",
      "attachments/2026/08/2026-08-31_2400_x.pdf",
      "attachments/2026/02/2026-02-30_0900_x.pdf",
      "attachments/2026/09/2026-01-05_0900_x.pdf",
      "attachments/2025/09/2026-09-05_0900_x.pdf",
    ];
    const { prune, home } = await setup([{ ...team, scope: "dedicated" }], {
      "team-home": kept,
    });

    await prune();

    for (const file of kept) {
      expect((await stat(path.join(home.pathFor("team-home"), file))).isFile()).toBe(true);
    }
  });

  it("hands the lease's signal to the deletion", async () => {
    const { prune, home } = await setup([team], { "team-home": [OLD] });
    const removeFiles = vi.spyOn(home, "removeFiles");

    await prune();

    expect(removeFiles).toHaveBeenCalledWith(
      "team-home",
      [OLD],
      "bots/b1/attachments",
      expect.anything(),
      { signal: expect.any(AbortSignal) },
    );
  });

  it("logs a failed prune by its code, never by the path of the file", async () => {
    const sink = createTestSink();
    const previous = getLogger();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    onTestFinished(() => installLogger(previous));
    const { prune, home } = await setup([team], { "team-home": [OLD] });
    const where = path.join(home.pathFor("team-home"), OLD);
    vi.spyOn(home, "removeFiles").mockRejectedValue(
      Object.assign(new Error(`EACCES: permission denied, unlink '${where}'`), {
        code: "EACCES",
        path: where,
      }),
    );

    await prune();

    const logged = JSON.stringify(sink.events);
    expect(logged).toContain("EACCES");
    expect(logged).not.toContain("alice");
    expect(logged).not.toContain("team-home");
  });

  it("does not run again within the interval, then runs once it has passed", async () => {
    const { prune, prisma, advance } = await setup(
      [team],
      { "team-home": [FRESH] },
      undefined,
      [],
      { intervalMs: 6 * 60 * 60_000 },
    );

    await prune();
    advance(5 * 60 * 60_000);
    await prune();
    expect(prisma.computer.findMany).toHaveBeenCalledOnce();

    advance(2 * 60 * 60_000);
    await prune();
    expect(prisma.computer.findMany).toHaveBeenCalledTimes(2);
  });

  it("skips a computer whose home the server does not hold", async () => {
    const remote = { ...team, kind: "e2b", state: "running", providerRef: "sbx-1" };
    const { prune, names } = await setup([remote], { "team-home": [OLD] });

    await prune();

    expect(await names("team-home", "bots/b1/attachments/2026/09")).toHaveLength(1);
  });

  it("skips a running Docker computer, whose container mounts its home", async () => {
    const running = { ...team, state: "running", providerRef: "ctr-1" };
    const { prune, names } = await setup([running], { "team-home": [OLD] });

    await prune();

    expect(await names("team-home", "bots/b1/attachments/2026/09")).toHaveLength(1);
  });

  it("prunes an asleep Docker computer, whose container is stopped", async () => {
    const asleep = { ...team, state: "suspended", providerRef: "ctr-1" };
    const { prune, names } = await setup([asleep], { "team-home": [OLD] });

    await prune();

    expect(await names("team-home", "bots/b1/attachments")).toEqual([]);
  });

  it("skips an asleep remote computer, which resumes on its own disk", async () => {
    const asleep = { ...team, kind: "e2b", state: "suspended", providerRef: "sbx-1" };
    const { prune, names } = await setup([asleep], { "team-home": [OLD] });

    await prune();

    expect(await names("team-home", "bots/b1/attachments/2026/09")).toHaveLength(1);
  });

  it("stops deleting once the computer wakes partway through", async () => {
    const files = Array.from(
      { length: 60 },
      (_, index) => `bots/b1/attachments/2026/09/2026-09-28_0900_alice_${index}.pdf`,
    );
    const { prune, prisma, names } = await setup([team], { "team-home": files });
    const woke = { ...team, state: "booting", updatedAt: new Date("2026-11-17T11:59:00Z") };
    // The first look and the one before the first batch see it stopped, the next one awake.
    vi.mocked(prisma.computer.findUnique)
      .mockResolvedValueOnce(team as never)
      .mockResolvedValueOnce(team as never)
      .mockResolvedValue(woke as never);

    await prune();

    expect(await names("team-home", "bots/b1/attachments/2026/09")).toHaveLength(35);
  });

  it("stops deleting once the computer was touched, even in the same state", async () => {
    const files = Array.from(
      { length: 30 },
      (_, index) => `bots/b1/attachments/2026/09/2026-09-28_0900_alice_${index}.pdf`,
    );
    const { prune, prisma, names } = await setup([team], { "team-home": files });
    const touched = { ...team, updatedAt: new Date("2026-11-17T11:59:00Z") };
    vi.mocked(prisma.computer.findUnique)
      .mockResolvedValueOnce(team as never)
      .mockResolvedValueOnce(team as never)
      .mockResolvedValue(touched as never);

    await prune();

    expect(await names("team-home", "bots/b1/attachments/2026/09")).toHaveLength(5);
  });

  it("deletes at most 500 files in one home per pass and leaves the rest for the next", async () => {
    const files = Array.from(
      { length: 510 },
      (_, index) => `bots/b1/attachments/2026/09/2026-09-28_0900_alice_${index}.pdf`,
    );
    const { prune, names, advance } = await setup([team], { "team-home": files });

    await prune();
    expect(await names("team-home", "bots/b1/attachments/2026/09")).toHaveLength(10);

    advance(25 * 60 * 60_000);
    await prune();
    expect(await names("team-home", "bots/b1/attachments")).toEqual([]);
  });

  it("skips a computer that started after the page of computers was read", async () => {
    const started = { ...team, state: "booting" };
    const { prune, names } = await setup([team], { "team-home": [OLD] }, [started]);

    await prune();

    expect(await names("team-home", "bots/b1/attachments/2026/09")).toHaveLength(1);
  });

  it("takes the computer's attachment-copies lease, like a copy does", async () => {
    const { prune, queryRaw } = await setup([team], { "team-home": [OLD] });

    await prune();

    const queries = queryRaw.mock.calls.map(([query, ...values]) => ({
      sql: (query as TemplateStringsArray).join("?"),
      values,
    }));
    expect(queries[0]!.sql).toContain("INSERT INTO");
    expect(queries[0]!.values).toContain("attachment-copies:computer-1");
    expect(queries.at(-1)!.sql).toContain("DELETE FROM");
  });

  it("leaves a computer another process holds and still prunes the next one", async () => {
    const other = { ...team, id: "computer-2", homeKey: "other-home" };
    const { prune, queryRaw, names } = await setup([team, other], {
      "team-home": [OLD],
      "other-home": [OLD],
    });
    queryRaw.mockImplementationOnce(async () => []);

    await prune();

    expect(await names("team-home", "bots/b1/attachments/2026/09")).toHaveLength(1);
    expect(await names("other-home", "bots/b1/attachments")).toEqual([]);
  });

  it("does not create the attachments folder in a home that has none", async () => {
    const { prune, names } = await setup([team], { "team-home": ["notes.txt"] });

    await prune();

    expect(await names("team-home", "")).toEqual(["notes.txt"]);
  });

  it("never deletes through a link out of the attachments folder", async () => {
    const { prune, home } = await setup([team], { "team-home": [FRESH] });
    const outside = await mkdtemp(path.join(tmpdir(), "rakazo-outside-"));
    onTestFinished(() => rm(outside, { recursive: true, force: true }));
    await mkdir(path.join(outside, "09"));
    const victim = path.join(outside, "09", "2026-09-28_0900_alice_old.pdf");
    await writeFile(victim, "x");
    await symlink(
      outside,
      path.join(home.pathFor("team-home"), "bots/b1/attachments/2024"),
      "junction",
    );

    await prune();

    expect((await stat(victim)).isFile()).toBe(true);
  });

  it("prunes each bot's attachments of a team home by its own folder", async () => {
    const mid = "bots/b2/attachments/2026/11/2026-11-07_0900_alice_fresh.pdf";
    const { prune, home, names } = await setup([team], { "team-home": [OLD, mid] });
    const removeFiles = vi.spyOn(home, "removeFiles");

    await prune();

    expect(removeFiles).toHaveBeenCalledOnce();
    expect(removeFiles.mock.calls[0]![2]).toBe("bots/b1/attachments");
    expect(await names("team-home", "bots/b1/attachments")).toEqual([]);
    expect(await names("team-home", "bots/b2/attachments/2026/11")).toHaveLength(1);
  });

  it("ages a name-dated file in the root by its name", async () => {
    const { prune, names } = await setup([{ ...team, scope: "dedicated" }], {
      "team-home": [
        "attachments/2026-09-01_1000_x_video.mp4",
        "attachments/2026-11-10_1000_x_video.mp4",
      ],
    });

    await prune();

    expect(await names("team-home", "attachments")).toEqual(["2026-11-10_1000_x_video.mp4"]);
  });

  it("ages a flat id-named file by its artifact, inside the computer's space", async () => {
    const dedicated = { ...team, scope: "dedicated" };
    const old = artifactId("old");
    const gone = artifactId("gone");
    const foreign = artifactId("foreign");
    const fresh = artifactId("fresh");
    const { prune, prisma, names } = await setup(
      [dedicated],
      {
        "team-home": [
          `attachments/${old}.mp4`,
          `attachments/${gone}.mp4`,
          `attachments/${foreign}.mp4`,
          `attachments/${fresh}.mp4`,
          "attachments/notes.txt",
        ],
      },
      undefined,
      [
        { id: old, spaceId: "space-1", createdAt: new Date(NOW.getTime() - 40 * DAY) },
        { id: foreign, spaceId: "space-2", createdAt: new Date(NOW.getTime() - 40 * DAY) },
        { id: fresh, spaceId: "space-1", createdAt: new Date(NOW.getTime() - 10 * DAY) },
      ],
    );

    await prune();

    expect((await names("team-home", "attachments")).sort()).toEqual(
      [`${fresh}.mp4`, `${foreign}.mp4`, `${gone}.mp4`, "notes.txt"].sort(),
    );
    expect(prisma.artifact.findMany).toHaveBeenCalledOnce();
    expect(vi.mocked(prisma.artifact.findMany).mock.calls[0]![0]).toMatchObject({
      where: { id: { in: expect.arrayContaining([old, gone]) }, spaceId: "space-1" },
    });
  });

  it("looks up no artifact for names that are not ids", async () => {
    const { prune, prisma } = await setup([{ ...team, scope: "dedicated" }], {
      "team-home": ["attachments/notes.txt", "attachments/a-old.mp4"],
    });

    await prune();

    expect(prisma.artifact.findMany).not.toHaveBeenCalled();
  });
});
