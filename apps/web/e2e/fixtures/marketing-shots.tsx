import { I18nProvider } from "@lingui/react";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { Bot, Me, ModelCatalogEntry } from "@rakazo/contracts";
import { defaultCronPreset } from "@rakazo/core";
import { BotAvatar, Button } from "@rakazo/ui-web";
import { ArrowUp, Bell, LayoutGrid, Monitor, PanelLeftClose, Plus, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AskCard } from "../../src/components/AskCard";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import type { RoutineDraftState } from "../../src/pages/RoutineEditor";
import { RoutineEditor } from "../../src/pages/RoutineEditor";
import { SettingsOverlay } from "../../src/pages/SettingsOverlay";
import { BotSettings, CreateBotForm } from "../../src/pages/shell/bot-panel";
import { TimeSeparator } from "../../src/pages/shell/chat-context";
import "../../src/styles.css";

const demoRpc: Record<string, unknown> = {
  "voice/voices": [],
  "models/credentials": [
    {
      id: "cred-demo",
      provider: "openai",
      label: "OpenAI",
      hasKey: true,
      isDefault: true,
      modelId: "gpt-4.1",
    },
  ],
  "models/list": [
    {
      provider: "openai",
      providerName: "OpenAI",
      id: "gpt-4.1",
      label: "GPT-4.1",
      billing: "",
    },
    {
      provider: "openai",
      providerName: "OpenAI",
      id: "gpt-4.1-mini",
      label: "GPT-4.1 mini",
      billing: "",
    },
  ],
  me: null,
  "scratchpad/list": [],
  "memory/list": [],
  "agentSkills/list": [],
};

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.includes("/rpc/")) {
    const path = new URL(url, location.origin).pathname.replace(/^\/rpc\//, "");
    const body = path in demoRpc ? demoRpc[path] : [];
    return new Response(JSON.stringify({ json: body }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return realFetch(input, init);
};

function inboxBot(): Bot {
  return {
    id: "bot-inbox",
    spaceId: "space-demo",
    name: "Inbox",
    title: "Sorts the demo inbox",
    description: "Files routine mail for ada@example.test and leaves the rest for review.",
    instructions: "File routine mail. Ask before sending anything.",
    color: "ink",
    notifyOnFinish: true,
    pinned: false,
    sectionId: null,
    archivedAt: null,
    unread: false,
    parentBotId: null,
    memoryScope: null,
    threadId: "thread-demo",
    preview: "",
    status: "idle",
    computerMode: "team",
    updatedAt: "2026-10-07T00:00:00.000Z",
    createdAt: "2026-10-07T00:00:00.000Z",
    voiceId: null,
    autoSpeak: false,
    modelProvider: "openai",
    modelId: "gpt-4.1",
    thinkingLevel: null,
    teamChatAmbientEnabled: false,
    teamChatRules: "",
    webhookConfigured: false,
    spawnKey: null,
  };
}

function CreateShot() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const name = document.querySelector<HTMLInputElement>('input[placeholder="Name this bot"]');
    const title = document.querySelector<HTMLInputElement>(
      'input[placeholder="Describe what this bot does"]',
    );
    const description = document.querySelector<HTMLTextAreaElement>("textarea");
    fill(name, "Inbox");
    fill(title, "Sorts the demo inbox");
    fill(description, "Files routine mail for ada@example.test and leaves the rest for review.");
    setReady(true);
  }, []);
  return (
    <main
      data-ready={ready ? "true" : "false"}
      className="mx-auto max-w-[640px] bg-background p-8 text-foreground"
    >
      <CreateBotForm onCreate={async () => undefined} onCancel={() => undefined} />
    </main>
  );
}

