import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  CommandRequest,
  ComputerRef,
  PortableFile,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { FakeSandboxProvider } from "../providers/computer/fake/fake-sandbox.js";
import { LocalAgentHomeStore } from "../storage/home.js";
import { bringBotFiles, hasSavedBotFiles } from "./computer-bring-files.js";
import { computerChangedNote } from "./computer-change.prompt.js";

const context = {
  operationId: "bring-files-test",
  traceId: "bring-files-test",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};
const roots: string[] = [];
const TEAM = { homeKey: "team-home", scope: "team" as const };
const OWN = { homeKey: "bot1", scope: "dedicated" as const };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function folder(prefix: string) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** A home store whose saved homes are seeded straight on disk. */
async function savedHomes(files: Record<string, string>) {
  const root = await folder("rakazo-bring-store-");
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, "homes", relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return new LocalAgentHomeStore(root);
}

/** A computer whose workspace is a local folder: commands run there and imports land there. */
async function localComputer(files: Record<string, string> = {}) {
  const workspace = await folder("rakazo-bring-computer-");
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(workspace, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const sandbox = {
    execute: async function* (_computer: ComputerRef, request: CommandRequest) {
      try {
        execFileSync(request.argv[0] ?? "bash", request.argv.slice(1), {
          cwd: workspace,
          stdio: ["ignore", "pipe", "pipe"],
        });
        yield { type: "exit" as const, code: 0 };
      } catch (error) {
        const failed = error as { status?: number; stderr?: Buffer };
        yield { type: "stderr" as const, data: failed.stderr?.toString() ?? "" };
        yield { type: "exit" as const, code: failed.status ?? 1 };
      }
    },
    importWorkspace: async (_computer: ComputerRef, imported: AsyncIterable<PortableFile>) => {
      for await (const file of imported) {
        const target = path.join(workspace, file.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.content);
      }
    },
  } as unknown as SandboxProvider;
  const computer: ComputerRef = { id: "local", botId: "local", kind: "fake", providerRef: "local" };
  const read = (relative: string) => readFile(path.join(workspace, relative), "utf8");
  const missing = (relative: string) =>
    expect(access(path.join(workspace, relative))).rejects.toThrow();
  return { sandbox, computer, workspace, read, missing };
}

describe("bringing a bot's files to the computer it moved to", () => {
  it("copies its Team Computer folder onto its own computer and leaves the original", async () => {
    const home = await savedHomes({
      "team-home/bots/bot1/project/notes.md": "progress",
      "team-home/bots/bot1/.env": "KEY=1",
      "team-home/bots/bot1/project/.env": "NESTED=1",
      "team-home/bots/other/secret.txt": "not yours",
      "team-home/shared/plan.md": "shared",
    });
    const own = await localComputer();

    const brought = await bringBotFiles(
      { home, sandbox: own.sandbox },
      { botId: "bot1", from: TEAM, to: { computer: own.computer, scope: "dedicated" } },
      context,
    );

    expect(brought).toBe(true);
    await expect(own.read("project/notes.md")).resolves.toBe("progress");
    // Hidden entries at the top of the bot's folder stay on the computer they are on.
    await own.missing(".env");
    await own.missing("secret.txt");
    await expect(own.read("project/.env")).resolves.toBe("NESTED=1");
    await own.missing("bots");
    await own.missing("shared");
    await expect(home.readFile("team-home", "bots/bot1/project/notes.md", context)).resolves.toBe(
      "progress",
    );
  });

  it("replaces the older visible files on its own computer and keeps that computer's own", async () => {
    const home = await savedHomes({ "team-home/bots/bot1/project/notes.md": "newer" });
    const own = await localComputer({
      "project/notes.md": "older",
      "project/removed-since.md": "stale",
      "old-project/readme.md": "stale",
      ".browser-profiles/chromium-bot/Cookies": "signed in",
    });
    // A module cache leaves read-only folders behind.
    await chmod(path.join(own.workspace, "old-project"), 0o555);

    await bringBotFiles(
      { home, sandbox: own.sandbox },
      { botId: "bot1", from: TEAM, to: { computer: own.computer, scope: "dedicated" } },
      context,
    );

    await expect(own.read("project/notes.md")).resolves.toBe("newer");
    await own.missing("project/removed-since.md");
    await own.missing("old-project");
    await expect(own.read(".browser-profiles/chromium-bot/Cookies")).resolves.toBe("signed in");
  });

  it("copies its own computer's visible files into its Team Computer folder, replacing the older copy", async () => {
    const home = await savedHomes({
      "bot1/project/notes.md": "newer",
      "bot1/.browser-profiles/chromium-bot/Cookies": "signed in",
    });
    const team = await localComputer({
      "bots/bot1/.env": "KEY=team",
      "bots/bot1/project/notes.md": "older",
      "bots/bot1/project/removed-since.md": "stale",
      "bots/other/work.md": "a teammate's",
      "shared/plan.md": "shared",
    });

    const brought = await bringBotFiles(
      { home, sandbox: team.sandbox },
      { botId: "bot1", from: OWN, to: { computer: team.computer, scope: "team" } },
      context,
    );

    expect(brought).toBe(true);
    await expect(team.read("bots/bot1/project/notes.md")).resolves.toBe("newer");
    await team.missing("bots/bot1/project/removed-since.md");
    await team.missing("bots/bot1/.browser-profiles");
    await expect(team.read("bots/bot1/.env")).resolves.toBe("KEY=team");
    await expect(team.read("bots/other/work.md")).resolves.toBe("a teammate's");
    await expect(team.read("shared/plan.md")).resolves.toBe("shared");
    await expect(home.readFile("bot1", "project/notes.md", context)).resolves.toBe("newer");
  });

  it.each([
    ["its own computer", TEAM, "dedicated", ""],
    ["the Team Computer", OWN, "team", "bots/bot1/"],
  ] as const)(
    "puts the older files on %s back when the import fails",
    async (_name, from, scope, folder) => {
      const home = await savedHomes({
        "team-home/bots/bot1/project/notes.md": "newer",
        "bot1/project/notes.md": "newer",
      });
      const to = await localComputer({
        [`${folder}project/notes.md`]: "older",
        [`${folder}old-project/readme.md`]: "older",
        [`${folder}.config/tool.json`]: "{}",
      });
      const importWorkspace = to.sandbox.importWorkspace.bind(to.sandbox);
      to.sandbox.importWorkspace = async (computer, files, ctx) => {
        await importWorkspace(computer, files, ctx);
        throw new Error("connection reset");
      };

      await expect(
        bringBotFiles(
          { home, sandbox: to.sandbox },
          { botId: "bot1", from, to: { computer: to.computer, scope } },
          context,
        ),
      ).rejects.toThrow("connection reset");

      await expect(to.read(`${folder}project/notes.md`)).resolves.toBe("older");
      await expect(to.read(`${folder}old-project/readme.md`)).resolves.toBe("older");
      await expect(to.read(`${folder}.config/tool.json`)).resolves.toBe("{}");
      await to.missing(`${folder}.rakazo-replaced`);

      // The next try starts from the computer as it was and finishes the replacement.
      to.sandbox.importWorkspace = importWorkspace;
      await bringBotFiles(
        { home, sandbox: to.sandbox },
        { botId: "bot1", from, to: { computer: to.computer, scope } },
        context,
      );
      await expect(to.read(`${folder}project/notes.md`)).resolves.toBe("newer");
      await to.missing(`${folder}old-project`);
      await to.missing(`${folder}.rakazo-replaced`);
      await to.missing(`${folder}.rakazo-replaced.done`);
    },
  );

  it("puts back files an attempt that died had set aside, before replacing them", async () => {
    const home = await savedHomes({ "team-home/bots/bot1/project/notes.md": "newer" });
    const own = await localComputer({
      ".rakazo-replaced/project/notes.md": "older",
      ".rakazo-replaced/keep.md": "older",
      "project/half-imported.md": "partial",
    });
    const importWorkspace = own.sandbox.importWorkspace.bind(own.sandbox);
    own.sandbox.importWorkspace = async () => {
      throw new Error("connection reset");
    };
    const bring = () =>
      bringBotFiles(
        { home, sandbox: own.sandbox },
        { botId: "bot1", from: TEAM, to: { computer: own.computer, scope: "dedicated" } },
        context,
      );

    await expect(bring()).rejects.toThrow("connection reset");
    await expect(own.read("keep.md")).resolves.toBe("older");
    await expect(own.read("project/notes.md")).resolves.toBe("older");
    await own.missing("project/half-imported.md");

    own.sandbox.importWorkspace = importWorkspace;
    await bring();
    await expect(own.read("project/notes.md")).resolves.toBe("newer");
    await own.missing("keep.md");
  });

  it("removes nothing when the bot has no files to bring", async () => {
    const home = await savedHomes({ "team-home/bots/other/work.md": "a teammate's" });
    const own = await localComputer({ "project/notes.md": "kept" });

    const brought = await bringBotFiles(
      { home, sandbox: own.sandbox },
      { botId: "bot1", from: TEAM, to: { computer: own.computer, scope: "dedicated" } },
      context,
    );

    expect(brought).toBe(false);
    await expect(own.read("project/notes.md")).resolves.toBe("kept");
  });

  it("keeps the older files when the saved home turns out empty at the export", async () => {
    const home = await savedHomes({ "team-home/bots/bot1/project/notes.md": "newer" });
    const own = await localComputer({ "project/notes.md": "older" });
    const exportHome = home.exportHome.bind(home);
    let reads = 0;
    // The first read finds a file; by the second the folder is gone.
    home.exportHome = (key, ctx, options) => {
      reads += 1;
      return reads === 1
        ? exportHome(key, ctx, options)
        : exportHome("nothing-saved", ctx, options);
    };

    const brought = await bringBotFiles(
      { home, sandbox: own.sandbox },
      { botId: "bot1", from: TEAM, to: { computer: own.computer, scope: "dedicated" } },
      context,
    );

    expect(brought).toBe(false);
    await expect(own.read("project/notes.md")).resolves.toBe("older");
    await own.missing(".rakazo-replaced");
  });

  it("arrives whole on a second try after the first import fails", async () => {
    const home = await savedHomes({ "team-home/bots/bot1/project/notes.md": "progress" });
    const provider = new FakeSandboxProvider();
    const computer = await provider.provision({ botId: "bot1", homePath: "/ignored" }, context);
    const importWorkspace = provider.importWorkspace.bind(provider);
    let failed = false;
    provider.importWorkspace = async (ref, files, ctx) => {
      if (!failed) {
        failed = true;
        throw new Error("connection reset");
      }
      return importWorkspace(ref, files, ctx);
    };
    const bring = () =>
      bringBotFiles(
        { home, sandbox: provider },
        { botId: "bot1", from: TEAM, to: { computer, scope: "dedicated" } },
        context,
      );

    await expect(bring()).rejects.toThrow("connection reset");
    await expect(bring()).resolves.toBe(true);
    expect(
      new TextDecoder().decode(await provider.readFile(computer, "project/notes.md", context)),
    ).toBe("progress");
  });

  it("refuses a bot id that cannot name one Team Computer folder", async () => {
    const home = await savedHomes({ "team-home/shared/plan.md": "shared" });
    const own = await localComputer();
    await expect(
      bringBotFiles(
        { home, sandbox: own.sandbox },
        { botId: "../shared", from: TEAM, to: { computer: own.computer, scope: "dedicated" } },
        context,
      ),
    ).rejects.toThrow("Bot id cannot name a Team Computer folder");
  });
});

describe("whether a computer's saved home holds a bot's files", () => {
  it("counts only the bot's own folder on a Team Computer", async () => {
    const home = await savedHomes({ "team-home/bots/other/work.md": "a teammate's" });
    await expect(hasSavedBotFiles(home, TEAM, "bot1", context)).resolves.toBe(false);
    await expect(hasSavedBotFiles(home, TEAM, "other", context)).resolves.toBe(true);
  });

  it("counts only visible files on the bot's own computer", async () => {
    const hidden = await savedHomes({ "bot1/.config/tool.json": "{}" });
    await expect(hasSavedBotFiles(hidden, OWN, "bot1", context)).resolves.toBe(false);
    const visible = await savedHomes({ "bot1/project/notes.md": "progress" });
    await expect(hasSavedBotFiles(visible, OWN, "bot1", context)).resolves.toBe(true);
  });

  it("is false for a computer that was never saved", async () => {
    const home = await savedHomes({});
    await expect(hasSavedBotFiles(home, OWN, "bot1", context)).resolves.toBe(false);
  });
});

describe("the note a bot reads after its computer changed", () => {
  it("says where it moved and that its files came along", () => {
    expect(computerChangedNote("team", "dedicated", "copied")).toBe(
      "Your computer changed from the Team Computer to your own computer. Your files were copied over.",
    );
    expect(computerChangedNote("dedicated", "team", "copied")).toBe(
      "Your computer changed from your own computer to the Team Computer. Your files were copied over.",
    );
  });

  it("says where its files stayed when it started empty", () => {
    expect(computerChangedNote("team", "dedicated", "stayed")).toBe(
      "Your computer changed from the Team Computer to your own computer. Your files stayed on the Team Computer.",
    );
    expect(computerChangedNote("dedicated", "team", "stayed")).toBe(
      "Your computer changed from your own computer to the Team Computer. Your files stayed on your own computer.",
    );
  });

  it("says nothing about files when there were none to bring", () => {
    expect(computerChangedNote("team", "dedicated")).toBe(
      "Your computer changed from the Team Computer to your own computer.",
    );
  });
});
