import "@xterm/xterm/css/xterm.css";
import { useLingui } from "@lingui/react/macro";
import type { ComputerCommand } from "@rakazo/contracts";
import { encodeTerminalInput, encodeTerminalResize } from "@rakazo/contracts";
import { Button, cn, Tabs, TabsList, TabsTrigger } from "@rakazo/ui-web";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { type RefObject, useEffect, useRef, useState } from "react";
import {
  applyComputerCommandHistory,
  type ComputerActionLabels,
  capComputerCommands,
  formatComputerCommandFeed,
  mergeComputerCommand,
  subscribeComputerCommands,
  terminalSocketUrl,
} from "../../lib/computer-workspace";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

const COMMANDS_REFRESH_MS = 3_000;
/** Longer than the poll, so a slow page still lands. A hung request cannot block the next one. */
const COMMANDS_REFRESH_TIMEOUT_MS = 10_000;
const SHELL_RECONNECT_ATTEMPTS = 3;
const SHELL_RECONNECT_DELAY_MS = 1_000;
/** A shell connection that lasted this long counts as working again. */
const SHELL_STABLE_MS = 10_000;

type View = "activity" | "shell";

/**
 * The terminal always shows what the bot did on its computer. A user holding control can
 * also open an interactive shell; it starts on first use and stays connected across tab
 * switches. Without control, "Open shell" takes control and then switches to the shell.
 */
export default function TerminalApp({
  botId,
  canUseShell,
  onTakeControl,
}: {
  botId: string;
  canUseShell: boolean;
  onTakeControl?: () => Promise<boolean>;
}) {
  const { t } = useLingui();
  const [view, setView] = useState<View>("activity");
  const [shellOpened, setShellOpened] = useState(false);
  // Set by "Open shell": switch to the shell once control actually arrives.
  const [shellRequested, setShellRequested] = useState(false);
  const [takingControl, setTakingControl] = useState(false);
  const active = canUseShell ? view : "activity";

  useEffect(() => {
    if (!canUseShell || !shellRequested) return;
    setShellRequested(false);
    setView("shell");
    setShellOpened(true);
  }, [canUseShell, shellRequested]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {canUseShell ? (
        <Tabs
          value={active}
          onValueChange={(value) => {
            setView(value as View);
            if (value === "shell") setShellOpened(true);
          }}
          className="border-b border-border px-2 py-1.5"
        >
          <TabsList>
            <TabsTrigger value="activity">{t`Activity`}</TabsTrigger>
            <TabsTrigger value="shell">{t`Shell`}</TabsTrigger>
          </TabsList>
        </Tabs>
      ) : onTakeControl ? (
        <div className="border-b border-border px-2 py-1.5">
          <Button
            variant="outline"
            size="sm"
            disabled={takingControl}
            onClick={async () => {
              setShellRequested(true);
              setTakingControl(true);
              try {
                // Forget the request if control never arrives, so the shell does not open later.
                if (!(await onTakeControl())) setShellRequested(false);
              } finally {
                setTakingControl(false);
              }
            }}
          >
            {t`Open shell`}
          </Button>
        </div>
      ) : null}
      <ActivityTerminal botId={botId} hidden={active !== "activity"} />
      {canUseShell && shellOpened ? (
        <ShellTerminal botId={botId} hidden={active !== "shell"} />
      ) : null}
    </div>
  );
}

/** What the bot did on its computer: shell commands with their output, and file and app actions. */
function ActivityTerminal({ botId, hidden }: { botId: string; hidden: boolean }) {
  const { t } = useLingui();
  const host = useRef<HTMLDivElement>(null);
  const terminal = useXterm(host, false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!terminal) return;
    let commands: ComputerCommand[] = [];
    // Live commands since the last history page. The page replaces memory, so
    // events the API has already dropped are not kept on the next refresh.
    let pending: ComputerCommand[] = [];
    // The first history fetch has not landed yet, so an empty feed still means
    // loading rather than a bot that never ran a command.
    let loaded = false;
    let cancelled = false;
    const labels: ComputerActionLabels = {
      write_file: (path) => t`Wrote ${path}`,
      attach_file: (path) => t`Attached ${path}`,
      open_path: (path) => t`Opened ${path}`,
      launch_app: (app) => t`Launched ${app}`,
    };
    // Writes are queued, so clear in-band (ESC c) rather than with reset(), which runs
    // immediately and would let an earlier queued render land after it.
    const render = () => {
      if (commands.length === 0 && !loaded) return;
      terminal.write(
        `\x1bc${formatComputerCommandFeed(commands, labels, t`No bot activity yet.`)}`,
      );
    };
    const applyHistory = (history: ComputerCommand[]) => {
      commands = applyComputerCommandHistory(history, pending);
      pending = [];
      loaded = true;
      render();
    };
    const unsubscribe = subscribeComputerCommands((eventBotId, command) => {
      if (eventBotId !== botId) return;
      pending = capComputerCommands(mergeComputerCommand(pending, command));
      commands = capComputerCommands(mergeComputerCommand(commands, command));
      render();
    });
    // One fetch at a time. A slow response still lands. A request that does not
    // settle is aborted so the next poll can run.
    let refreshInFlight = false;
    const abort = new AbortController();
    const refresh = () => {
      if (refreshInFlight) return;
      refreshInFlight = true;
      const signal = AbortSignal.any([
        abort.signal,
        AbortSignal.timeout(COMMANDS_REFRESH_TIMEOUT_MS),
      ]);
      void rpc.computer
        .commands({ botId }, { signal })
        .then((history) => {
          if (cancelled) return;
          setError(null);
          applyHistory(history);
        })
        .catch((cause: unknown) => {
          if (!cancelled && commands.length === 0) {
            setError(errorText(cause, t`Could not load commands`));
          }
        })
        .finally(() => {
          refreshInFlight = false;
        });
    };
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, COMMANDS_REFRESH_MS);
    return () => {
      cancelled = true;
      abort.abort();
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [terminal, botId, t]);

  return <TerminalPane host={host} error={error} hidden={hidden} testId="computer-terminal" />;
}

