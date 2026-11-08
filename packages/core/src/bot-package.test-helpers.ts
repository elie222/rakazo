import type {
  BotPackageDocument,
  BotPackageExport,
  BotPackagePreview,
  BotPackageReceipt,
  BotPackageRecentReceipt,
} from "@rakazo/contracts";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export const packageDocument: BotPackageDocument = {
  format: "coginebot.package/v1",
  profile: {
    name: "Research",
    title: "",
    description: "Review sources",
    instructions: "A line.\r\nNext line.",
  },
  skills: [],
  routines: [],
  connections: [],
  memory: [],
};

export function packagePreview(input: Partial<BotPackagePreview> = {}): BotPackagePreview {
  return {
    previewToken: "review-token",
    digest: "a".repeat(64),
    expiresAt: "2099-01-01T00:00:00.000Z",
    sourceFormat: "coginebot.package/v1",
    includeMemory: false,
    availableMemoryCount: 0,
    document: packageDocument,
    leftOut: [],
    ...input,
  };
}

export function packageReceipt(input: Partial<BotPackageReceipt> = {}): BotPackageReceipt {
  return {
    importId: "import-1",
    clientNonce: "nonce-1",
    digest: "a".repeat(64),
    status: "completed",
    revision: 1,
    botId: "bot-1",
    botName: "Research",
    createdAt: "2026-11-02T00:00:00.000Z",
    skills: [],
    connections: [],
    leftOut: [],
    ...input,
  };
}

export function recentReceipt(
  input: Partial<BotPackageRecentReceipt> = {},
): BotPackageRecentReceipt {
  return {
    importId: "import-1",
    clientNonce: "nonce-1",
    status: "completed",
    revision: 1,
    botId: "bot-1",
    botName: "Research",
    createdAt: "2026-11-02T00:00:00.000Z",
    skillCount: 0,
    connectionCount: 0,
    ...input,
  };
}

export function packageExport(input: Partial<BotPackageExport> = {}): BotPackageExport {
  const document = input.document ?? packageDocument;
  return {
    document,
    json: JSON.stringify(document),
    filename: "bot-package.json",
    leftOut: [],
    ...input,
  };
}
