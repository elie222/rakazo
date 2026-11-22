import { Trans, useLingui } from "@lingui/react/macro";
import { useLinkPrompt } from "@rakazo/chat-ui/web";
import type { MessageBlock } from "@rakazo/contracts";
import { bestEffort } from "@rakazo/logging/best-effort";
import { Button, Dialog, DialogClose, DialogContent, DialogTitle } from "@rakazo/ui-web";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { BuiCard, SuccessPop } from "../../../components/ai/primitives";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { OptionRow } from "../../../components/messages/OptionRow";
import {
  APP_CONNECT_WINDOW_NAME,
  rememberAppConnectReturn,
} from "../../../lib/integrations/app-connect";
import { connectMcpOauth } from "../../../lib/integrations/mcp-connect";
import type { ArtifactTarget } from "../../../lib/pages/artifact-open";
import { chartViewport } from "../../../lib/pages/chart-viewport";
import { useArtifactImage } from "../../../lib/pages/use-artifact-image";
import { importChunk } from "../../../lib/platform/preload-recovery";
import { useSave } from "../../../lib/query/query";
import { rpc } from "../../../lib/query/rpc";
import type { ErrorDetails } from "../../../lib/query/user-error";
import { errorDetails, errorText } from "../../../lib/query/user-error";
import { useEventListener } from "../../../lib/use-event-listener";

export function ChoiceCard({
  botId,
  block,
  onBotChanged,
}: {
  botId: string;
  block: Extract<MessageBlock, { kind: "choice" }>;
  onBotChanged: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [locallyDismissed, setLocallyDismissed] = useState(false);
  const dismissed = locallyDismissed || block.answerId === "_dismissed";
  const answer = useSave({
    save: (input: { optionId: string } | { dismiss: true }, rpc) =>
      "optionId" in input
        ? rpc.onboarding.choose({ botId, optionId: input.optionId })
        : rpc.onboarding.dismissFocus({ botId }),
    // An answered card takes no second answer; the thread brings the answer back.
    closesScreen: true,
    onSaved: async (_saved, input) => {
      if ("optionId" in input) return onBotChanged();
      setLocallyDismissed(true);
      void onBotChanged().catch(() => undefined);
    },
  });
  const pending = answer.pending;
  const error = answer.error
    ? errorText(
        answer.error,
        answer.input && "optionId" in answer.input
          ? t`Could not save this choice`
          : t`Could not dismiss`,
      )
    : null;

  if (dismissed) return null;

  return (
    <div className="flex justify-start">
      <BuiCard className="relative w-[420px] max-w-full px-[18px] py-[14px]">
        {!block.answerId ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t`Dismiss`}
            disabled={pending}
            onClick={() => answer.run({ dismiss: true })}
            className="absolute end-2 top-2 text-muted-foreground"
          >
            <X size={16} strokeWidth={1.8} />
          </Button>
        ) : null}
        <div className="pe-8 text-body-lg text-foreground/90">
          <OnboardingFocusQuestion question={block.question} />
        </div>
        {block.subtitle ? (
          <div className="mt-0.5 text-body-sm text-foreground/75">{block.subtitle}</div>
        ) : null}
        <div className="mt-2.5 space-y-0.5">
          {block.options.map((option) => (
            <OptionRow
              key={option.id}
              letter={option.letter}
              selected={block.answerId ? block.answerId === option.id : undefined}
              disabled={Boolean(block.answerId) || pending}
              onClick={() => answer.run({ optionId: option.id })}
            >
              <OnboardingFocusOptionLabel
                id={option.id}
                label={option.label}
                question={block.question}
              />
            </OptionRow>
          ))}
        </div>
        {error ? <p className="mt-2 text-label text-destructive">{error}</p> : null}
      </BuiCard>
    </div>
  );
}

const FOCUS_QUESTION = "What do you want me on first?";

/** First-run Chief focus card: API stores English; UI locale catalogs translate it. */
function OnboardingFocusQuestion({ question }: { question: string }) {
  if (question === FOCUS_QUESTION) {
    return <Trans>What do you want me on first?</Trans>;
  }
  return question;
}

function OnboardingFocusOptionLabel({
  id,
  label,
  question,
}: {
  id: string;
  label: string;
  question: string;
}) {
  if (question !== FOCUS_QUESTION) return label;
  switch (id) {
    case "day":
      return <Trans>Day-to-day work</Trans>;
    case "inbox":
      return <Trans>Inbox & email</Trans>;
    case "research":
      return <Trans>Research & writing</Trans>;
    case "everything":
      return <Trans>A bit of everything</Trans>;
    default:
      return label;
  }
}

