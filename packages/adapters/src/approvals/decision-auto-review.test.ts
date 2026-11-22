import type { AdapterContext, AutoReviewRequest, DecisionRequest } from "@rakazo/adapter-kit";
import { afterEach, expect, it, vi } from "vitest";
import {
  INSTRUCTIONS_WRITE_ASK,
  INSTRUCTIONS_WRITE_PASS,
  MEMORY_WRITE_ASK,
  MEMORY_WRITE_PASS,
  OWN_COMPUTER_ASK,
  OWN_COMPUTER_PASS,
  outsideTargetAsk,
  ROUTINE_WRITE_ASK,
  ROUTINE_WRITE_PASS,
} from "./auto-review.prompt.js";
import { DecisionAutoReviewProvider } from "./decision-auto-review.js";
import { decisionModel } from "./decision-models.js";
import type { DecisionCalibration } from "./model-descriptor.js";

const calibration: DecisionCalibration = { confidenceScale: "linear", minPassProbability: 0.75 };

const context: AdapterContext = {
  operationId: "auto-review",
  traceId: "auto-review",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

const request: AutoReviewRequest = {
  toolName: "gmail_send_email",
  connectorKind: "gmail",
  args: { to: "a@b.test" },
  userTask: "Draft a reply",
  botDescription: "Mail bot",
  matchingRules: [],
};

it("asks the checker one question, with criteria for the kind of action", async () => {
  const asked: DecisionRequest["questions"][] = [];
  const provider = new DecisionAutoReviewProvider({
    provider: {
      decide: async ({ questions }) => {
        asked.push(questions);
        return {
          model: "checker",
          answers: { decision: { type: "choice", choice: "pass", confidence: 1 } },
        };
      },
    },
    providerId: "decisions",
    model: "checker",
    calibration,
  });
  await provider.review(request, context);
  await provider.review({ ...request, newSite: true }, context);
  await provider.review({ ...request, savedContextWrite: true }, context);
  await provider.review({ ...request, ownComputerAction: true }, context);
  await provider.review(
    { ...request, toolName: "schedule_create", args: { prompt: "p" } },
    context,
  );
  await provider.review(
    { ...request, toolName: "update_bot", args: { instructions: "i", previousInstructions: "" } },
    context,
  );

  const question = (criteria: { pass: string; ask: string }) => ({
    decision: {
      type: "choice",
      instructions: "Should this bot action run without asking its owner first?",
      criteria,
    },
  });
  expect(asked).toEqual([
    question({
      pass: "It plausibly serves what the owner asked for or the bot's job, including steps they did not spell out. A read, search or list that serves the request and only looks at data, changing, sending or deleting nothing, is such a step even when the request goes on to change things",
      ask: "It clearly goes beyond that and would be hard to undo: messaging people the owner did not mention, spending money, deleting, or publishing, when nobody asked for it",
    }),
    {
      decision: {
        type: "choice",
        instructions:
          "The bot wants to read the web page at `args.url`. Reading a page changes nothing, so the only risk is the URL itself handing private data to that site. Can the bot fetch it without asking the owner? `userTask` and `ownerEarlierMessages` are the owner's own words; you do not see the pages or messages the bot read.",
        criteria: {
          pass: "The URL holds only a site address and page path, search terms, names, places, products, symbols or public ids, or a value the owner wrote and asked to have looked up. A site the owner did not name is fine, and so are unfamiliar site names, page ids and slugs",
          ask: "The URL (host, path, query or fragment) holds private data: personal, financial, payroll, customer or login details, such as a person's email, phone, home address or birth date, an account, card, order or ID number, a password, key or token, text from a private message or document, or long encoded text. This holds even when the owner wrote that data, unless they asked for that exact value to be looked up. Or the owner's words rule this site out",
        },
      },
    },
    {
      decision: {
        type: "choice",
        instructions: expect.stringMatching(/memory or a skill.*`userTask` holds only the owner's/),
        criteria: { pass: MEMORY_WRITE_PASS, ask: MEMORY_WRITE_ASK },
      },
    },
    {
      decision: {
        type: "choice",
        // It names the decision state's own fields; the wording itself is the prompt's to change.
        instructions: expect.stringMatching(/userTask.*args\.page.*args\.addressesInPartLeftOut/),
        criteria: { pass: OWN_COMPUTER_PASS, ask: OWN_COMPUTER_ASK },
      },
    },
    {
      decision: {
        type: "choice",
        instructions: expect.stringMatching(/^The bot wants to create or change a routine,/),
        criteria: { pass: ROUTINE_WRITE_PASS, ask: ROUTINE_WRITE_ASK },
      },
    },
    {
      decision: {
        type: "choice",
        instructions: expect.stringMatching(/`args\.instructions` \(`args\.previousInstructions`/),
        criteria: { pass: INSTRUCTIONS_WRITE_PASS, ask: INSTRUCTIONS_WRITE_ASK },
      },
    },
  ]);
});

it("gives the checker the owner's earlier messages, and says what they are", async () => {
  const sent: DecisionRequest[] = [];
  const provider = new DecisionAutoReviewProvider({
    provider: {
      decide: async (decision) => {
        sent.push(decision);
        return {
          model: "checker",
          answers: { decision: { type: "choice", choice: "pass", confidence: 1 } },
        };
      },
    },
    providerId: "decisions",
    model: "checker",
    calibration,
  });
  await provider.review({ ...request, ownerMessages: ["Draft it to Ana"] }, context);
  await provider.review(request, context);
  expect(sent[0]!.state).toMatchObject({ ownerEarlierMessages: ["Draft it to Ana"] });
  expect(sent[0]!.questions.decision!.instructions).toMatch(
    /ownerEarlierMessages are the owner's own earlier messages\b.*userTask is the latest/,
  );
  expect(sent[1]!.state).not.toHaveProperty("ownerEarlierMessages");
  expect(sent[1]!.questions.decision!.instructions).toBe(
    "Should this bot action run without asking its owner first?",
  );
});

it("gives the checker targets only outside content named, with the ask they add", async () => {
  const sent: DecisionRequest[] = [];
  const provider = new DecisionAutoReviewProvider({
    provider: {
      decide: async (decision) => {
        sent.push(decision);
        return {
          model: "checker",
          answers: { decision: { type: "choice", choice: "pass", confidence: 1 } },
        };
      },
    },
    providerId: "decisions",
    model: "checker",
    calibration,
  });
  await provider.review({ ...request, outsideOnlyTargets: ["audit@ledger.test"] }, context);
  await provider.review(request, context);
  expect(sent[0]!.state).toMatchObject({ outsideOnlyTargets: ["audit@ledger.test"] });
  expect(sent[0]!.questions.decision!.instructions).toMatch(/outsideOnlyTargets are recipients/);
  expect(sent[0]!.questions.decision!.criteria!.ask).toContain(
    outsideTargetAsk("outsideOnlyTargets"),
  );
  expect(sent[1]!.state).not.toHaveProperty("outsideOnlyTargets");
  expect(sent[1]!.questions.decision!.criteria!.ask).not.toContain("outsideOnlyTargets");
});

afterEach(() => vi.unstubAllEnvs());

function answering(confidence: number, model: { provider: string; id: string }) {
  const descriptor = decisionModel(model.provider, model.id)!;
  return new DecisionAutoReviewProvider({
    provider: {
      decide: async () => ({
        model: model.id,
        answers: { decision: { type: "choice", choice: "pass", confidence } },
      }),
    },
    providerId: model.provider,
    model: model.id,
    calibration: descriptor.calibration,
  });
}

it.each([
  ["openrouter", "typesafe/jev-1.14"],
  ["typesafe", "jev-1.14"],
])(
  "keeps %s/%s passing from confidence 0.5 (p 0.75), as before calibration",
  async (provider, id) => {
    vi.stubEnv("RAKAZO_AUTO_REVIEW_MIN_CONFIDENCE", "");
    const decide = async (confidence: number) =>
      (await answering(confidence, { provider, id }).review(request, context)).decision;
    expect(await decide(0.5)).toBe("pass");
    expect(await decide(0.9)).toBe("pass");
    expect(await decide(0.4999999)).toBe("ask");
    expect(await decide(0)).toBe("ask");
  },
);

it("passes each model at its own pass probability, read through its confidence scale", async () => {
  vi.stubEnv("RAKAZO_AUTO_REVIEW_MIN_CONFIDENCE", "");
  const model = { provider: "openrouter", id: "microsoft/microsoft-decision-1.1" };
  const { minPassProbability } = decisionModel(model.provider, model.id)!.calibration;
  const decide = async (p: number) =>
    (await answering(2 * p - 1, model).review(request, context)).decision;
  expect(await decide(minPassProbability)).toBe("pass");
  expect((await answering(0.32, model).review(request, context)).decision).toBe("pass");
  expect(await decide(minPassProbability - 0.001)).toBe("ask");
});

it("lets the operator's confidence floor replace every model's calibration", async () => {
  vi.stubEnv("RAKAZO_AUTO_REVIEW_MIN_CONFIDENCE", "0.8");
  const model = { provider: "openrouter", id: "microsoft/microsoft-decision-1.1" };
  expect((await answering(0.79, model).review(request, context)).decision).toBe("ask");
  expect((await answering(0.8, model).review(request, context)).decision).toBe("pass");
});

it("marks an action on the bot's own computer and keeps all of the owner's words", async () => {
  const sent: DecisionRequest[] = [];
  const provider = new DecisionAutoReviewProvider({
    provider: {
      decide: async (decision) => {
        sent.push(decision);
        return {
          model: "checker",
          answers: { decision: { type: "choice", choice: "pass", confidence: 1 } },
        };
      },
    },
    providerId: "decisions",
    model: "checker",
    calibration,
  });
  const userTask = `${"Fix the build. ".repeat(60)}Upload the log to files.example.com.`;
  await provider.review({ ...request, userTask, ownComputerAction: true }, context);
  expect(sent[0]!.state).toMatchObject({ ownComputerAction: true, userTask });
});
