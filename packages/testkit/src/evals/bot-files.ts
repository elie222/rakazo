import { crc32 } from "node:zlib";
import type { EvalCase } from "./cases.js";
import type { ToolChoiceExpect } from "./tool-choice.js";
import { gradeToolChoice } from "./tool-choice.js";

export const BOT_FILES_FIXTURE_VERSION = "bot-files-v4";

/**
 * A line of the site's code. A message that names the code can summarize it; one carrying this
 * exact line pasted the code instead of sending the files.
 */
const CODE_LINE = "return cards.filter((card) => card.ready).map(renderCard);";

/** A small working site, so a careful bot has nothing to fix before sending it. */
const SITE = [
  {
    path: "site/index.html",
    content:
      '<!doctype html>\n<link rel="stylesheet" href="style.css">\n<ul id="cards"></ul>\n<script type="module" src="app.js"></script>\n',
  },
  {
    path: "site/app.js",
    content: [
      "const cards = [",
      '  { title: "Launch", ready: true },',
      '  { title: "Pricing", ready: false },',
      "];",
      'const renderCard = (card) => "<li>" + card.title + "</li>";',
      "function renderLaunchCards() {",
      `  ${CODE_LINE}`,
      "}",
      'document.getElementById("cards").innerHTML = renderLaunchCards().join("");',
      "",
    ].join("\n"),
  },
  { path: "site/style.css", content: "body { margin: 0; font-family: sans-serif; }\n" },
];
/** A real archive of the site, so a bot that inspects it before sending finds the same files. */
const SITE_ZIP = { path: "site.zip", content: storedZip(SITE) };

const CODER =
  "You are Coder. You write and edit code for the user's projects on your computer. You have no access to the production server; Servo does.";
const SERVO = {
  name: "Servo",
  description:
    "Server admin: the only bot with access to the production server. Uploads and deploys sites.",
  // Servo's own turn is not graded; keep it to one cheap acknowledgement.
  instructions:
    "When another bot sends you work, reply in one short sentence confirming what you received. Do not deploy anything.",
};

type Scenario = {
  id: string;
  purpose: string;
  /** Servo is a direct-chat teammate, a group member, or the subject receiving the files. */
  setup: { kind: "teammate"; ownComputer?: true } | { kind: "group" } | { kind: "receiver" };
  files: NonNullable<EvalCase["computerFiles"]>;
  ask: string;
  expect: ToolChoiceExpect;
};

const SCENARIOS: Scenario[] = [
  {
    id: "send-folder-on-shared-computer",
    purpose:
      "A bot passes a project folder to a teammate on its computer by path, not by pasting it.",
    setup: { kind: "teammate" },
    files: SITE,
    ask: "The site in your site folder is ready. Send it to Servo so Servo can deploy it.",
    expect: {
      calls: [{ tool: "message_bot", args: { files: "~site" } }],
      callsMustNot: [{ tool: "message_bot", args: { message: `~${CODE_LINE}` } }],
    },
  },
  {
    id: "send-zip-to-own-computer",
    purpose:
      "A bot whose teammate has its own computer ends up sending the zipped project, after being told a folder cannot be copied.",
    setup: { kind: "teammate", ownComputer: true },
    files: [...SITE, SITE_ZIP],
    ask: "The site is ready. Send it to Servo so Servo can deploy it. There's a zipped copy too if you need one.",
    expect: {
      calls: [{ tool: "message_bot", args: { files: "~site.zip" } }],
      callsMustNot: [{ tool: "message_bot", args: { message: `~${CODE_LINE}` } }],
    },
  },
  {
    id: "hand-off-folder-in-group",
    purpose:
      "In a group, a bot hands the next stage to the member who deploys, with the files attached.",
    setup: { kind: "group" },
    files: SITE,
    ask: "The site in your site folder is done. Hand it over to Servo to deploy.",
    expect: {
      calls: [{ tool: "handoff_to_bot", args: { files: "~site" } }],
      callsMustNot: [{ tool: "handoff_to_bot", args: { message: `~${CODE_LINE}` } }],
    },
  },
  {
    id: "question-sends-no-files",
    purpose: "A question for a teammate goes without files, even with a project on the computer.",
    setup: { kind: "teammate" },
    files: SITE,
    ask: "Ask Servo whether the production server is up right now.",
    expect: {
      calls: [{ tool: "message_bot" }],
      callsMustNot: [{ tool: "message_bot", args: { files: "~site" } }],
    },
  },
  {
    id: "receive-shared-path",
    purpose: "A bot handed a path on the shared computer opens the files there.",
    setup: { kind: "receiver" },
    files: SITE.map((file) => ({ ...file, owner: "peer" as const })),
    ask: "Please deploy the site.\n\nFiles on our shared computer:\n- {peerHome}/site",
    expect: {
      anyOf: [
        { tool: "list_files", args: { path: "~site" } },
        { tool: "read_file", args: { path: "~site" } },
      ],
    },
  },
];

export const BOT_FILES_EVAL_CASES: EvalCase[] = SCENARIOS.map((scenario) => {
  const { setup } = scenario;
  const shared = {
    id: scenario.id,
    purpose: scenario.purpose,
    connections: [],
    pauseEndsTurn: true as const,
    computerFiles: scenario.files,
    grade: (evidence: Parameters<EvalCase["grade"]>[0]) =>
      gradeToolChoice(scenario.expect, evidence),
  };
  if (setup.kind === "group")
    return {
      ...shared,
      group: {
        members: [SERVO.name],
        roles: {
          Assistant: "Coder: writes and edits code for the user's projects.",
          Servo: SERVO.description,
        },
        instructions: { Assistant: CODER, Servo: SERVO.instructions },
      },
      steps: [{ ask: scenario.ask }],
    };
  if (setup.kind === "receiver")
    return {
      ...shared,
      botSetup: {
        instructions:
          "You are Servo, the only bot with access to the production server. You upload and deploy the sites other bots build.",
      },
      peer: {
        name: "Coder",
        description: "Writes and edits code for the user's projects.",
        instructions: "Reply to any message in one short sentence.",
      },
      steps: [{ fromPeer: scenario.ask }],
    };
  return {
    ...shared,
    botSetup: { instructions: CODER },
    peer: { ...SERVO, ...(setup.ownComputer ? { ownComputer: true as const } : {}) },
    steps: [{ ask: scenario.ask }],
  };
});

/** An uncompressed zip: the eval computer has no shell to build one, and nothing here needs compression. */
function storedZip(files: Array<{ path: string; content: string }>): Uint8Array {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path);
    const data = Buffer.from(file.content);
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, directory, end]));
}
