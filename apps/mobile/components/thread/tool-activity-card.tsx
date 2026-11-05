import type { MessageBlock, ToolCallRecord, ToolStep } from "@rakazo/contracts";
import { formatCompactDuration } from "@rakazo/core";
import { typeScale } from "@rakazo/ui-tokens";
import * as Clipboard from "expo-clipboard";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { rpc } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { native, useMobileTokens } from "../../lib/native";
import { toolCallRecords } from "../../lib/tool-call-records";
import { NativeSymbol } from "../native-symbol";

type StepsBlock = Extract<MessageBlock, { kind: "steps" }>;
type Status = "running" | "ok" | "error";

/** While a run is live, only the newest steps are listed so a long run does not push the chat down. */
const LIVE_STEP_WINDOW = 6;
const MONO = Platform.select({ ios: "ui-monospace", default: "monospace" });

/** A failed call shows as such; one still without a result is running while the run is live. */
function stepStatus(step: Pick<ToolStep, "outcome">, live: boolean): Status {
  if (step.outcome === "error") return "error";
  if (step.outcome === undefined && live) return "running";
  return "ok";
}

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
    live && block.steps.length > LIVE_STEP_WINDOW ? block.steps.length - LIVE_STEP_WINDOW : 0;
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
            const key = step.executionId ?? `step-${hidden + offset}`;
            const expandable = Boolean(step.executionId && runId);
            const expanded = expandable && openRows.has(key);
            return (
              <View key={key}>
                {step.note ? (
                  <Text style={[styles.note, { color: tokens.mutedForeground }]}>{step.note}</Text>
                ) : null}
                <StepRow
                  step={step}
                  status={stepStatus(step, live)}
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

/** The record for one call: the live one when the thread's events carried it, else read once. */
function useToolCallRecord(runId: string, executionId: string, threadId: string | undefined) {
  const live = useSyncExternalStore(toolCallRecords.subscribe, () =>
    toolCallRecords.get(runId),
  )?.get(executionId);
  const [fetched, setFetched] = useState<{ records?: ToolCallRecord[]; failed?: boolean }>();
  const needsFetch = live === undefined && threadId !== undefined;
  useEffect(() => {
    if (!needsFetch || !threadId) return;
    let cancelled = false;
    rpc("threads/toolCalls", { threadId, runId }).then(
      (records) => !cancelled && setFetched({ records }),
      () => !cancelled && setFetched({ failed: true }),
    );
    return () => {
      cancelled = true;
    };
  }, [needsFetch, threadId, runId]);
  const record = live ?? fetched?.records?.find((item) => item.executionId === executionId);
  return { record, loading: needsFetch && fetched === undefined, failed: fetched?.failed === true };
}

/** The call's command and what it returned, as a small terminal under its row. */
function StepPanel({
  step,
  executionId,
  runId,
  threadId,
}: {
  step: ToolStep;
  executionId: string;
  runId: string;
  threadId?: string;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const { record, loading, failed } = useToolCallRecord(runId, executionId, threadId);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const output = record?.output ?? "";
  const running = record?.status === "running";
  const exit =
    record?.exitCode === undefined || record.exitCode === null
      ? null
      : t("exit {code}", { code: record.exitCode });
  const duration = formatCompactDuration(record?.durationMs ?? step.durationMs);
  const copy = () => {
    void Clipboard.setStringAsync(output)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => undefined);
  };
  const mono = [styles.mono, { color: tokens.foreground }];
  return (
    <View
      testID="tool-step-panel"
      style={[styles.panel, { backgroundColor: tokens.background, borderColor: tokens.border }]}
    >
      {record?.command ? (
        <View style={[styles.section, styles.divider, { borderColor: tokens.border }]}>
          <Text selectable style={mono}>
            <Text style={{ color: tokens.mutedForeground }}>$ </Text>
            {record.command}
          </Text>
        </View>
      ) : null}
      {output || running ? (
        <ScrollView
          ref={scrollRef}
          nestedScrollEnabled
          style={styles.output}
          // Follow new output like a terminal.
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
        >
          <Text testID="tool-step-output" selectable style={[mono, styles.section]}>
            {output}
            {running ? "▍" : ""}
          </Text>
        </ScrollView>
      ) : record?.error ? null : (
        <Text style={[styles.section, styles.empty, { color: tokens.mutedForeground }]}>
          {loading
            ? t("Loading…")
            : failed
              ? t("Couldn't load this step.")
              : t("No output recorded.")}
        </Text>
      )}
      {record?.error || exit || duration || output ? (
        <View style={[styles.footer, { borderColor: tokens.border }]}>
          {record?.error ? (
            <Text selectable style={[styles.meta, styles.error, { color: tokens.destructive }]}>
              {record.error}
            </Text>
          ) : null}
          {exit ? (
            <Text style={[styles.meta, { color: tokens.mutedForeground }]}>{exit}</Text>
          ) : null}
          {duration ? (
            <Text style={[styles.meta, { color: tokens.mutedForeground }]}>{duration}</Text>
          ) : null}
          {output ? (
            <Pressable accessibilityRole="button" onPress={copy} hitSlop={8} style={styles.copy}>
              <Text style={[styles.meta, { color: tokens.mutedForeground }]}>
                {copied ? t("Copied") : t("Copy")}
              </Text>
            </Pressable>
          ) : null}
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
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  return Number.isFinite(started) ? formatCompactDuration(Math.max(0, now - started)) : null;
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
  panel: {
    marginVertical: 4,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  section: { paddingHorizontal: 10, paddingVertical: 6 },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth },
  mono: { ...typeScale.footnote, fontFamily: MONO },
  output: { maxHeight: 240 },
  empty: { ...typeScale.footnote },
  footer: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  meta: { ...typeScale.footnote, fontFamily: MONO },
  error: { flexShrink: 1 },
  copy: { marginStart: "auto" },
});
