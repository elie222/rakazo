import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { createLogger, createTestSink, getLogger, installLogger } from "@rakazo/logging";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { LocalAgentHomeStore } from "../../storage/home.js";
import { createReceivedFilesPruner } from "./prune-received-files.js";

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
};

async function setup(
  computers: ComputerRow[],
  files: Record<string, string[]>,
  /** The rows a read under the lease finds, when they changed since the page was read. */
  current: ComputerRow[] = computers,
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
    $queryRaw: queryRaw,
  } as unknown as PrismaClient;
  const sandbox = {
    describe: () => ({ capabilities: { persistentHome: false } }),
  } as unknown as SandboxProvider;
  let now = NOW;
  const prune = createReceivedFilesPruner({
    prisma,
    home,
    sandbox,
    enabled: true,
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

const OLD = "shared/received/2026/09/2026-09-28_0900_alice_old.pdf";
const FRESH = "shared/received/2026/11/2026-11-07_0900_alice_fresh.pdf";

describe("createReceivedFilesPruner", () => {
  it("does nothing while the setting is off", () => {
    const off = createReceivedFilesPruner({
      prisma: {} as PrismaClient,
      home: {} as LocalAgentHomeStore,
      sandbox: {} as SandboxProvider,
      enabled: false,
    });
    expect(off).toBeUndefined();
  });

  it("deletes a 40-day-old copy, keeps a 10-day-old one and tidies emptied folders", async () => {
    const { prune, names } = await setup([team], {
      "team-home": [
        "shared/received/2026/10/2026-10-08_0900_alice_old.pdf",
        FRESH,
        OLD,
        "shared/received/2026/11/notes.txt",
      ],
    });

    await prune();

    expect(await names("team-home", "shared/received/2026")).toEqual(["11"]);
    expect(await names("team-home", "shared/received/2026/11")).toEqual([
      "2026-11-07_0900_alice_fresh.pdf",
      "notes.txt",
    ]);
  });

  it("removes emptied month and year folders but keeps the received folder", async () => {
    const { prune, names } = await setup([team], { "team-home": [OLD] });

    await prune();

    expect(await names("team-home", "shared/received")).toEqual([]);
  });

  it("goes by the date in the name and leaves other files alone", async () => {
    const { prune, names } = await setup([{ ...team, scope: "dedicated" }], {
      "team-home": [
        "received/2026/11/notes.txt",
        "received/2026/11/2026-11-07_0900_alice_fresh.pdf",
        "received/2025/readme.md",
        "notes/2026-01-01_0900_alice_keep.pdf",
        "received/2026/09/2026-09-01_0900_a_b.pdf",
      ],
    });

    await prune();

    expect(await names("team-home", "received/2026/11")).toHaveLength(2);
    expect(await names("team-home", "received/2025")).toEqual(["readme.md"]);
    expect(await names("team-home", "received/2026/09")).toEqual([]);
    expect(await names("team-home", "notes")).toHaveLength(1);
  });

  it("keeps names whose date is not real or does not match their folders", async () => {
    const kept = [
      "received/2026/08/2026-13-45_0900_x.pdf",
      "received/2026/08/2026-08-31_2460_x.pdf",
      "received/2026/08/2026-08-31_2400_x.pdf",
      "received/2026/02/2026-02-30_0900_x.pdf",
      "received/2026/09/2026-01-05_0900_x.pdf",
      "received/2025/09/2026-09-05_0900_x.pdf",
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
      "shared/received",
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

  it("does not run again within a day, then runs once it has passed", async () => {
    const { prune, prisma, advance } = await setup([team], { "team-home": [FRESH] });

    await prune();
    advance(23 * 60 * 60_000);
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

    expect(await names("team-home", "shared/received/2026/09")).toHaveLength(1);
  });

  it("skips a running Docker computer, whose container mounts its home", async () => {
    const running = { ...team, state: "running", providerRef: "ctr-1" };
    const { prune, names } = await setup([running], { "team-home": [OLD] });

    await prune();

    expect(await names("team-home", "shared/received/2026/09")).toHaveLength(1);
  });

  it("skips a computer that started after the page of computers was read", async () => {
    const started = { ...team, state: "booting" };
    const { prune, names } = await setup([team], { "team-home": [OLD] }, [started]);

    await prune();

    expect(await names("team-home", "shared/received/2026/09")).toHaveLength(1);
  });

  it("takes the computer's received-files lease, like a save does", async () => {
    const { prune, queryRaw } = await setup([team], { "team-home": [OLD] });

    await prune();

    const queries = queryRaw.mock.calls.map(([query, ...values]) => ({
      sql: (query as TemplateStringsArray).join("?"),
      values,
    }));
    expect(queries[0]!.sql).toContain("INSERT INTO");
    expect(queries[0]!.values).toContain("received-files:computer-1");
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

    expect(await names("team-home", "shared/received/2026/09")).toHaveLength(1);
    expect(await names("other-home", "shared/received")).toEqual([]);
  });

  it("does not create the received folder in a home that has none", async () => {
    const { prune, names } = await setup([team], { "team-home": ["notes.txt"] });

    await prune();

    expect(await names("team-home", "")).toEqual(["notes.txt"]);
  });

  it("never deletes through a link out of the received folder", async () => {
    const { prune, home } = await setup([team], { "team-home": [FRESH] });
    const outside = await mkdtemp(path.join(tmpdir(), "rakazo-outside-"));
    onTestFinished(() => rm(outside, { recursive: true, force: true }));
    await mkdir(path.join(outside, "09"));
    const victim = path.join(outside, "09", "2026-09-28_0900_alice_old.pdf");
    await writeFile(victim, "x");
    await symlink(
      outside,
      path.join(home.pathFor("team-home"), "shared/received/2024"),
      "junction",
    );

    await prune();

    expect((await stat(victim)).isFile()).toBe(true);
  });
});
