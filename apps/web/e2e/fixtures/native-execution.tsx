import { I18nProvider } from "@lingui/react";
import type { BotExecutionConfiguration, MessageBlock } from "@rakazo/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AskCard } from "../../src/components/messages/AskCard";
import { bootstrapI18n, i18n } from "../../src/lib/locale/i18n";
import { queryClient } from "../../src/lib/query/query";
import { ExecutionModelSection } from "../../src/pages/shell/bots/execution-model-section";
import "../../src/styles.css";

const parameters = new URLSearchParams(location.search);
const originalFetch = window.fetch.bind(window);
let configuration: BotExecutionConfiguration | null = null;
let listings = 0;
let active = ["running", "stop-failed"].includes(parameters.get("state") ?? "");
window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
  if (url.pathname.startsWith("/rpc/")) {
    if (url.pathname === "/rpc/executions/list") listings++;
    if (url.pathname === "/rpc/executions/configure") {
      const request = (
        input instanceof Request ? await input.clone().json() : JSON.parse(String(init?.body))
      ).json;
      if (active && !request.stopActiveRuns)
        return Response.json(
          {
            json: {
              defined: false,
              code: "CONFLICT",
              status: 409,
              message: "Stop this bot before changing its execution",
            },
          },
          { status: 409 },
        );
      if (parameters.get("state") === "stop-failed")
        return Response.json(
          {
            json: {
              defined: false,
              code: "INTERNAL_SERVER_ERROR",
              status: 500,
              message: "Could not stop execution",
            },
          },
          { status: 500 },
        );
      active = false;
      configuration = request.configuration;
      return Response.json({ json: { ok: true } });
    }
    const values: Record<string, unknown> = {
      "/rpc/me": {
        isAdmin: parameters.get("state") !== "unprepared",
        userId: "fixture-user",
        spaceId: "fixture-space",
      },
      "/rpc/executions/get": configuration,
      "/rpc/executions/list": [
        {
          id: "connection",
          computerId: "computer",
          label: "Workspace",
          online: true,
          profiles: [
            {
              id: "account",
              revision: 1,
              label: "Personal account",
              engineVersion: "test",
              defaultModel: "provider/model-a",
              models: [
                { id: "provider/model-a", label: "Model A" },
                { id: "provider/model-b", label: "Model B" },
              ],
              status:
                parameters.get("state") === "unprepared" && listings === 1
                  ? "unauthenticated"
                  : "ready",
            },
            {
              id: "pending",
              revision: 1,
              label: "Additional account",
              engineVersion: "test",
              status: "unauthenticated",
            },
          ],
        },
      ],
    };
    if (url.pathname in values) return Response.json({ json: values[url.pathname] });
  }
  return originalFetch(input, init);
};

function Approval() {
  const initial = parameters.get("state");
  const [delivery, setDelivery] = useState<"pending" | "submitted" | "delivered" | "expired">(
    initial === "submitted" || initial === "delivered" || initial === "expired"
      ? initial
      : "pending",
  );
  const block: Extract<MessageBlock, { kind: "ask" }> = {
    kind: "ask",
    text: "Attach file?",
    detail: "report.txt",
    input: "text",
    actions: [
      { id: "allow", label: "Allow once" },
      { id: "deny", label: "Deny" },
    ],
    nativeRequestId: "fixture-request",
    nativeKind: "permission",
    nativeDelivery: delivery,
    status: delivery === "delivered" || delivery === "expired" ? "answered" : "pending",
    ...(delivery !== "pending" ? { answer: "allow" } : {}),
  };
  return (
    <AskCard
      block={block}
      canAnswer={delivery === "pending"}
      canDismiss={false}
      onAnswer={async () => setDelivery("submitted")}
      onDismiss={async () => undefined}
    />
  );
}

function Settings() {
  const ids = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState("");
  return (
    <ExecutionModelSection
      botId="fixture-bot"
      ids={ids}
      containerRef={containerRef}
      choices={[{ key: "", label: "Space default" }]}
      value={value}
      onModelChange={setValue}
      thinkingOptions={[]}
      thinkingLevel=""
      defaultThinkingLevel="medium"
      onThinkingLevelChange={() => {}}
    />
  );
}

void bootstrapI18n("en").then(() =>
  createRoot(document.getElementById("root")!).render(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <main className="mx-auto max-w-xl space-y-5 p-6">
          {parameters.get("screen") === "settings" ? <Settings /> : <Approval />}
        </main>
      </QueryClientProvider>
    </I18nProvider>,
  ),
);
