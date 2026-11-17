import type { AdapterContext } from "@rakazo/adapter-kit";
import { ClientError } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "../runs/executor/executor-deps.js";
import { importAgentsFromChat, prepareAgentImportRequest, readRunAgentExport } from "./chat.js";
import type { AgentImportServices } from "./write.js";
import { fakeImportServices, importedBot } from "./write.test-support.js";

/** Fake data only, in the shape a Grok Bot writes back. */
const bramble = {
  name: "Bramble",
  instructions: "Keep replies short.",
  memories: ["Weekly report goes out on Mondays."],
  skills: [{ name: "Weekly Account Health", instructions: "1. List accounts." }],
  routines: [
    { name: "Monday review", instruction: "Review accounts.", schedule_cron: "0 8 * * 1" },
    { name: "Triage issues", instruction: "Label new issues.", trigger: "linear" },
  ],
  apps: [{ name: "Gmail" }],
};
// Built from parts so no scanner mistakes this file for a leak.
const fakeKey = ["sk", "-proj-", "Ab3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z"].join("");
const wren = {
  name: "Wren",
  description: `Uses ${fakeKey}`,
  instructions: `Plan trips. Use ${fakeKey}.`,
};
const reply = `Here is my setup.\n\n\`\`\`json\n${JSON.stringify({
  format: "grok-bot-export",
  version: 1,
  bots: [bramble, wren],
})}\n\`\`\``;

const run = {
  spaceId: "space-1",
  userId: "user-1",
  threadId: "thread-1",
  sourceMessageId: "message-1",
};
const context = {} as AdapterContext;

function depsWith(message: { threadId: string; role: string; text: string }): ExecutorDeps {
  return {
    prisma: {
      message: {
        findUnique: async () => ({
          id: "message-1",
          threadId: message.threadId,
          role: message.role,
          blocks: [{ kind: "text", text: message.text }],
        }),
      },
    },
  } as unknown as ExecutorDeps;
}

describe("reading the export a run was sent", () => {
  it("reads the owner's message in this thread only", async () => {
    const read = (message: { threadId: string; role: string }) =>
      readRunAgentExport(depsWith({ ...message, text: reply }), run, context);
    await expect(read({ threadId: "thread-1", role: "user" })).resolves.toEqual([reply]);
    await expect(read({ threadId: "thread-2", role: "user" })).resolves.toEqual([]);
    await expect(read({ threadId: "thread-1", role: "bot" })).resolves.toEqual([]);
  });
});

describe("the import_agents approval card", () => {
  it("names each bot and what it brings", () => {
    const prepared = prepareAgentImportRequest(reply, { bot_names: ["bramble", "Wren"] });
    expect(prepared).toMatchObject({
      ok: true,
      canonical: {
        bots: [
          { index: 0, name: "Bramble" },
          { index: 1, name: "Wren" },
        ],
      },
      summary: {
        title: "Import 2 bots?",
        lines: ["Bramble: 1 skill, 2 routines, 1 app", "Wren: 0 skills, 0 routines, 0 apps"],
      },
    });
  });

  it("matches names in any case, once, and refuses a name two bots share", () => {
    const prepared = prepareAgentImportRequest(reply, { bot_names: ["Bramble", "bramble"] });
    expect(prepared).toMatchObject({ ok: true, canonical: { bots: [{ index: 0 }] } });
    const twins = JSON.stringify({ bots: [bramble, { ...bramble, export_id: "other" }] });
    expect(prepareAgentImportRequest(twins, { bot_names: ["Bramble"] })).toMatchObject({
      ok: false,
      error: expect.stringContaining('more than one bot named "Bramble"'),
    });
  });

  it("reads an attached export even when the message text holds an unfinished one", () => {
    const fragment = '{"format": "grok-bot-export", "bots": [{"name": "Draft"';
    expect(prepareAgentImportRequest([fragment, reply], { bot_names: ["Wren"] })).toMatchObject({
      ok: true,
    });
  });

  it("keeps a bot name's markup literal in the card title", () => {
    const name = "[Bramble](https://example.com)";
    const linked = JSON.stringify({ bots: [{ ...bramble, name }] });
    expect(prepareAgentImportRequest(linked, { bot_names: [name] })).toMatchObject({
      ok: true,
      summary: { title: "Import \\[Bramble\\](https://example.com)?" },
    });
  });

  it("refuses names the export does not have, and a message with no export", () => {
    expect(prepareAgentImportRequest(reply, { bot_names: ["Atlas"] })).toEqual({
      ok: false,
      error: 'The export has no bot named "Atlas". Bots in it: "Bramble", "Wren".',
    });
    expect(prepareAgentImportRequest("Import my bots", { bot_names: ["Bramble"] })).toMatchObject({
      ok: false,
      error: expect.stringContaining("No agent export was found"),
    });
    expect(prepareAgentImportRequest(reply, { bot_names: [] })).toMatchObject({ ok: false });
  });
});

