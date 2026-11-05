import { useNativeLinkConfirm } from "@rakazo/chat-ui/native";
import type { MessageBlock } from "@rakazo/contracts";
import { MCP_APP_MIME_TYPE } from "@rakazo/contracts";
import { createMcpAppHost, mcpAppCsp, mcpAppDocument, mcpAppShellDocument } from "@rakazo/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { currentApiBase } from "../../lib/api";
import type { MobileArtifactTarget } from "../../lib/artifact-open";
import { textMobileArtifact } from "../../lib/artifact-open";
import { offerComposerText } from "../../lib/composer-offer";
import { useI18n } from "../../lib/i18n";
import { useMobileTokens, useResolvedAppearance } from "../../lib/native";
import { pageActionAllowed, pageMessage, pageTapStart } from "../../lib/pages";
import { SandboxedHtmlPreview } from "../sandboxed-html-preview";

type AppBlock = Extract<MessageBlock, { kind: "app" }>;

const MIN_HEIGHT = 80;
const MAX_HEIGHT = 560;
/** An app that has not started by then is not shown; the bot's reply stands without it. */
const START_TIMEOUT_MS = 15_000;

function apiHost(): string[] {
  try {
    return [new URL(currentApiBase()).hostname];
  } catch {
    return [];
  }
}

/**
 * An MCP server's app for one tool call, as on the web: the shared shell runs it in an
 * opaque-origin frame inside a WebView with no cookies, storage or navigation, reaching only the
 * domains it declared that this app allows. A link or a message for the composer needs a tap on
 * the card first, which the page inside cannot fake; tool calls are refused.
 */
export function McpAppCard({ block, target }: { block: AppBlock; target: MobileArtifactTarget }) {
  const tokens = useMobileTokens();
  const theme = useResolvedAppearance();
  const { locale } = useI18n();
  const openLink = useNativeLinkConfirm();
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [started, setStarted] = useState(false);
  const [height, setHeight] = useState(0);
  const tapStart = useRef<ReturnType<typeof pageTapStart>>(null);
  const tappedAt = useRef<number | null>(null);
  const answer = useRef<((message: object) => void) | null>(null);
  const threadKey = "botId" in target ? target.botId : target.groupId;

  useEffect(() => {
    let active = true;
    void textMobileArtifact(target, block.artifactId, MCP_APP_MIME_TYPE)
      .then((text) => active && setHtml(text))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
    // The artifact is immutable; the target only names where it is read from.
  }, [block.artifactId]);

  useEffect(() => {
    if (!html || started) return;
    const timer = setTimeout(() => setFailed(true), START_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [html, started]);

  const excludeHosts = useMemo(apiHost, []);
  // A refetched message is a new object with the same values; the app's session must outlive it.
  const cspKey = JSON.stringify(block.csp ?? {});
  const csp = useMemo(() => mcpAppCsp(JSON.parse(cspKey), excludeHosts), [cspKey, excludeHosts]);
  const latest = useRef(block);
  latest.current = block;
  const shell = useMemo(
    () => (html === null ? null : mcpAppShellDocument(mcpAppDocument(html, csp, excludeHosts))),
    [html, csp, excludeHosts],
  );
  const host = useMemo(
    () =>
      createMcpAppHost({
        input: latest.current.toolArguments,
        result: latest.current.toolResult,
        hostContext: {
          theme,
          displayMode: "inline",
          availableDisplayModes: ["inline"],
          containerDimensions: { maxHeight: MAX_HEIGHT },
          locale,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          platform: "mobile",
          deviceCapabilities: { touch: true, hover: false },
        },
        csp,
        send: (message) => answer.current?.({ type: "rakazo-app:host", message }),
        // One tap, one action.
        allowAction: () => {
          if (!pageActionAllowed(tappedAt.current, Date.now())) return false;
          tappedAt.current = null;
          return true;
        },
        openLink,
        offerMessage: (text) => offerComposerText(threadKey, text),
        onHeight: (next) => setHeight(Math.min(Math.max(Math.ceil(next), MIN_HEIGHT), MAX_HEIGHT)),
      }),
    // A new session only for a new document; theme changes reach it as context updates.
    [shell],
  );
  // A running view hears about later changes instead of restarting.
  useEffect(() => host.updateContext({ theme, locale }), [host, theme, locale]);
  useEffect(() => () => host.teardown(), [host]);

  if (failed) return null;
  const bordered = block.prefersBorder !== false;
  return (
    <View style={styles.card} testID="mcp-app">
      <Text style={[styles.server, { color: tokens.mutedForeground }]} numberOfLines={1}>
        {block.server}
      </Text>
      <View
        style={[
          styles.frame,
          { height: started && height ? height : MIN_HEIGHT * 2 },
          bordered && { borderColor: tokens.border, backgroundColor: tokens.card, borderWidth: 1 },
        ]}
        onTouchStart={({ nativeEvent }) => {
          const { pageX, pageY, touches } = nativeEvent;
          tapStart.current = touches.length === 1 ? { pageX, pageY } : null;
        }}
        onTouchMove={({ nativeEvent }) => {
          tapStart.current = pageTapStart(tapStart.current, nativeEvent);
        }}
        onTouchEnd={({ nativeEvent }) => {
          if (pageTapStart(tapStart.current, nativeEvent)) tappedAt.current = Date.now();
        }}
        onTouchCancel={() => {
          tapStart.current = null;
        }}
      >
        {shell ? (
          <SandboxedHtmlPreview
            html={shell}
            appShell
            background="transparent"
            scrollEnabled={false}
            onMessage={(data, reply) => {
              answer.current = reply;
              const envelope = pageMessage(data) as { type?: unknown; message?: unknown } | null;
              if (envelope?.type !== "rakazo-app:view") return;
              if ((envelope.message as { method?: unknown })?.method === "ui/initialize") {
                setStarted(true);
              }
              host.receive(envelope.message);
            }}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { width: "100%", gap: 6 },
  server: { fontSize: 12, paddingHorizontal: 4 },
  frame: { overflow: "hidden", borderRadius: 20 },
});