function ShellTerminal({ botId, hidden }: { botId: string; hidden: boolean }) {
  const { t } = useLingui();
  const host = useRef<HTMLDivElement>(null);
  const terminal = useXterm(host, true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!terminal) return;
    let socket: WebSocket | null = null;
    let cancelled = false;
    let retry: number | undefined;
    // Consecutive drops; a connection that stayed up long enough resets the count.
    let drops = 0;
    const send = (frame: Uint8Array<ArrayBuffer>) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(frame);
    };
    const disposers = [
      terminal.onData((data) => send(encodeTerminalInput(data))),
      terminal.onResize(({ cols, rows }) => send(encodeTerminalResize(cols, rows))),
    ];
    const connect = () => {
      rpc.computer
        .terminalUrl({ botId })
        .then(({ url }) => {
          if (cancelled || !url) return;
          const target = terminalSocketUrl(url, window.location.href);
          if (!target) return;
          const current = new WebSocket(target, ["binary"]);
          socket = current;
          current.binaryType = "arraybuffer";
          let openedAt = 0;
          current.onopen = () => {
            openedAt = Date.now();
            setError(null);
            send(encodeTerminalResize(terminal.cols, terminal.rows));
            terminal.focus();
          };
          current.onmessage = (message) => {
            terminal.write(
              typeof message.data === "string" ? message.data : new Uint8Array(message.data),
            );
          };
          current.onclose = () => {
            if (cancelled || socket !== current) return;
            terminal.write("\r\n\x1b[2m[closed]\x1b[0m\r\n");
            drops = openedAt && Date.now() - openedAt > SHELL_STABLE_MS ? 1 : drops + 1;
            // A dropped connection (network, proxy re-check) gets a fresh shell. Without
            // control, terminalUrl refuses and the error explains why.
            if (drops <= SHELL_RECONNECT_ATTEMPTS) {
              retry = window.setTimeout(connect, SHELL_RECONNECT_DELAY_MS);
            }
          };
        })
        .catch((cause: unknown) => {
          if (!cancelled) setError(errorText(cause, t`Could not open terminal`));
        });
    };
    connect();
    return () => {
      cancelled = true;
      window.clearTimeout(retry);
      for (const disposer of disposers) disposer.dispose();
      socket?.close();
    };
  }, [terminal, botId, t]);

  useEffect(() => {
    if (!hidden) terminal?.focus();
  }, [hidden, terminal]);

  return <TerminalPane host={host} error={error} hidden={hidden} testId="computer-shell" />;
}

function TerminalPane({
  host,
  error,
  hidden,
  testId,
}: {
  host: RefObject<HTMLDivElement | null>;
  error: string | null;
  hidden: boolean;
  testId: string;
}) {
  return (
    <div className={cn("min-h-0 flex-1 flex-col", hidden ? "hidden" : "flex")}>
      {error ? (
        <div role="alert" className="px-3 py-2 text-[13px] text-destructive">
          {error}
        </div>
      ) : null}
      <div ref={host} data-testid={testId} className="min-h-0 flex-1 px-2 py-1.5" />
    </div>
  );
}

function useXterm(host: RefObject<HTMLDivElement | null>, interactive: boolean) {
  const [terminal, setTerminal] = useState<Terminal | null>(null);
  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({
      cursorBlink: interactive,
      disableStdin: !interactive,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      scrollback: 5000,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    fit.fit();
    // Hidden panes report no size; fitting then is a no-op until they are shown again.
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(host.current);
    setTerminal(term);
    return () => {
      observer.disconnect();
      term.dispose();
      setTerminal(null);
    };
  }, [host, interactive]);
  return terminal;
}

function terminalTheme() {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => style.getPropertyValue(name).trim() || undefined;
  return {
    background: token("--background"),
    foreground: token("--foreground"),
    cursor: token("--foreground"),
    selectionBackground: token("--accent"),
  };
}
