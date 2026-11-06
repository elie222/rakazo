import { ChatMarkdown } from "@rakazo/chat-ui/native";
import type { MessageBlock, ToolCallRecord, ToolStep } from "@rakazo/contracts";
import type { ToolStepStatus } from "@rakazo/core";
import {
  formatCompactDuration,
  formatElapsedSince,
  LIVE_TOOL_STEP_WINDOW,
  pickToolCallRecord,
  toolCallMarkdown,
  toolStepStatus,
} from "@rakazo/core";
import { typeScale } from "@rakazo/ui-tokens";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { rpc } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { native, useMobileTokens, useResolvedAppearance } from "../../lib/native";
import { readFinishedRunToolCalls } from "../../lib/tool-call-reads";
import { toolCallRecords } from "../../lib/tool-call-records";
import { NativeSymbol } from "../native-symbol";

type StepsBlock = Extract<MessageBlock, { kind: "steps" }>;
type Status = ToolStepStatus;

const MONO = Platform.select({ ios: "ui-monospace", default: "monospace" });

/**
 * A reply's tool calls: one line with the count and time, open while the run is live. Each row
 * names the call and opens to its command and what it returned or printed.
 */
export function ToolActivityCard({
  block,
  live,
  threadId,
  runId,
  startedAt,
}: {
  block: StepsBlock;
  live: boolean;
  threadId?: string;
  runId?: string;
  startedAt?: string;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  // Open while live; a finished run folds. Changing phase resets a manual toggle.
  const [open, setOpen] = useState(live);
  useEffect(() => setOpen(live), [live]);
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(() => new Set());
  const count = block.steps.reduce((total, step) => total + step.count, 0);
  const elapsed = useElapsed(live ? startedAt : undefined);
  const duration = live ? elapsed : formatCompactDuration(block.durationMs);
  const hidden =
    live && block.steps.length > LIVE_TOOL_STEP_WINDOW
      ? block.steps.length - LIVE_TOOL_STEP_WINDOW
      : 0;
  const shown = hidden > 0 ? block.steps.slice(hidden) : block.steps;
  const summary = [
    live ? t("Working…") : t("Done"),
    count === 1 ? t("{count} tool", { count }) : t("{count} tools", { count }),
    duration,
  ]
    .filter(Boolean)
    .join("  ");
  return (
    <View testID="tool-activity" style={styles.card}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={summary}
        onPress={() => setOpen((wasOpen) => !wasOpen)}
        style={styles.header}
        hitSlop={6}
      >
        <NativeSymbol
          ios={open ? "chevron.down" : "chevron.right"}
          android={open ? "chevron-down" : "chevron-forward"}
          size={12}
          color={tokens.mutedForeground}
        />
        <Text
          style={[styles.summary, { color: live ? tokens.foreground : tokens.mutedForeground }]}
        >
          {summary}
        </Text>
      </Pressable>
      {open ? (
        <View style={[styles.rows, { borderColor: tokens.border }]}>
          {hidden > 0 ? (
            <Text style={[styles.hidden, { color: tokens.mutedForeground }]}>+{hidden}</Text>
          ) : null}
          {shown.map((step, offset) => {
            // Keyed by place in the block, so a repeated call joining the row keeps it open.
            const key = `step-${hidden + offset}`;
            const expandable = Boolean(step.executionId && runId);
            const expanded = expandable && openRows.has(key);
            return (
              <View key={key}>
                {step.note ? (
                  <Text style={[styles.note, { color: tokens.mutedForeground }]}>{step.note}</Text>
                ) : null}
                <StepRow
                  step={step}
                  status={toolStepStatus(step, live)}
                  expanded={expandable ? expanded : undefined}
                  onToggle={
                    expandable
                      ? () =>
                          setOpenRows((prev) => {
                            const next = new Set(prev);
                            if (next.has(key)) next.delete(key);
                            else next.add(key);
                            return next;
                          })
                      : undefined
                  }
                />
                {expanded && runId && step.executionId ? (
                  <StepPanel
                    step={step}
                    executionId={step.executionId}
                    runId={runId}
                    threadId={threadId}
                    status={toolStepStatus(step, live)}
                    runLive={live}
                  />
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

function StepRow({
  step,
  status,
  expanded,
  onToggle,
}: {
  step: ToolStep;
  status: Status;
  expanded: boolean | undefined;
  onToggle: (() => void) | undefined;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const running = status === "running";
  const duration = running ? null : formatCompactDuration(step.durationMs);
  const statusLabel = status === "error" ? t("Failed") : running ? t("Running") : t("Done");
  const label = `${step.label}${step.count > 1 ? ` ×${step.count}` : ""}`;
  return (
    <Pressable
      testID="tool-step"
      disabled={!onToggle}
      accessibilityRole={onToggle ? "button" : "text"}
      accessibilityState={onToggle ? { expanded } : undefined}
      accessibilityLabel={[statusLabel, label, step.detail, duration].filter(Boolean).join(", ")}
      onPress={onToggle}
      style={({ pressed }) => [
        styles.row,
        pressed ? { backgroundColor: native.fillPressed } : null,
      ]}
    >
      <Text
        style={[
          styles.glyph,
          {
            color:
              status === "error" ? tokens.destructive : running ? tokens.warning : tokens.success,
          },
        ]}
      >
        {status === "error" ? "✕" : running ? "◷" : "✓"}
      </Text>
      <Text
        numberOfLines={1}
        style={[styles.label, { color: running ? tokens.foreground : tokens.mutedForeground }]}
      >
        {label}
      </Text>
      {step.detail ? (
        <Text numberOfLines={1} style={[styles.detail, { color: tokens.mutedForeground }]}>
          {step.detail}
        </Text>
      ) : (
        <View style={styles.spacer} />
      )}
      {duration ? (
        <Text style={[styles.duration, { color: tokens.mutedForeground }]}>{duration}</Text>
      ) : null}
    </Pressable>
  );
}

/** The record for one call: live from the thread's events, else read from the run's; see pickToolCallRecord. */
function useToolCallRecord(
  runId: string,
  executionId: string,
  threadId: string | undefined,
  runLive: boolean,
) {
  const live = useSyncExternalStore(toolCallRecords.subscribe, () =>
    toolCallRecords.get(runId),
  )?.get(executionId);
  const [fetched, setFetched] = useState<{ records?: ToolCallRecord[]; failed?: boolean }>();
  const needsFetch =
    pickToolCallRecord(live, undefined, runLive).needsRead && threadId !== undefined;
  useEffect(() => {
    if (!needsFetch || !threadId) return;
    let cancelled = false;
    const read = () => rpc("threads/toolCalls", { threadId, runId });
    // A live run's calls keep changing; a finished run's are read once for all its steps.
    (runLive ? read() : readFinishedRunToolCalls(runId, executionId, read)).then(
      (records) => !cancelled && setFetched({ records }),
      () => !cancelled && setFetched({ failed: true }),
    );
    return () => {
      cancelled = true;
    };
  }, [needsFetch, threadId, runId, runLive, executionId]);
  const read = fetched?.records?.find((item) => item.executionId === executionId);
  const { record } = pickToolCallRecord(live, read, runLive);
  return {
    record,
    loading: live === undefined && needsFetch && fetched === undefined,
    failed: fetched?.failed === true,
  };
}

/**
 * The call opened: a line naming it, the chat's own code block with what it ran and what came
 * back (following live while a shell command runs), and the exit code or error under it.
 */
function StepPanel({
  step,
  executionId,
  runId,
  threadId,
  status,
  runLive,
}: {
  step: ToolStep;
  executionId: string;
  runId: string;
  threadId?: string;
  status: Status;
  /** The run is still going, so the thread's events keep this call's record current. */
  runLive: boolean;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const { record, loading, failed } = useToolCallRecord(runId, executionId, threadId, runLive);
  const running = record?.status === "running" || status === "running";
  const markdown = record ? toolCallMarkdown(record) : "";
  const exit =
    record?.exitCode === undefined || record.exitCode === null
      ? null
      : t("exit {code}", { code: record.exitCode });
  const duration = formatCompactDuration(record?.durationMs ?? step.durationMs);
  const muted = { color: tokens.mutedForeground };
  return (
    <View testID="tool-step-panel" style={styles.panel}>
      <View style={styles.panelHeader}>
        <View
          style={[
            styles.dot,
            {
              backgroundColor:
                status === "error" ? tokens.destructive : running ? tokens.warning : tokens.success,
            },
          ]}
        />
        <Text style={[styles.meta, muted]}>{step.label}</Text>
        {record?.command === undefined && step.detail ? (
          <Text numberOfLines={1} style={[styles.mono, styles.grow, muted]}>
            {step.detail}
          </Text>
        ) : null}
      </View>
      {markdown ? (
        <ScrollView nestedScrollEnabled style={styles.code} testID="tool-step-code">
          <ChatMarkdown palette={tokens} colorScheme={colorScheme} streaming={running}>
            {markdown}
          </ChatMarkdown>
        </ScrollView>
      ) : record?.error || exit || running || record?.withheld ? null : (
        <Text style={[styles.empty, muted]}>
          {loading
            ? t("Loading…")
            : failed
              ? t("Couldn't load this step.")
              : t("No output recorded.")}
        </Text>
      )}
      {record?.error || exit || duration ? (
        <View style={styles.footer}>
          {record?.error ? (
            <Text selectable style={[styles.meta, styles.error, { color: tokens.destructive }]}>
              {record.error}
            </Text>
          ) : null}
          {exit ? <Text style={[styles.meta, muted]}>{exit}</Text> : null}
          {duration ? <Text style={[styles.meta, muted]}>{duration}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

/** Time since the run's first activity, ticking once a second while it is live. */
function useElapsed(startedAt: string | undefined): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return formatElapsedSince(startedAt, now);
}

const styles = StyleSheet.create({
  card: { alignSelf: "stretch", gap: 2 },
  header: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 2 },
  summary: { ...typeScale.footnote, fontWeight: "600" },
  rows: { marginStart: 5, paddingStart: 10, borderStartWidth: StyleSheet.hairlineWidth, gap: 1 },
  hidden: { ...typeScale.footnote, paddingVertical: 2 },
  note: { ...typeScale.footnote, paddingVertical: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 28, borderRadius: 6 },
  glyph: { ...typeScale.footnote, width: 14, textAlign: "center" },
  label: { ...typeScale.footnote, flexShrink: 0, maxWidth: "45%" },
  detail: { ...typeScale.footnote, fontFamily: MONO, flex: 1, minWidth: 0 },
  spacer: { flex: 1 },
  duration: { ...typeScale.footnote, fontFamily: MONO },
  panel: { marginVertical: 4, gap: 6 },
  panelHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  grow: { flex: 1, minWidth: 0 },
  mono: { ...typeScale.footnote, fontFamily: MONO },
  code: { maxHeight: 320 },
  empty: { ...typeScale.footnote },
  footer: { flexDirection: "row", flexWrap: "wrap", columnGap: 12 },
  meta: { ...typeScale.footnote, fontFamily: MONO },
  error: { flexShrink: 1 },
});