function fill(element: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  if (!element) return;
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function ModelShot() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const details = document.querySelector("details");
    if (details) details.open = true;
    const timer = window.setTimeout(() => setReady(true), 400);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <main
      data-ready={ready ? "true" : "false"}
      className="mx-auto max-w-[720px] bg-background p-8 text-foreground"
    >
      <BotSettings
        bot={inboxBot()}
        memoryProviderConfigured={false}
        onSkillsChange={() => undefined}
        onSave={async () => undefined}
        onExport={async () => undefined}
        onClear={() => undefined}
      />
    </main>
  );
}

function RoutineShot() {
  const preset = { ...defaultCronPreset(), freq: "Weekdays" as const, time: "8:00 AM" };
  const [draft, setDraft] = useState<RoutineDraftState>({
    name: "Weekday inbox",
    prompt: "Read the demo inbox, file the routine mail, and list anything that needs a person.",
    schedules: [preset],
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    active: true,
    runAtLocal: "",
  });
  return (
    <main data-ready="true" className="mx-auto max-w-[760px] bg-background p-8 text-foreground">
      <RoutineEditor
        draft={draft}
        onChange={setDraft}
        editing={null}
        timezone="UTC"
        webhook={{ path: "/hooks/demo", secret: null, configured: false }}
        githubPath=""
        messageProviders={[]}
        saving={false}
        running={false}
        error={null}
        onBack={() => undefined}
        onClose={() => undefined}
        onSave={() => undefined}
        onTestRun={() => undefined}
        onDelete={() => undefined}
        onEnsureWebhook={async () => undefined}
      />
    </main>
  );
}

function ApprovalShot() {
  return (
    <main data-ready="true" className="mx-auto max-w-[760px] bg-background p-8 text-foreground">
      <AskCard
        canAnswer
        onAnswer={async () => undefined}
        block={{
          kind: "ask",
          approvalEffectId: "effect-demo",
          text: "Review before sending a reply from the demo inbox.",
          detail: "To: ada@example.test\nSubject: Re: Invoice 1042\n\nThanks, I will take a look.",
          status: "pending",
          actions: [
            { id: "allow", label: "Allow once" },
            { id: "always", label: "Always allow this tool" },
            { id: "deny", label: "Deny" },
          ],
        }}
      />
    </main>
  );
}

const subscriptionMe: Me = {
  ticketBoardEnabled: false,
  phoneCallsEnabled: false,
  userId: "user-demo",
  email: "ada@example.test",
  name: "Ada",
  spaceId: "space-demo",
  isDeploymentOwner: true,
  needsModel: false,
  defaultProvider: "anthropic",
  defaultModel: "claude-sonnet-5-5",
  hostCredentialProvider: null,
  hostCredentialSource: null,
  computerHost: "docker",
  canChooseHostComputer: true,
  sandboxProvider: "docker",
  avatarStyle: "robot",
  billingEnabled: false,
};

const subscriptionCatalog: ModelCatalogEntry[] = [
  {
    provider: "anthropic",
    providerName: "Anthropic",
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    billing: "",
    auth: "both",
    oauthLabel: "Sign in with Claude Pro/Max",
    authHint: "Claude Pro/Max / key",
    subscription: true,
    signIn: "auth-url",
    reasoning: true,
    thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    provider: "openai-codex",
    providerName: "OpenAI Codex",
    id: "gpt-6.1-sol",
    label: "GPT-6.1 Sol",
    billing:
      "Sign in with ChatGPT Plus or Pro. Uses your OpenAI subscription. Rakazo does not pay.",
    auth: "oauth",
    oauthLabel: "Sign in with ChatGPT Plus/Pro",
    authHint: "ChatGPT Plus/Pro",
    subscription: true,
    signIn: "device-code",
    reasoning: true,
    thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    provider: "xai",
    providerName: "xAI",
    id: "grok-4.6",
    label: "grok-4.6",
    billing: "Sign in with SuperGrok or X Premium, or paste an xAI API key. Rakazo does not pay.",
    auth: "both",
    oauthLabel: "Sign in with SuperGrok or X Premium",
    authHint: "SuperGrok / key",
    subscription: true,
    signIn: "device-code",
    reasoning: true,
    thinkingLevels: ["low", "medium", "high", "xhigh"],
  },
];

