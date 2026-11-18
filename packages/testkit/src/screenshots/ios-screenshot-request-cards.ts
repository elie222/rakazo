import type { MessageBlock } from "@rakazo/contracts";
import type { createDb } from "@rakazo/db";
import { createThreadMessage } from "@rakazo/db";

const CARDS_READY = "Set up the weekly support digest.";

/** The cards a bot shows when it needs something (a key, a sign-in, a site, an app, a choice), and a draft. */
export async function ensureRequestCards(
  prisma: ReturnType<typeof createDb>["prisma"],
  input: { threadId: string; botId: string },
) {
  const messages = await prisma.message.findMany({
    where: { threadId: input.threadId },
    select: { blocks: true },
  });
  if (messages.some((message) => JSON.stringify(message.blocks).includes(CARDS_READY))) return;
  const bot = (blocks: MessageBlock[]) =>
    createThreadMessage(prisma, {
      threadId: input.threadId,
      role: "bot",
      botId: input.botId,
      blocks,
    });
  await createThreadMessage(prisma, {
    threadId: input.threadId,
    role: "user",
    blocks: [{ kind: "text", text: CARDS_READY }],
  });
  await bot([
    { kind: "text", text: "I'll read new tickets from the help desk and draft replies." },
    {
      kind: "app_connect",
      provider: "gmail",
      name: "Gmail",
      description: "Search, read, and draft emails",
      logo: null,
      status: "pending",
    },
  ]);
  await bot([
    {
      kind: "ask",
      text: "Sign in to the help desk so I can see the ticket queue.",
      input: "secret",
      purpose: "password",
      credential: {
        name: "help-desk",
        origin: "https://help.example.com",
        auth: { type: "login" },
      },
      status: "answered",
    },
  ]);
  await bot([
    {
      kind: "ask",
      text: "Can I open status.example.com to check for outages?",
      site: "status.example.com",
      status: "answered",
      answer: "Allow",
    },
  ]);
  await bot([
    {
      kind: "choice",
      question: "Which tone should replies use?",
      options: [
        { id: "warm", letter: "A", label: "Warm and casual" },
        { id: "brief", letter: "B", label: "Brief and direct" },
        { id: "formal", letter: "C", label: "Formal" },
      ],
    },
  ]);
  await bot([
    { kind: "computer", state: "Needs you", text: "Approve the sign-in code on your phone." },
  ]);
  await bot([
    {
      kind: "ask",
      approvalEffectId: "ios-screenshot-pay",
      text: "Pay on freshcart.test?",
      detailFormat: "text",
      receipt: {
        button: "Place order",
        items: [
          { name: "Bananas × 6", amount: "$3.00" },
          { name: "Oat milk 1L × 2", amount: "$8.40" },
          { name: "Delivery", amount: "$6.00" },
        ],
        amount: "$17.40",
        amountSource: "page",
      },
      status: "answered",
      answer: "allow",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    },
  ]);
  await bot([
    { kind: "text", text: "Here's the note for the team." },
    {
      kind: "draft",
      draftId: "ios-screenshot-draft",
      label: "Email",
      to: "Support team",
      subject: "Weekly support digest",
      body: "Hi all,\n\nStarting Monday, I'll send a digest of new tickets every week: what came in, what's still open, and anything waiting on us for more than two days.\n\nReply here if you'd like something added.\n\nThanks,\nSam",
      version: 1,
    },
  ]);
}
