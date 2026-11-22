import { useLingui } from "@lingui/react/macro";
import type { CapabilityInstall, McpServer, McpSourcePreset } from "@rakazo/contracts";
import { customMcpServerInput } from "@rakazo/core";
import type { Dispatch, SetStateAction } from "react";
import { useState } from "react";
import { rpc } from "../../lib/api/api";
import { errorText } from "../../lib/api/user-error";
import type { AddCustomOption, SourceAuth, SourceKind } from "./add-custom-integration";

/**
 * The Integrations screen's Add custom flow: what it offers, the GitHub or source form's fields,
 * and adding or removing a custom source.
 */
export function useCustomSourceForm({
  sourcePresets,
  captureConnectionScope,
  retryRefresh,
  authorizeMcp,
  setPending,
  setSources,
  setOauthServerId,
  onStart,
}: {
  sourcePresets: McpSourcePreset[];
  captureConnectionScope: () => () => boolean;
  retryRefresh: (isCurrent?: () => boolean) => Promise<void>;
  authorizeMcp: (serverId: string) => Promise<void>;
  setPending: (pending: string | null) => void;
  setSources: Dispatch<SetStateAction<CapabilityInstall[]>>;
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
  const [sourceError, setSourceError] = useState<string | null>(null);

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
    setSourceError(null);
    setName("");
    setUrl("");
    setCredential("");
  }

  function beginSource(kind: SourceKind, preset: McpSourcePreset | null = null) {
    setAdding("source");
    setSourceKind(kind);
    setSourcePreset(preset);
    setSourceError(null);
    setName(preset?.name ?? "");
    setUrl(preset?.url ?? preset?.defaultUrl ?? "");
    setCredential("");
    setSourceAuth(preset?.signIn ? "oauth" : preset ? "bearer" : "none");
    setAuthHeader("x-api-key");
  }

  function startAdding(option: AddCustomOption | undefined) {
    if (!option) return;
    onStart();
    setSourceError(null);
    if (option.kind === "github") {
      setSourceKind(null);
      setAdding("github");
    } else beginSource(option.kind, option.preset);
  }

  async function addSource() {
    if (!sourceKind) return;
    const isCurrent = captureConnectionScope();
    if (!isCurrent()) return;
    setPending("source");
    setSourceError(null);
    const displayName =
      name.trim() ||
      (sourcePreset?.name ?? (sourceKind === "graphql" ? "GraphQL" : t`Custom connector`));
    const auth =
      sourceAuth === "header"
        ? { type: "header", name: authHeader.trim() }
        : { type: sourceAuth === "bearer" ? "bearer" : "none" };
    let created: McpServer | null = null;
    try {
      if (sourceAuth === "oauth") {
        created = await rpc("mcp/servers/create", customMcpServerInput(displayName, url));
        if (!isCurrent()) return;
        setOauthServerId(created.id);
      } else {
        await rpc("capabilities/install", {
          kind: sourceKind,
          name: displayName,
          source: url.trim(),
          credential: (sourceAuth !== "none" && credential.trim()) || undefined,
          config: sourcePreset
            ? { preset: sourcePreset.id }
            : sourceKind === "api"
              ? { openApi: true, auth }
              : sourceKind === "graphql"
                ? { auth }
                : { preset: "custom", auth },
        });
        if (!isCurrent()) return;
      }
      setCredential("");
      setSourceKind(null);
      setAdding(null);
      await retryRefresh(isCurrent);
      if (created) await authorizeMcp(created.id);
    } catch (reason) {
      if (isCurrent()) setSourceError(errorText(reason, t`Could not add source`));
    } finally {
      if (isCurrent()) setPending(null);
    }
  }

  async function removeSource(source: CapabilityInstall) {
    setPending(source.id);
    setSourceError(null);
    try {
      await rpc("capabilities/remove", { id: source.id });
      setSources((current) => current.filter((item) => item.id !== source.id));
    } catch (reason) {
      setSourceError(errorText(reason, t`Could not remove source`));
    } finally {
      setPending(null);
    }
  }

  return {
    addOptions,
    adding,
    startAdding,
    removeSource,
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
      onAdd: () => void addSource(),
      onClose: closeAdding,
    },
  };
}
