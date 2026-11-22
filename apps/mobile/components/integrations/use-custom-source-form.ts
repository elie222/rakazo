import { useLingui } from "@lingui/react/macro";
import type { CapabilityInstall, McpSourcePreset } from "@rakazo/contracts";
import type { CatalogMcpServer } from "@rakazo/core";
import { customMcpServerInput } from "@rakazo/core";
import type { QueryKey } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { errorText } from "../../lib/api/user-error";
import { captureSessionScope } from "../../lib/api/verified-scope";
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
  captureFocus,
  onStart,
}: {
  sourcePresets: McpSourcePreset[];
  /** What a source added or removed makes out of date. */
  stale: readonly QueryKey[];
  authorizeMcp: (serverId: string) => void;
  setOauthServerId: (serverId: string) => void;
  /** Whether the screen keeps the focus it has now: a sign-in starts only on a screen in view. */
  captureFocus: () => () => boolean;
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
  // Bumped whenever the form opens or closes, so an add only closes the form it was sent from.
  const formOpened = useRef(0);

  const add = useSave({
    save: async (kind: SourceKind, send) => {
      const sameForm = captureSessionScope();
      const opened = formOpened.current;
      const focused = captureFocus();
      /** Closes the form as soon as the source is added, while the lists read again behind it. */
      const closeAfterAdding = () => {
        if (!sameForm() || formOpened.current !== opened) return;
        setCredential("");
        setSourceKind(null);
        setAdding(null);
      };
      const displayName =
        name.trim() ||
        (sourcePreset?.name ?? (kind === "graphql" ? "GraphQL" : t`Custom connector`));
      const auth =
        sourceAuth === "header"
          ? { type: "header", name: authHeader.trim() }
          : { type: sourceAuth === "bearer" ? "bearer" : "none" };
      if (sourceAuth === "oauth") {
        const created = await send("mcp/servers/create", customMcpServerInput(displayName, url));
        closeAfterAdding();
        return { serverId: created.id, focused };
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
      closeAfterAdding();
      return null;
    },
    stale,
    onSaved: (created) => {
      if (!created) return;
      setOauthServerId(created.serverId);
      // Never opens the browser over a screen the person has left.
      if (created.focused()) authorizeMcp(created.serverId);
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
    formOpened.current += 1;
    setAdding(null);
    setSourceKind(null);
    clearSourceError();
    setName("");
    setUrl("");
    setCredential("");
  }

  function beginSource(kind: SourceKind, preset: McpSourcePreset | null = null) {
    formOpened.current += 1;
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
      formOpened.current += 1;
      setSourceKind(null);
      setAdding("github");
    } else beginSource(option.kind, option.preset);
  }

  return {
    addOptions,
    adding,
    startAdding,
    startCatalogMcp({ name, source, auth }: CatalogMcpServer) {
      onStart();
      beginSource("mcp");
      setName(name);
      setUrl(source);
      setSourceAuth(auth?.type ?? "none");
      setAuthHeader(auth?.headerName ?? "x-api-key");
    },
    removeSource(source: CapabilityInstall) {
      clearSourceError();
      remove.run(source);
    },
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
        if (!sourceKind) return;
        clearSourceError();
        add.run(sourceKind);
      },
      onClose: closeAdding,
    },
  };
}
