import { I18nProvider } from "@lingui/react";
import type { Bot } from "@rakazo/contracts";
import { defaultCronPreset } from "@rakazo/core";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AskCard } from "../../src/components/AskCard";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import type { RoutineDraftState } from "../../src/pages/RoutineEditor";
import { RoutineEditor } from "../../src/pages/RoutineEditor";
import { BotSettings, CreateBotForm } from "../../src/pages/shell/bot-panel";
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

const view = new URLSearchParams(location.search).get("view") ?? "create";

void bootstrapI18n("en").then(() => {
  const shot =
    view === "model" ? (
      <ModelShot />
    ) : view === "routine" ? (
      <RoutineShot />
    ) : view === "approval" ? (
      <ApprovalShot />
    ) : (
      <CreateShot />
    );
  createRoot(document.getElementById("root")!).render(
    <I18nProvider i18n={i18n}>{shot}</I18nProvider>,
  );
});