describe("importing the approved bots", () => {
  const approved = () => {
    const prepared = prepareAgentImportRequest(reply, { bot_names: ["Bramble", "Wren"] });
    if (!prepared.ok) throw new Error(prepared.error);
    return prepared.canonical;
  };

  it("creates every bot through the import, with what acts on its own and without key-shaped text", async () => {
    const created: Parameters<AgentImportServices["routineRowData"]>[1][] = [];
    const createBot = vi.fn<AgentImportServices["createBot"]>(async (_actor, input) => {
      await input.seed(services.prisma, importedBot.id);
      return { ...importedBot, name: input.name };
    });
    const services = fakeImportServices({
      createBot,
      routineRowData: (_actor, input) => {
        created.push(input);
        return { ...input } as never;
      },
    });
    const result = await importAgentsFromChat(
      depsWith({ threadId: "thread-1", role: "user", text: reply }),
      run,
      context,
      approved(),
      "effect-1",
      services,
    );
    if ("error" in result) throw new Error(result.error);
    expect(createBot.mock.calls.map(([, input]) => [input.name, input.instructions])).toEqual([
      ["Bramble", "Keep replies short."],
      // The key-shaped instructions stay out until the user picks them in Settings.
      ["Wren", ""],
    ]);
    expect(created).toMatchObject([
      { name: "Monday review", active: false, crons: ["0 8 * * 1"] },
      { name: "Triage issues", active: false, webhookEnabled: true },
    ]);
    expect(result.bots[0]).toMatchObject({
      name: "Bramble",
      instructions: true,
      memory: ["MEMORY.md"],
      skills: ["weekly-account-health"],
      routines: [
        { name: "Monday review", needs: ["turn it on"] },
        {
          name: "Triage issues",
          needs: ["turn it on", "point its source at the webhook address the routine shows"],
        },
      ],
      leftOut: [{ item: "apps: Gmail", reason: "connect it again here" }],
    });
    expect(result.bots[1]).toMatchObject({
      name: "Wren",
      instructions: false,
      leftOut: expect.arrayContaining([
        expect.objectContaining({ item: "Instructions" }),
        expect.objectContaining({ item: "Description" }),
      ]),
    });
  });

  it("returns the bots it already made when an approved call runs again", async () => {
    const createBot = vi.fn<AgentImportServices["createBot"]>(async (_actor, input) => {
      await input.seed(services.prisma, importedBot.id);
      return importedBot;
    });
    const services = fakeImportServices({ createBot });
    const deps = depsWith({ threadId: "thread-1", role: "user", text: reply });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await importAgentsFromChat(deps, run, context, approved(), "effect-1", services);
    }
    expect(createBot).toHaveBeenCalledTimes(2);
  });

  it("brings a bot over without its servers when this server refuses their address", async () => {
    const withServer = JSON.stringify({
      bots: [{ ...bramble, apps: [{ name: "Tracker", mcp_url: "https://mcp.example.com/mcp" }] }],
    });
    const prepared = prepareAgentImportRequest(withServer, { bot_names: ["Bramble"] });
    if (!prepared.ok) throw new Error(prepared.error);
    const createBot = vi.fn<AgentImportServices["createBot"]>(async (_actor, input) => {
      await input.seed(services.prisma, importedBot.id);
      return importedBot;
    });
    const services = fakeImportServices({
      createBot,
      prepareMcpServer: async () => {
        throw new ClientError(
          "BAD_REQUEST",
          "Connector URL targets a private host",
          "mcp_address_refused",
        );
      },
    });
    const result = await importAgentsFromChat(
      depsWith({ threadId: "thread-1", role: "user", text: withServer }),
      run,
      context,
      prepared.canonical,
      "effect-1",
      services,
    );
    if ("error" in result) throw new Error(result.error);
    expect(createBot).toHaveBeenCalledTimes(1);
    expect(result.bots[0]).toMatchObject({
      botId: importedBot.id,
      mcpServers: [],
      leftOut: [{ item: "Tracker", reason: "Connector URL targets a private host" }],
    });
  });

  it("refuses an export that changed after approval", async () => {
    const result = await importAgentsFromChat(
      depsWith({ threadId: "thread-1", role: "user", text: `${reply}\n` }),
      run,
      context,
      approved(),
      "effect-1",
      fakeImportServices(),
    );
    expect(result).toEqual({ error: expect.stringContaining("not the one the user approved") });
  });
});
