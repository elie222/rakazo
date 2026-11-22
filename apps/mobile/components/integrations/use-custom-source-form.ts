import { useLingui } from "@lingui/react/macro";
import type { CapabilityInstall, McpSourcePreset } from "@rakazo/contracts";
import { customMcpServerInput } from "@rakazo/core";
import type { QueryKey } from "@tanstack/react-query";
import { useState } from "react";
import { errorText } from "../../lib/api/user-error";
import { useSave } from "../../lib/query/query";
import type { AddCustomOption, SourceAuth, SourceKind } from "./add-custom-integration";

/**
 * The Integrations screen's Add custom flow: what it offers, the GitHub or source form's fields,
 * and adding or removing a custom source.
 */
export function useCustomSourceForm({
  sourcePresets,
  stale,
  authorizeMcp,
  setOauthServerId,
  onStart,
}: {
  sourcePresets: McpSourcePreset[];
  /** What a source added or removed makes out of date. */
  stale: readonly QueryKey[];
  authorizeMcp: (serverId: string) => void;
  setOauthServerId: (serverId: string) => void;
  /** Called as the form opens. */
  onStart: () => void;
}) {
  const { t } = useLingui();
  const [gitUrl, setGitUrl] = useState("");
  const [sourceKind, setSourceKind] = useState<SourceKind | null>(null);
  const [sourcePreset, setSourcePreset] = useState<McpSourcePreset | null>(null);
  const [adding, setAdding] = useState<"github" | "source" | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [credential, setCredential] = useState("");
  const [sourceAuth, setSourceAuth] = useState<SourceAuth>("none");
  const [authHeader, setAuthHeader] = useState("x-api-key");

  const add = useSave({
    save: async (kind: SourceKind, send) => {
      const displayName =
        name.trim() ||
        (sourcePreset?.name ?? (kind === "graphql" ? "GraphQL" : t`Custom connector`));
      const auth =
        sourceAuth === "header"
          ? { type: "header", name: authHeader.trim() }
          : { type: sourceAuth === "bearer" ? "bearer" : "none" };
      if (sourceAuth === "oauth") {
        const created = await send("mcp/servers/create", customMcpServerInput(displayName, url));
        return created.id;
      }
      await send("capabilities/install", {
        kind,
        name: displayName,
        source: url.trim(),
        credential: (sourceAuth !== "none" && credential.trim()) || undefined,
        config: sourcePreset
          ? { preset: sourcePreset.id }
          : kind === "api"
            ? { openApi: true, auth }
            : kind === "graphql"
              ? { auth }
              : { preset: "custom", auth },
      });
      return null;
    },
    stale,
    onSaved: (serverId) => {
      setCredential("");
      setSourceKind(null);
      setAdding(null);
      if (!serverId) return;
      setOauthServerId(serverId);
      authorizeMcp(serverId);
    },
  });
  const remove = useSave({
    save: (source: CapabilityInstall, send) => send("capabilities/remove", { id: source.id }),
    stale,
  });
  const sourceError = add.error
    ? errorText(add.error, t`Could not add source`)
    : remove.error
      ? errorText(remove.error, t`Could not remove source`)
      : null;
  function clearSourceError() {
    add.reset();
    remove.reset();
  }

  const addOptions: AddCustomOption[] = [
    { id: "github", label: t`From GitHub`, kind: "github" },
    { id: "mcp", label: t`MCP server`, kind: "mcp" },
    { id: "api", label: "OpenAPI", kind: "api" },
    { id: "graphql", label: "GraphQL", kind: "graphql" },
    ...sourcePresets.map((preset) => ({
      id: `preset:${preset.id}`,
      label: preset.name,
      kind: "mcp" as const,
      preset,
    })),
  ];

  function closeAdding() {
    setAdding(null);
    setSourceKind(null);
    clearSourceError();
    setName("");
    setUrl("");
    setCredential("");
  }

  function beginSource(kind: SourceKind, preset: McpSourcePreset | null = null) {
    setAdding("source");
    setSourceKind(kind);
    setSourcePreset(preset);
    clearSourceError();
    setName(preset?.name ?? "");
    setUrl(preset?.url ?? preset?.defaultUrl ?? "");
    setCredential("");
    setSourceAuth(preset?.signIn ? "oauth" : preset ? "bearer" : "none");
    setAuthHeader("x-api-key");
  }

  function startAdding(option: AddCustomOption | undefined) {
    if (!option) return;
    onStart();
    clearSourceError();
    if (option.kind === "github") {
      setSourceKind(null);
      setAdding("github");
    } else beginSource(option.kind, option.preset);
  }

  return {
    addOptions,
    adding,
    startAdding,
    removeSource: (source: CapabilityInstall) => remove.run(source),
    /** What a pending add or remove is working on: "source", or the source being removed. */
    pending: add.pending ? "source" : remove.pending ? (remove.input?.id ?? null) : null,
    /** The open form's fields and handlers, as AddCustomForm takes them. */
    formProps: {
      gitUrl,
      setGitUrl,
      sourceError,
      sourceKind,
      sourcePreset,
      name,
      setName,
      url,
      setUrl,
      sourceAuth,
      setSourceAuth,
      authHeader,
      setAuthHeader,
      credential,
      setCredential,
      onAdd: () => {
        if (sourceKind) add.run(sourceKind);
      },
      onClose: closeAdding,
    },
  };
}