function AppLogo({ name, logo }: { name: string; logo: string | null }) {
  return logo ? (
    <img src={logo} alt="" className="h-10 w-10 rounded-md bg-favicon-plate object-contain p-1" />
  ) : (
    <span className="grid h-10 w-10 place-items-center rounded-md bg-muted text-body-lg text-foreground">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function AppConnectCard({
  botId,
  threadId,
  messageId,
  block,
}: {
  botId: string;
  threadId: string;
  messageId?: string;
  block: Extract<MessageBlock, { kind: "app_connect" }>;
}) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const [localStatus, setLocalStatus] = useState<"pending" | "connected">(block.status);
  const [error, setError] = useState<string | null>(null);
  /** The sign-in under way: a new one replaces it, and its connection is read on return. */
  const attempt = useRef<{ controller: AbortController; connectionId?: string } | null>(null);
  const status = block.status === "connected" ? "connected" : localStatus;
  useEffect(() => () => attempt.current?.controller.abort(), []);
  // The callback finishes the sign-in and the server updates this card; reading the connection
  // once when the popup hands focus back covers a callback that could not finish it.
  useEventListener(window, "focus", () => void readConnection());

  async function readConnection() {
    const current = attempt.current;
    if (!current?.connectionId) return;
    const row = await bestEffort(
      "read an app connection",
      rpc.connections.complete(
        { connectionId: current.connectionId },
        { signal: current.controller.signal },
      ),
    );
    if (attempt.current !== current || row?.status !== "connected") return;
    attempt.current = null;
    setLocalStatus("connected");
  }

  async function authorize() {
    attempt.current?.controller.abort();
    const current = { controller: new AbortController() };
    attempt.current = current;
    setBusy(true);
    setError(null);
    try {
      const started = await rpc.connections.begin(
        {
          connectorId: block.connectorId,
          provider: block.provider,
          displayName: block.name,
          origin: { botId, threadId, ...(messageId ? { messageId } : {}) },
        },
        { signal: current.controller.signal },
      );
      if (attempt.current !== current) return;
      if (!started.authorizationUrl) {
        setLocalStatus("connected");
        return;
      }
      attempt.current = { ...current, connectionId: started.connectionId };
      const popup = window.open(
        started.authorizationUrl,
        APP_CONNECT_WINDOW_NAME,
        "popup,width=560,height=720",
      );
      if (!popup) {
        // A blocked popup signs in in this tab; the callback brings it back to this chat.
        rememberAppConnectReturn(started.connectionId);
        window.location.assign(started.authorizationUrl);
      }
    } catch (error) {
      if (!current.controller.signal.aborted) {
        setError(errorText(error, t`Could not authorize this app`));
      }
    } finally {
      // Connect stays usable while the sign-in is open, so another tap starts over at once.
      if (attempt.current?.controller === current.controller) setBusy(false);
    }
  }
  return (
    <BuiCard
      role="group"
      aria-label={t`${block.name} connection`}
      className="w-full max-w-[440px] px-4 py-3.5"
    >
      <div className="flex items-center gap-3.5">
        <AppLogo name={block.name} logo={block.logo} />
        <span className="min-w-0 flex-1">
          <span className="block text-body-lg font-medium text-foreground">{block.name}</span>
          <span className="block truncate text-body-sm text-muted-foreground">
            {block.description}
          </span>
        </span>
        {status === "connected" ? (
          <SuccessPop label={t`Connected`} />
        ) : (
          <Button disabled={busy} onClick={() => void authorize()}>
            {busy ? t`Waiting…` : t`Connect`}
          </Button>
        )}
      </div>
      {error ? <p className="mt-2 text-label text-destructive">{error}</p> : null}
    </BuiCard>
  );
}

function ChartCanvas({
  spec,
  data,
  width,
  height,
}: {
  spec: Record<string, unknown>;
  data: unknown[];
  width: number;
  height?: number;
}) {
  const { t } = useLingui();
  const ref = useRef<HTMLDivElement>(null);
  const linkDialog = useLinkPrompt(ref);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{
    title?: string;
    swatches: { label: string; color: string }[];
  }>({ swatches: [] });
  useEffect(() => {
    let cancelled = false;
    // Plot loads lazily so threads without charts never pay for the library.
    void (async () => {
      try {
        const { buildPlotParts } = await importChunk(() => import("@rakazo/core/plot"));
        if (cancelled || !ref.current) return;
        // Hover inspection by default: give the first mark a tooltip unless
        // the spec already asks for one somewhere.
        const marks = Array.isArray((spec as { marks?: unknown[] }).marks)
          ? ((spec as { marks: { options?: Record<string, unknown> }[] }).marks ?? [])
          : [];
        const hasTip = marks.some((mark) => mark.options && "tip" in mark.options);
        const liveSpec = hasTip
          ? spec
          : {
              ...spec,
              marks: marks.map((mark, index) =>
                index === 0 ? { ...mark, options: { ...(mark.options ?? {}), tip: true } } : mark,
              ),
            };
        const parts = buildPlotParts(liveSpec as never, data, document, { width, height });
        setMeta({ title: parts.title, swatches: parts.swatches });
        setError(null);
        ref.current.replaceChildren(parts.plotted);
      } catch (err) {
        if (!cancelled) setError(errorText(err, t`Could not render chart`));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [spec, data, width, height, t]);
  if (error)
    return (
      <div className="text-body-sm text-destructive">
        <Trans>Chart failed to render: {error}</Trans>
      </div>
    );
  return (
    <div className="text-foreground/75">
      {meta.title ? (
        <div className="mb-1 text-body-lg font-semibold text-foreground">{meta.title}</div>
      ) : null}
      {meta.swatches.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1">
          {meta.swatches.map((swatch) => (
            <span
              key={swatch.label}
              className="flex items-center gap-1.5 text-label text-muted-foreground"
            >
              {/* Series colours are data-driven and intentionally distinct. */}
              <span
                className="h-[10px] w-[10px] rounded-[3px]"
                style={{ background: swatch.color }}
              />
              {swatch.label}
            </span>
          ))}
        </div>
      ) : null}
      <div ref={ref} className="overflow-hidden [contain:paint] [&_svg]:max-w-full" />
      {linkDialog}
    </div>
  );
}

type McpApprovalState = "pending" | "connecting" | "connected" | "dismissed";

/** Approval card for an agent-created MCP server: the user completes browser
 * OAuth (or confirms no authorization is needed) without leaving the chat.
 * The decision persists on the block, so the card keeps showing it after the
 * thread remounts. */
export function McpApprovalCard({
  botId,
  threadId,
  block,
}: {
  botId: string | undefined;
  threadId: string | undefined;
  block: Extract<MessageBlock, { kind: "mcp_approval" }>;
}) {
  const { t } = useLingui();
  const { name, serverId, transport, endpoint, needsOAuth, status: savedStatus } = block;
  const [localStatus, setLocalStatus] = useState<McpApprovalState>("pending");
  const [error, setError] = useState<ErrorDetails | null>(null);
  const [busy, setBusy] = useState(false);
  // A removal repaints the block to pending. Drop an in-session connected
  // override so the card does not keep the old decision.
  useEffect(() => {
    if (savedStatus === "connected" || savedStatus === "dismissed") return;
    setLocalStatus((current) =>
      current === "connected" || current === "dismissed" ? "pending" : current,
    );
  }, [savedStatus]);
  // Blocks saved before the status field existed have none and count as pending.
  const state =
    savedStatus === "connected" || savedStatus === "dismissed" ? savedStatus : localStatus;

  async function authorize() {
    if (!botId || busy) {
      if (!botId) setError(errorDetails(t`This server cannot be assigned without a bot.`));
      return;
    }
    setBusy(true);
    setLocalStatus("connecting");
    setError(null);
    try {
      if (needsOAuth) {
        const result = await connectMcpOauth(serverId);
        if (result === "cancelled") {
          setLocalStatus("pending");
          return;
        }
      }
      await rpc.mcp.assignments.approve({ botId, serverId, threadId });
      setLocalStatus("connected");
    } catch (err) {
      setError(errorDetails(err, t`Could not approve this server`));
      setLocalStatus("pending");
    } finally {
      setBusy(false);
    }
  }

  async function dismiss() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (botId) {
        await rpc.mcp.assignments.dismiss({ botId, serverId, threadId });
      }
      setLocalStatus("dismissed");
    } catch (err) {
      setLocalStatus("pending");
      setError(errorDetails(err, t`Could not dismiss this server`));
    } finally {
      setBusy(false);
    }
  }

  const summary = endpoint ?? `stdio (${transport})`;
  // A marketplace listing says what the server is, so the card leads with that instead.
  const listed = block.description !== undefined;
  return (
    <BuiCard data-testid="mcp-approval-card" className="w-full min-w-0 max-w-xl p-4">
      {listed ? (
        <div className="flex items-center gap-3.5">
          <AppLogo name={name} logo={block.logo ?? null} />
          <span className="min-w-0 flex-1">
            <span className="block text-body-lg font-medium text-foreground">{name}</span>
            <span className="block truncate text-body-sm text-muted-foreground">
              {block.description}
            </span>
          </span>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-muted text-label text-foreground">
              M
            </span>
            <span className="text-body-lg font-medium text-foreground">
              <Trans>Connect MCP server “{name}”</Trans>
            </span>
          </div>
          <p className="mt-1.5 truncate text-label text-muted-foreground">{summary}</p>
        </>
      )}
      {state === "pending" || state === "connecting" ? (
        <>
          {listed ? null : (
            <p className="mt-2 text-body-sm leading-[1.5] text-foreground/75">
              {needsOAuth
                ? t`Authorize this server so agents can use its tools. A popup opens.`
                : t`Approve this server to let your agent use its tools.`}
            </p>
          )}
          {error ? (
            <div className="mt-2">
              <ErrorNotice error={error} />
            </div>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button disabled={state !== "pending" || busy} onClick={() => void authorize()}>
              {state === "connecting" ? t`Connecting…` : needsOAuth ? t`Authorize` : t`Approve`}
            </Button>
            <Button
              variant="secondary"
              disabled={state !== "pending" || busy}
              onClick={() => void dismiss()}
            >
              <Trans>Not now</Trans>
            </Button>
          </div>
        </>
      ) : null}
      {state === "connected" ? (
        <div className="mt-3">
          <SuccessPop label={t`Connected`} />
        </div>
      ) : null}
      {state === "dismissed" ? (
        <p className="mt-2 text-body-sm text-muted-foreground">
          <Trans>Dismissed. Reconnect anytime from MCP settings.</Trans>
        </p>
      ) : null}
    </BuiCard>
  );
}

export function ChartBlockView({
  name,
  spec,
  data,
}: {
  name: string;
  spec: Record<string, unknown>;
  data: unknown[];
}) {
  const { t } = useLingui();
  const [expanded, setExpanded] = useState(false);
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const measureViewport = () =>
    setViewport({ width: window.innerWidth, height: window.innerHeight });
  useEffect(() => {
    if (expanded) measureViewport();
  }, [expanded]);
  useEventListener(expanded ? window : null, "resize", measureViewport);
  const expandedViewport = chartViewport(viewport.width, viewport.height);
  return (
    <>
      <div className="group relative w-[552px] max-w-full rounded-2xl bg-muted p-4">
        <ChartCanvas spec={spec} data={data} width={520} />
        <Button
          variant="outline"
          size="xs"
          onClick={() => setExpanded(true)}
          className="absolute end-3 top-3 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        >
          <Trans>Expand</Trans>
        </Button>
      </div>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent
          showCloseButton={false}
          className="max-h-[92vh] w-[min(1320px,94vw)] max-w-none overflow-auto p-8 sm:max-w-none"
        >
          <div className="flex items-center justify-between">
            <DialogTitle className="text-body-sm font-normal text-muted-foreground">
              {name}
            </DialogTitle>
            <DialogClose
              aria-label={t`Close chart`}
              render={<Button variant="ghost" size="icon-sm" />}
            >
              <X />
            </DialogClose>
          </div>
          <ChartCanvas
            spec={spec}
            data={data}
            width={expandedViewport.width}
            height={expandedViewport.height}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ArtifactImage({
  target,
  artifactId,
  name,
}: {
  target: ArtifactTarget;
  artifactId: string;
  name: string;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const src = useArtifactImage(target, artifactId, visible);

  useEffect(() => {
    const element = container.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "320px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={container}>
      {src ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="max-w-[240px] overflow-hidden rounded-2xl"
        >
          <img src={src} alt={name} className="max-h-48 w-full object-cover" />
        </button>
      ) : (
        <div className="rounded-2xl bg-muted px-4 py-3 text-body text-muted-foreground">{name}</div>
      )}
      {src ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent
            showCloseButton={false}
            className="w-auto max-w-none bg-transparent p-0 ring-0 sm:max-w-none"
          >
            <DialogTitle className="sr-only">{name}</DialogTitle>
            <DialogClose
              aria-label={t`Close image preview`}
              render={<Button variant="ghost" size="icon-sm" className="absolute end-2 top-2" />}
            >
              <X />
            </DialogClose>
            <img
              src={src}
              alt={name}
              className="max-h-[85vh] max-w-[90vw] rounded-xl object-contain"
            />
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
