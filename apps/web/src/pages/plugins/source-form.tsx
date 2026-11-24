import { Trans, useLingui } from "@lingui/react/macro";
import type { IntegrationCatalogSurface, McpSourcePreset } from "@rakazo/contracts";
import { Button, Field, FieldDescription, FieldLabel, Input, OptionSelect } from "@rakazo/ui-web";
import { useState } from "react";
import { ViewTitle } from "./parts";

export type SourceKind = "mcp" | "api" | "graphql";

/** How a custom source authenticates. OAuth is a remote MCP server's browser sign-in. */
export type SourceAuth = "none" | "bearer" | "header" | "oauth";

export type SourceForm = ReturnType<typeof useSourceForm>;

/** The fields of a custom MCP, OpenAPI, or GraphQL connector; each start fills them afresh. */
export function useSourceForm() {
  const [sourceKind, setSourceKind] = useState<SourceKind | null>(null);
  const [sourcePreset, setSourcePreset] = useState<McpSourcePreset | null>(null);
  const [sourceName, setSourceName] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [credential, setCredential] = useState("");
  const [authType, setAuthType] = useState<SourceAuth>("bearer");
  const [authName, setAuthName] = useState("x-api-key");
  const [sourceHint, setSourceHint] = useState<string | null>(null);
  const [unreviewed, setUnreviewed] = useState(false);

  function start(kind: SourceKind, preset: McpSourcePreset | null) {
    setSourceKind(kind);
    setSourcePreset(preset);
    setSourceHint(null);
    setUnreviewed(false);
    setSourceName(preset?.name ?? "");
    setSourceUrl(preset?.url ?? preset?.defaultUrl ?? "");
    setCredential("");
    setAuthType(preset?.signIn ? "oauth" : preset ? "bearer" : "none");
    setAuthName("x-api-key");
  }

  /** A domain search result prefills the form with what it found. */
  function startFromCatalog(
    kind: "mcp" | "openapi",
    name: string,
    source: string,
    auth: IntegrationCatalogSurface["auth"],
  ) {
    setSourceKind(kind === "mcp" ? "mcp" : "api");
    setSourcePreset(null);
    setSourceName(name);
    setSourceUrl(source);
    setCredential("");
    setAuthType(auth?.type ?? "none");
    setAuthName(auth?.headerName ?? "x-api-key");
    setSourceHint(auth?.note ?? null);
    setUnreviewed(true);
  }

  function close() {
    setSourceKind(null);
    setSourceHint(null);
  }

  return {
    sourceKind,
    setSourceKind,
    sourcePreset,
    sourceName,
    setSourceName,
    sourceUrl,
    setSourceUrl,
    credential,
    setCredential,
    authType,
    setAuthType,
    authName,
    setAuthName,
    sourceHint,
    unreviewed,
    start,
    startFromCatalog,
    close,
  };
}

export function SourceFormView({
  form,
  installing,
  sourceError,
  onBack,
  onSubmit,
}: {
  form: SourceForm;
  installing: boolean;
  sourceError: string | null;
  onBack: () => void;
  onSubmit: () => void;
}) {
  const { t } = useLingui();
  const {
    sourceKind,
    sourcePreset,
    sourceName,
    setSourceName,
    sourceUrl,
    setSourceUrl,
    credential,
    setCredential,
    authType,
    setAuthType,
    authName,
    setAuthName,
    sourceHint,
    unreviewed,
  } = form;
  if (!sourceKind) return null;
  const custom = !sourcePreset;
  // OAuth saves the server before the browser sign-in, so it is not a check of typed credentials.
  const oauth = authType === "oauth";
  const submitLabel = installing ? (
    oauth ? (
      <Trans>Connecting…</Trans>
    ) : (
      <Trans>Verifying…</Trans>
    )
  ) : oauth ? (
    <Trans>Save and sign in</Trans>
  ) : (
    <Trans>Verify and add</Trans>
  );
  return (
    <div data-testid="integrations-source-form" className="max-w-xl space-y-6">
      <ViewTitle
        title={
          sourcePreset ? (
            sourcePreset.name
          ) : sourceKind === "mcp" ? (
            <Trans>MCP server</Trans>
          ) : sourceKind === "graphql" ? (
            "GraphQL"
          ) : (
            "OpenAPI"
          )
        }
        onBack={onBack}
      />
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        {!sourcePreset?.featured ? (
          <Field>
            <FieldLabel htmlFor="source-name">
              <Trans>Name</Trans>
            </FieldLabel>
            <Input
              id="source-name"
              value={sourceName}
              onChange={(event) => setSourceName(event.target.value)}
              autoFocus
            />
          </Field>
        ) : null}
        {!sourcePreset?.url ? (
          <Field>
            <FieldLabel htmlFor="source-url">URL</FieldLabel>
            <Input
              id="source-url"
              value={sourceUrl}
              onChange={(event) => setSourceUrl(event.target.value)}
              placeholder={
                sourcePreset?.urlPlaceholder ??
                (sourceKind === "mcp"
                  ? "https://example.com/mcp"
                  : sourceKind === "graphql"
                    ? "https://example.com/graphql"
                    : "https://example.com/openapi.json")
              }
            />
            {unreviewed ? (
              <FieldDescription>
                <Trans>Not reviewed by Rakazo. Only add it if you trust this address.</Trans>
              </FieldDescription>
            ) : null}
          </Field>
        ) : null}
        {custom ? (
          <Field>
            <FieldLabel htmlFor="source-auth">
              <Trans>Authentication</Trans>
            </FieldLabel>
            <OptionSelect<SourceAuth>
              id="source-auth"
              value={authType}
              options={[
                { value: "none", label: t`No authentication` },
                { value: "bearer", label: t`Bearer token` },
                { value: "header", label: t`API key header` },
                ...(sourceKind === "mcp" ? [{ value: "oauth" as const, label: t`OAuth` }] : []),
              ]}
              onValueChange={setAuthType}
            />
          </Field>
        ) : null}
        {custom && authType === "header" ? (
          <Field>
            <FieldLabel htmlFor="source-header">
              <Trans>Header name</Trans>
            </FieldLabel>
            <Input
              id="source-header"
              value={authName}
              onChange={(event) => setAuthName(event.target.value)}
            />
          </Field>
        ) : null}
        {(!custom || authType !== "none") && authType !== "oauth" ? (
          <Field>
            <FieldLabel htmlFor="source-credential">
              {sourcePreset?.credentialHelpUrl ? (
                <Trans>Personal access token</Trans>
              ) : sourcePreset ? (
                <Trans>Bearer token</Trans>
              ) : (
                <Trans>Credential</Trans>
              )}
            </FieldLabel>
            <Input
              id="source-credential"
              type="password"
              autoComplete="new-password"
              autoFocus={sourcePreset?.featured}
              value={credential}
              onChange={(event) => setCredential(event.target.value)}
            />
            <FieldDescription>
              {sourcePreset?.credentialHelpUrl ? (
                <a
                  href={sourcePreset.credentialHelpUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  <Trans>Create a personal access token</Trans>
                </a>
              ) : (
                <Trans>Credentials are encrypted and never sent to the model.</Trans>
              )}
            </FieldDescription>
          </Field>
        ) : null}
        {sourceHint ? <p className="text-body text-muted-foreground">{sourceHint}</p> : null}
        {sourceError ? (
          <p role="alert" className="text-body text-destructive">
            {sourceError}
          </p>
        ) : null}
        <Button type="submit" disabled={installing}>
          {submitLabel}
        </Button>
      </form>
    </div>
  );
}
