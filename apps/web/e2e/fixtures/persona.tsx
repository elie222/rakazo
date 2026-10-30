import { I18nProvider } from "@lingui/react";
import { BotRuntimeProfile } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BotPersonaSettings } from "../../src/components/BotPersonaSettings";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import "../../src/styles.css";

const botId = "fixture-persona-bot";
const params = new URLSearchParams(location.search);
const initialSettings = BotRuntimeProfile.parse({
  persona: {
    persona:
      "You are a patient research partner. Explain unfamiliar ideas in plain language, distinguish evidence from uncertainty, and ask one clear question when context is missing.",
  },
});
let settings = initialSettings;
let revision = 3;
let triggerConflict = false;
const failureMode = params.get("state") === "error";

// This local fixture mocks only the 2 persona RPC procedures. Other requests keep normal behavior.
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  const url = new URL(request.url);
  if (
    url.pathname !== "/rpc/bots/runtimeProfileGet" &&
    url.pathname !== "/rpc/bots/runtimeProfileUpdate"
  )
    return realFetch(input, init);

  if (failureMode)
    return Response.json(
      {
        json: {
          defined: false,
          code: "INTERNAL_SERVER_ERROR",
          status: 500,
          message: "Local fixture API error",
        },
      },
      { status: 500 },
    );

  const body = (await request.clone().json()) as { json?: Record<string, unknown> };
  const inputData = body.json ?? {};
  if (url.pathname.endsWith("runtimeProfileGet")) {
    return Response.json({ json: profileResponse() });
  }
  if (triggerConflict) {
    triggerConflict = false;
    // Simulate another editor winning the revision race before this save.
    revision += 1;
    return Response.json(
      {
        json: {
          defined: false,
          code: "CONFLICT",
          status: 409,
          message: "The profile changed in another session.",
        },
      },
      { status: 409 },
    );
  }
  if (inputData.expectedRevision !== revision) {
    return Response.json(
      {
        json: {
          defined: false,
          code: "CONFLICT",
          status: 409,
          message: "The profile changed in another session.",
        },
      },
      { status: 409 },
    );
  }
  settings = BotRuntimeProfile.parse(inputData.settings);
  revision += 1;
  return Response.json({ json: profileResponse() });
};

function profileResponse() {
  return {
    botId,
    revision,
    settings,
    activationStatus: "partial",
    supportedCapabilities: ["persona"],
  };
}

function Fixture() {
  const [conflictNext, setConflictNext] = useState(false);
  function armConflict() {
    triggerConflict = true;
    setConflictNext(true);
  }
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-10">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">Bot settings</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Field Notes</h1>
        </div>
        <span className="rounded-md border border-border bg-muted/50 px-2.5 py-1.5 text-xs font-medium text-foreground">
          Local test data
        </span>
      </div>
      <section
        className="space-y-5 rounded-xl border border-border bg-card p-4 text-card-foreground sm:p-6"
        aria-labelledby="persona-heading"
      >
        <div className="border-b border-border pb-4">
          <h2 id="persona-heading" className="text-base font-semibold">
            Identity
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Set the voice and point of view for this bot.
          </p>
        </div>
        <BotPersonaSettings botId={botId} />
      </section>
      {!failureMode ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button variant="outline" disabled={conflictNext} onClick={armConflict}>
            Simulate save conflict
          </Button>
          {conflictNext ? (
            <span className="text-sm text-muted-foreground">Conflict armed for the next save.</span>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}

void bootstrapI18n("en").then(() => {
  createRoot(document.getElementById("root")!).render(
    <I18nProvider i18n={i18n}>
      <Fixture />
    </I18nProvider>,
  );
});
