import { Trans, useLingui } from "@lingui/react/macro";
import type { AgentSkillCatalogEntry } from "@rakazo/contracts";
import { BOT_PACKAGE_MAX_SKILLS } from "@rakazo/contracts";
import {
  createBotPackageExport,
  createBotPackageSkills,
  initialBotPackageExport,
  initialBotPackageSkills,
} from "@rakazo/core";
import { Button, Input, Switch } from "@rakazo/ui-web";
import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { downloadBotPackage } from "../lib/bot-package-file";
import { createSpaceRpc } from "../lib/rpc";
import { BotPackageDocumentView, BotPackageLeftOutList } from "./BotPackageDocumentView";
import { BotPackageSkillsView } from "./BotPackageSkillsView";

type Props = { botId: string; spaceId: string; isCurrent(): boolean };

export function BotPackageSkills({ botId, spaceId, isCurrent }: Props) {
  const [state, setState] = useState(initialBotPackageSkills);
  const manager = useRef<ReturnType<typeof createBotPackageSkills> | null>(null);
  useLayoutEffect(() => {
    let active = true;
    const valid = () => active && isCurrent();
    const client = createSpaceRpc(spaceId, valid);
    setState(initialBotPackageSkills);
    const skills = createBotPackageSkills({
      botId,
      forBot: (input, signal) => client.botPackages.forBot(input, { signal }),
      activateSkill: (input, signal) => client.botPackages.activateSkill(input, { signal }),
      isCurrent: valid,
      changed: setState,
    });
    manager.current = skills;
    void skills.refresh();
    return () => {
      active = false;
      skills.dispose();
      manager.current = null;
    };
  }, [botId, spaceId, isCurrent]);
  if (!state.receipt)
    return state.error ? (
      <Button variant="outline" onClick={() => void manager.current?.refresh()}>
        <Trans>Check imported skills</Trans>
      </Button>
    ) : null;
  return (
    <BotPackageSkillsView
      receipt={state.receipt}
      busy={state.phase === "loading" || state.phase === "saving"}
      unknown={state.phase === "unknown"}
      error={Boolean(state.error)}
      onRefresh={() => void manager.current?.refresh()}
      onActivate={(id, name) => void manager.current?.activate(id, name)}
    />
  );
}

