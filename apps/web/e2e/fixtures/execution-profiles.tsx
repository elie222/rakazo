import { I18nProvider } from "@lingui/react";
import type { ExecutionProfile } from "@rakazo/contracts";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { RunExecutionProfileDetails } from "../../src/components/RunExecutionProfileDetails";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import { ExecutionProfileSettings } from "../../src/pages/shell/execution-profile-settings";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const fixtureProfile: ExecutionProfile = {
  id: "fixture-profile",
  seriesId: "fixture-series",
  revision: 1,
  spaceId: "fixture-space",
  name: "Review",
  harness: "claude",
  runtimeVersion: "0.3.300",
  provider: "anthropic",
  credentialId: "project-account",
  protocol: "anthropic",
  endpoint: "https://api.example.test",
  modelId: "test-model",
  authScheme: "api-key",
  modelRoles: {},
  inputModalities: ["image"],
  computerId: null,
  createdAt: "2026-10-01T00:00:00.000Z",
};
// A manual visual-QA mode, with the same fake metadata as the Playwright route fixtures.
if (params.has("offline")) {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/rpc/nativeLogins/list")
      return Response.json({ json: { enabled: false, accounts: [], computers: [] } });
    if (path === "/rpc/executionProfiles/list") return Response.json({ json: [fixtureProfile] });
    if (path === "/rpc/models/credentials")
      return Response.json({
        json: [
          {
            id: "team-account",
            provider: "anthropic",
            label: "Team account",
            hasKey: true,
            isDefault: true,
            authKind: "api_key",
          },
          ...(!params.has("revoked")
            ? [
                {
                  id: "project-account",
                  provider: "anthropic",
                  label: "Project account",
                  hasKey: true,
                  isDefault: false,
                  authKind: "api_key",
                },
              ]
            : []),
        ],
      });
    if (path === "/rpc/executionProfiles/create") {
      const body = await request.json();
      return Response.json({
        json: { ...fixtureProfile, ...body.json, id: "fixture-created-profile" },
      });
    }
    if (path.startsWith("/rpc/")) return Response.json({ json: [] });
    return originalFetch(request);
  };
}

function Fixture() {
  const [value, setValue] = useState<string | null>(
    params.has("selected") ? fixtureProfile.id : null,
  );
  return (
    <main className="mx-auto min-h-screen max-w-lg bg-background p-6 text-foreground">
      <h1 className="text-lg font-medium">Bot settings</h1>
      {params.has("run-details") ? (
        <div className="mt-4 flex items-center justify-between">
          <span>Completed run</span>
          <RunExecutionProfileDetails
            profile={{
              id: "past-profile",
              name: "Earlier review",
              revision: 2,
              harness: "codex",
              provider: "openai",
              modelId: "review-model",
              accountLabel: "Original account",
            }}
          />
        </div>
      ) : null}
      <details className="mt-5">
        <summary className="cursor-pointer text-muted-foreground">Advanced</summary>
        <ExecutionProfileSettings value={value} onChange={setValue} />
      </details>
    </main>
  );
}
await bootstrapI18n("en");
createRoot(document.getElementById("root")!).render(
  <I18nProvider i18n={i18n}>
    <Fixture />
  </I18nProvider>,
);
