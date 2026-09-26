import "@xterm/xterm/css/xterm.css";
import { useLingui } from "@lingui/react/macro";
import type { ComputerCommand } from "@rakazo/contracts";
import { foldComputerCommands } from "@rakazo/contracts";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { type RefObject, useEffect, useRef, useState } from "react";
import {
  type ComputerActionLabels,
  formatComputerCommand,
  mergeComputerCommand,
  subscribeComputerCommands,
} from "../../lib/computer-workspace";
import { rpc } from "../../lib/rpc";

const COMMANDS_REFRESH_MS = 3_000;

/** What the bot did on its computer: shell commands with their output, and file and app actions. */
export default function TerminalApp({ botId }: { botId: string }) {
  const { t } = useLingui();
  const host = useRef<HTMLDivElement>(null);
  const terminal = useXterm(host);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!terminal) return;
    let commands: ComputerCommand[] = [];
    let cancelled = false;
    const labels: ComputerActionLabels = {
      write_file: (path) => t`Wrote ${path}`,
      attach_file: (path) => t`Attached ${path}`,
      open_path: (path) => t`Opened ${path}`,
      launch_app: (app) => t`Launched ${app}`,
    };
    // Writes are queued, so clear in-band (ESC c) rather than with reset(), which runs
    // immediately and would let an earlier queued render land after it.
    const render = () =>
      terminal.write(
        `\x1bc${commands.map((command) => formatComputerCommand(command, labels)).join("")}`,
      );
    const applyHistory = (history: ComputerCommand[]) => {
      commands = foldComputerCommands([...history, ...commands]);
      render();
    };
    const unsubscribe = subscribeComputerCommands((eventBotId, command) => {
      if (eventBotId !== botId) return;
      commands = mergeComputerCommand(commands, command);
      render();
    });
    const refresh = () =>
      rpc.computer
        .commands({ botId })
        .then((history) => {
          if (!cancelled) applyHistory(history);
        })
        .catch((cause: unknown) => {
          if (!cancelled && commands.length === 0) {
            setError(errorMessage(cause, t`Could not load commands`));
          }
        });
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, COMMANDS_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [terminal, botId, t]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {error ? (
        <div role="alert" className="px-3 py-2 text-[13px] text-destructive">
          {error}
        </div>
      ) : null}
      <div ref={host} data-testid="computer-terminal" className="min-h-0 flex-1 px-2 py-1.5" />
    </div>
  );
}

function useXterm(host: RefObject<HTMLDivElement | null>) {
  const [terminal, setTerminal] = useState<Terminal | null>(null);
  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({
      disableStdin: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      scrollback: 5000,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    fit.fit();
    // A hidden window reports no size; fitting then is a no-op until it is shown again.
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(host.current);
    setTerminal(term);
    return () => {
      observer.disconnect();
      term.dispose();
      setTerminal(null);
    };
  }, [host]);
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

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}