function PackageExport({ botId, spaceId, isCurrent }: Props) {
  const { t } = useLingui();
  const ids = useId();
  const [state, setState] = useState(initialBotPackageExport);
  const [skills, setSkills] = useState<AgentSkillCatalogEntry[]>([]);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [includeMemory, setIncludeMemory] = useState(false);
  const [query, setQuery] = useState("");
  const [visible, setVisible] = useState(50);
  const requested = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reload, setReload] = useState(0);
  const manager = useRef<ReturnType<typeof createBotPackageExport> | null>(null);
  useLayoutEffect(() => {
    let active = true;
    const valid = () => active && isCurrent();
    const client = createSpaceRpc(spaceId, valid);
    setState(initialBotPackageExport);
    setSelection(new Set());
    setIncludeMemory(false);
    setQuery("");
    setVisible(50);
    requested.current = null;
    const exporter = createBotPackageExport({
      export: (input, signal) => client.botPackages.export(input, { signal }),
      deliver: async (result, signal) =>
        downloadBotPackage(result, () => valid() && !signal.aborted),
      isCurrent: valid,
      changed: setState,
    });
    manager.current = exporter;
    return () => {
      active = false;
      exporter.dispose();
      manager.current = null;
    };
  }, [botId, spaceId, isCurrent]);
  useLayoutEffect(() => {
    let active = true;
    const valid = () => active && isCurrent();
    const client = createSpaceRpc(spaceId, valid);
    setSkills([]);
    setLoading(true);
    setLoadError(false);
    void client.agentSkills
      .list()
      .then((list) => {
        if (valid()) {
          setSkills(list.filter((skill) => skill.source !== "builtin"));
          setLoading(false);
        }
      })
      .catch(() => {
        if (valid()) {
          setLoadError(true);
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [spaceId, isCurrent, reload]);
  const busy = state.phase === "exporting" || state.phase === "delivering";
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return skills.filter(
      (skill) => !needle || `${skill.name}\n${skill.description}`.toLowerCase().includes(needle),
    );
  }, [skills, query]);
  const selectionKey = JSON.stringify([includeMemory, [...selection].sort()]);
  function invalidate() {
    requested.current = null;
    manager.current?.invalidate();
  }
  return (
    <section className="mt-3 space-y-3 rounded-lg border p-3" data-testid="bot-package-export">
      <label
        htmlFor={`${ids}-memory`}
        className="flex items-center justify-between gap-3 text-body"
      >
        <Trans>Include memory</Trans>
        <Switch
          id={`${ids}-memory`}
          checked={includeMemory}
          disabled={busy}
          onCheckedChange={(checked) => {
            invalidate();
            setIncludeMemory(checked);
          }}
        />
      </label>
      <h3 className="text-body font-medium">
        <Trans>Shared skills (optional)</Trans>
      </h3>
      <Input
        aria-label={t`Search shared skills`}
        value={query}
        maxLength={200}
        disabled={busy}
        onChange={(event) => {
          setQuery(event.target.value);
          setVisible(50);
        }}
      />
      <p className="text-label text-muted-foreground">
        <Trans>Selected skills: {selection.size}</Trans>
      </p>
      {selection.size ? (
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => {
            invalidate();
            setSelection(new Set());
          }}
        >
          <Trans>Clear selection</Trans>
        </Button>
      ) : null}
      {loading ? (
        <p className="text-body">
          <Trans>Loading…</Trans>
        </p>
      ) : null}
      {loadError ? (
        <div role="alert">
          <p className="text-body">
            <Trans>Could not load skills.</Trans>
          </p>
          <Button variant="outline" onClick={() => setReload((value) => value + 1)}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : null}
      {filtered.slice(0, visible).map((skill) => (
        <label
          htmlFor={`${ids}-${skill.id}`}
          key={skill.id}
          className="flex items-center justify-between gap-3 text-body"
        >
          <span dir="auto">{skill.name}</span>
          <Switch
            id={`${ids}-${skill.id}`}
            checked={selection.has(skill.id)}
            disabled={
              busy || (!selection.has(skill.id) && selection.size >= BOT_PACKAGE_MAX_SKILLS)
            }
            onCheckedChange={(checked) => {
              invalidate();
              setSelection((prior) => {
                const next = new Set(prior);
                if (checked) next.add(skill.id);
                else next.delete(skill.id);
                return next;
              });
            }}
          />
        </label>
      ))}
      {filtered.length > visible ? (
        <Button variant="ghost" disabled={busy} onClick={() => setVisible((value) => value + 50)}>
          <Trans>Show more</Trans>
        </Button>
      ) : null}
      <Button
        disabled={busy || loading || loadError}
        onClick={() => {
          requested.current = selectionKey;
          void manager.current?.run({ botId, skillIds: [...selection], includeMemory });
        }}
      >
        {state.phase === "exporting" ? <Trans>Exporting…</Trans> : <Trans>Preview package</Trans>}
      </Button>
      {state.error ? (
        <p role="alert" className="text-body text-destructive">
          <Trans>Could not export this package.</Trans>
        </p>
      ) : null}
      {state.result && requested.current === selectionKey ? (
        <>
          <BotPackageDocumentView document={state.result.document} />
          <BotPackageLeftOutList items={state.result.leftOut} />
          {state.phase === "review" ? (
            <Button onClick={() => void manager.current?.confirm()}>
              <Trans>Download package</Trans>
            </Button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export function BotPackageTools(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <section className="mt-5" data-testid="bot-package-tools">
      <Button variant="outline" onClick={() => setOpen(!open)}>
        <Trans>Export package</Trans>
      </Button>
      {open ? <PackageExport {...props} /> : null}
      <BotPackageSkills {...props} />
    </section>
  );
}