function RosterRow({
  name,
  color,
  identity,
  title,
  preview,
  time,
  selected,
}: {
  name: string;
  color: string;
  identity: string;
  title: string;
  preview: string;
  time: string;
  selected?: boolean;
}) {
  return (
    <div className="group/row relative">
      <button
        type="button"
        aria-current={selected ? "page" : undefined}
        className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-[10px] text-start ${
          selected ? "bg-sidebar-accent" : ""
        }`}
      >
        <BotAvatar color={color} identity={identity} size={38} status="idle" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-1.5">
            <span className="min-w-0 truncate text-[14px] font-medium text-foreground">{name}</span>
            <span className="text-[11.5px] text-muted-foreground/60 tabular-nums">{time}</span>
          </div>
          <div className="mt-1 flex">
            <span className="max-w-full truncate rounded-md border border-border bg-muted px-2 py-0.5 text-[11px] font-normal text-muted-foreground">
              {title}
            </span>
          </div>
          <div className="mt-1 line-clamp-2 text-[12.5px] break-words whitespace-normal text-muted-foreground/60">
            {preview}
          </div>
        </div>
      </button>
    </div>
  );
}

function ChatShot() {
  return (
    <main data-ready="true" className="flex h-full min-h-0 bg-background text-foreground">
      <aside className="flex w-[316px] shrink-0 flex-col border-e border-sidebar-border bg-sidebar">
        <div className="flex items-center justify-end gap-2.5 px-[18px] pb-3 pt-4">
          <button
            type="button"
            aria-label="Activity"
            className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground/70"
          >
            <Bell size={15} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Minimize bots"
            className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground/70"
          >
            <PanelLeftClose size={15} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Create"
            className="text-[21px] leading-none text-muted-foreground/70"
          >
            +
          </button>
        </div>
        <div className="mx-2.5 mb-3 flex items-center gap-2 rounded-xl border border-border bg-card px-3 text-muted-foreground">
          <Search size={16} strokeWidth={1.8} aria-hidden="true" />
          <input
            aria-label="Search"
            placeholder="Search"
            readOnly
            className="h-10 w-full bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="flex flex-1 flex-col gap-0.5 overflow-hidden px-2.5 pb-2.5">
          <RosterRow
            name="Inbox"
            color="violet"
            identity="bot-inbox"
            title="Sorts the demo inbox"
            preview="Two notes need you"
            time="9:14 AM"
            selected
          />
          <RosterRow
            name="Chief"
            color="green"
            identity="bot-chief"
            title="Monday briefing"
            preview="Briefing is set for Monday"
            time="Yesterday"
          />
          <RosterRow
            name="Sales"
            color="orange"
            identity="bot-sales"
            title="Overnight research"
            preview="18 drafts queued"
            time="3:10 AM"
          />
        </div>
        <button type="button" className="mx-3 mb-1 flex items-center gap-3 rounded-xl px-2.5 py-2">
          <span className="grid h-[30px] w-[30px] place-items-center rounded-lg bg-accent text-foreground/80">
            <LayoutGrid size={15} strokeWidth={1.8} />
          </span>
          <span className="text-[14px] font-medium text-foreground/90">Integrations</span>
        </button>
        <div className="flex items-center gap-[11px] px-[18px] py-3.5">
          <span className="grid h-8 w-8 place-items-center rounded-full bg-accent text-[12px] text-foreground/75">
            A
          </span>
          <span className="text-[14.5px] text-foreground/90">Ada</span>
        </div>
      </aside>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-sidebar-border px-3 py-[17px] md:px-[22px]">
          <div className="flex min-w-0 items-center gap-3">
            <BotAvatar color="violet" identity="bot-inbox" size={26} status="idle" />
            <span className="truncate text-[16px] font-medium text-foreground">Inbox</span>
          </div>
          <span className="grid h-[30px] w-[34px] place-items-center rounded-[9px]">
            <Monitor
              size={18}
              strokeWidth={1.6}
              className="text-foreground/75"
              aria-hidden="true"
            />
          </span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden px-4 py-5 md:px-7 md:py-6">
          <TimeSeparator createdAt="2026-10-07T09:14:00.000Z" locale="en" />
          <div className="relative flex justify-end">
            <div className="relative w-fit min-w-0 max-w-[min(84%,calc(100%_-_8rem))]">
              <div className="max-w-full whitespace-pre-wrap wrap-anywhere rounded-[20px] bg-chat-user px-[18px] py-3 text-[15.5px] leading-[1.45] text-chat-user-foreground">
                File the routine mail in the demo inbox. Don't send anything.
              </div>
            </div>
          </div>
          <div className="relative flex justify-start">
            <div className="relative w-fit min-w-0 max-w-[min(88%,calc(100%_-_8rem))]">
              <div className="mb-1.5 flex items-center gap-2 text-[13px] font-semibold tracking-tight text-foreground">
                <BotAvatar color="violet" identity="bot-inbox" size={22} status="idle" />
                Inbox
              </div>
              <div className="max-w-full space-y-2.5 rounded-[20px] bg-muted px-[18px] py-3 text-[15.5px] leading-[1.5] text-foreground/90">
                <ChatMarkdown>
                  Filed the routine mail. Two notes still need you. Nothing was sent.
                </ChatMarkdown>
              </div>
            </div>
          </div>
        </div>
        <div className="px-4 pb-4 md:px-7">
          <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3.5 rounded-[26px] border border-border bg-background py-[9px] pe-2.5 ps-3">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Attach file"
              className="col-start-1 size-8 shrink-0 rounded-full border border-border bg-muted text-muted-foreground"
            >
              <Plus size={16} strokeWidth={2} />
            </Button>
            <div className="col-start-2 text-[15.5px] leading-6 text-muted-foreground">
              Message Inbox
            </div>
            <Button
              size="icon"
              aria-label="Send"
              className="col-start-3 size-8 rounded-full bg-white text-black shadow-sm"
            >
              <ArrowUp size={16} strokeWidth={2.2} />
            </Button>
          </div>
        </div>
      </section>
    </main>
  );
}

function SubscriptionShot() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const text = document.body.textContent ?? "";
      if (
        text.includes("Sign in with Claude Pro/Max") &&
        text.includes("Backup models") &&
        text.includes("Claude Sonnet 5.5")
      ) {
        setReady(true);
        window.clearInterval(timer);
      }
    }, 50);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <main
      data-ready={ready ? "true" : "false"}
      className="min-h-screen bg-background text-foreground"
    >
      <SettingsOverlay
        email="ada@example.test"
        name="Ada"
        initialSection="models"
        avatarStyle="robot"
        onAvatarStyleChange={async () => undefined}
        memoryConfig={null}
        onMemoryConfigChange={() => undefined}
        onUsageOpen={() => undefined}
        onClose={() => undefined}
      />
    </main>
  );
}

const view = new URLSearchParams(location.search).get("view") ?? "create";

if (view === "subscription") {
  demoRpc.me = subscriptionMe;
  demoRpc["models/list"] = subscriptionCatalog;
  demoRpc["models/credentials"] = [];
  demoRpc["models/backups"] = [];
}

void bootstrapI18n("en").then(() => {
  const shot =
    view === "model" ? (
      <ModelShot />
    ) : view === "routine" ? (
      <RoutineShot />
    ) : view === "approval" ? (
      <ApprovalShot />
    ) : view === "chat" ? (
      <ChatShot />
    ) : view === "subscription" ? (
      <SubscriptionShot />
    ) : (
      <CreateShot />
    );
  createRoot(document.getElementById("root")!).render(
    <I18nProvider i18n={i18n}>{shot}</I18nProvider>,
  );
});
