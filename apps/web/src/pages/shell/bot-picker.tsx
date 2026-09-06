import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, ComputerMode, ModelCatalogEntry, ModelCredential } from "@rakazo/contracts";
import {
  BotAvatar,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@rakazo/ui-web";
import { ArrowLeft, LoaderCircle, Lock, Plus, RotateCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { rpc } from "../../lib/rpc";
import { connectedModelOptions } from "./model-options";

export type BotCreateSelection = {
  computerMode: ComputerMode;
  modelProvider?: string;
  modelId?: string;
};

export function BotCreatePicker({
  bots,
  onCreateBot,
  onOpenBot,
  onCreateGroup,
  onCreateSpace,
}: {
  bots: Bot[];
  onCreateBot: (selection: BotCreateSelection) => void;
  onOpenBot: (botId: string) => void;
  onCreateGroup: () => void;
  onCreateSpace: () => void;
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const [step, setStep] = useState<"pick" | "computer" | "model">("pick");
  const [computerMode, setComputerMode] = useState<ComputerMode>("team");
  const [credentials, setCredentials] = useState<ModelCredential[]>([]);
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [modelMetadataStatus, setModelMetadataStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const loadModelMetadata = useCallback(() => {
    setModelMetadataStatus("loading");
    void Promise.all([rpc.models.credentials(), rpc.models.list()])
      .then(([nextCredentials, nextCatalog]) => {
        setCredentials(nextCredentials);
        setCatalog(nextCatalog);
        setModelMetadataStatus("ready");
      })
      .catch(() => setModelMetadataStatus("error"));
  }, []);
  useEffect(() => {
    loadModelMetadata();
  }, [loadModelMetadata]);
  const modelOptions = connectedModelOptions(credentials, catalog);
  const needle = query.trim().toLowerCase();
  const matched = useMemo(() => {
    if (!needle) return bots;
    return bots.filter(
      (bot) => bot.name.toLowerCase().includes(needle) || bot.title.toLowerCase().includes(needle),
    );
  }, [bots, needle]);
  const showCreate =
    !needle ||
    "create new bot".includes(needle) ||
    needle.split(/\s+/).every((part) => "create new bot".includes(part));

  if (step === "model") {
    return (
      <div data-testid="bot-create-picker" className="w-[min(320px,calc(100vw-2rem))]">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <button
            type="button"
            data-testid="create-bot-model-back"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t`Back`}
            onClick={() => setStep("computer")}
          >
            <ArrowLeft size={16} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <span className="text-[13px] text-muted-foreground">
            <Trans>Model</Trans>
          </span>
        </div>
        <Command className="rounded-none border-0 bg-transparent p-0">
          <CommandList data-testid="create-bot-model" className="max-h-72 p-1">
            <CommandGroup>
              <CommandItem
                value="space-default"
                data-testid="create-bot-model-default"
                onSelect={() => onCreateBot({ computerMode })}
              >
                <Trans>Space default</Trans>
              </CommandItem>
              {modelMetadataStatus === "loading" ? (
                <div className="flex justify-center py-2 text-muted-foreground">
                  <LoaderCircle size={16} className="animate-spin" aria-label={t`Loading…`} />
                </div>
              ) : modelMetadataStatus === "error" ? (
                <CommandItem value="retry-models" onSelect={loadModelMetadata} className="gap-2">
                  <RotateCw size={15} strokeWidth={1.8} aria-hidden="true" />
                  <Trans>Retry now</Trans>
                </CommandItem>
              ) : (
                modelOptions.map((option) => (
                  <CommandItem
                    key={option.key}
                    value={option.key}
                    data-testid={`create-bot-model-${option.key}`}
                    onSelect={() =>
                      onCreateBot({
                        computerMode,
                        modelProvider: option.provider,
                        modelId: option.modelId,
                      })
                    }
                  >
                    {option.label}
                  </CommandItem>
                ))
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </div>
    );
  }

  if (step === "computer") {
    return (
      <div data-testid="bot-create-picker" className="w-[min(320px,calc(100vw-2rem))]">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <button
            type="button"
            data-testid="create-bot-computer-back"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t`Back`}
            onClick={() => setStep("pick")}
          >
            <ArrowLeft size={16} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <span className="text-[13px] text-muted-foreground">
            <Trans>Computer</Trans>
          </span>
        </div>
        <div data-testid="create-bot-computer" className="grid grid-cols-2 gap-2 p-3">
          <button
            type="button"
            data-testid="create-bot-team"
            className="rounded-lg border border-border px-3 py-2 text-[14px] text-foreground hover:border-foreground/40"
            onClick={() => {
              setComputerMode("team");
              setStep("model");
            }}
          >
            <Trans>Team</Trans>
          </button>
          <button
            type="button"
            data-testid="create-bot-private"
            className="rounded-lg border border-border px-3 py-2 text-[14px] text-foreground hover:border-foreground/40"
            onClick={() => {
              setComputerMode("dedicated");
              setStep("model");
            }}
          >
            <Trans>Private</Trans>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="bot-create-picker" className="w-[min(320px,calc(100vw-2rem))]">
      <label className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="shrink-0 text-[13px] text-muted-foreground">
          <Trans>To:</Trans>
        </span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t`Search or create Bots`}
          aria-label={t`Search or create Bots`}
          className="min-w-0 flex-1 bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted-foreground"
        />
      </label>
      <Command shouldFilter={false} className="rounded-none border-0 bg-transparent p-0">
        <CommandList className="max-h-72 p-1">
          <CommandEmpty>
            <Trans>No bots match</Trans>
          </CommandEmpty>
          <CommandGroup>
            {showCreate ? (
              <CommandItem
                value="create-new-bot"
                data-testid="create-new-bot"
                onSelect={() => setStep("computer")}
                className="gap-2"
              >
                <Plus size={16} strokeWidth={1.8} aria-hidden="true" />
                <Trans>Create new Bot</Trans>
              </CommandItem>
            ) : null}
            {matched.map((bot) => (
              <CommandItem
                key={bot.id}
                value={bot.id}
                data-testid={`picker-bot-${bot.id}`}
                onSelect={() => onOpenBot(bot.id)}
                className="gap-2"
              >
                <BotAvatar color={bot.color} identity={bot.id} size={22} status={bot.status} />
                <span className="min-w-0 flex-1 truncate">{bot.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup>
            <CommandItem
              value="create-group"
              data-testid="create-new-group"
              onSelect={() => onCreateGroup()}
            >
              <Trans>New group</Trans>
            </CommandItem>
            <CommandItem
              value="create-space"
              data-testid="create-new-space"
              onSelect={() => onCreateSpace()}
              className="gap-2"
            >
              <Lock size={14} strokeWidth={1.8} aria-hidden="true" />
              <Trans>New space</Trans>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  );
}
