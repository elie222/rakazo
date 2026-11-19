import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ClientCapabilities, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { ElicitRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { ToolAsk } from "@rakazo/adapter-kit";
import type { ToolQuestion, ToolQuestionField } from "@rakazo/contracts";
import {
  TOOL_QUESTION_DESCRIPTION_MAX,
  TOOL_QUESTION_FIELDS_MAX,
  TOOL_QUESTION_LABEL_MAX,
  TOOL_QUESTION_MESSAGE_MAX,
  TOOL_QUESTION_OPTIONS_MAX,
  TOOL_QUESTION_TEXT_MAX,
} from "@rakazo/contracts";
import { bestEffort, getLogger } from "@rakazo/logging";
import { MCP_APP_CLIENT_CAPABILITIES } from "./mcp-app.js";
import { createMcpClient } from "./mcp-output-schema.js";

/** Form mode only: a server never sends this client to a URL. */
export const MCP_ELICITATION_CAPABILITIES: ClientCapabilities = { elicitation: { form: {} } };

const DECLINE: ElicitResult = { action: "decline" };

/** Plain, bounded text: control characters dropped, whitespace runs collapsed. */
function plain(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  const text = value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").replace(/[ \t]+/g, " ");
  return text.trim().slice(0, max);
}

type FormParams = {
  mode?: unknown;
  message?: unknown;
  requestedSchema?: { properties?: unknown; required?: unknown };
};

/**
 * The form an `elicitation/create` request asks, or undefined when this client does not show
 * it: URL mode, or a field beyond flat text, number, yes/no and single choice. Undefined is
 * answered `decline` without showing anything.
 */
export function toolQuestionFromElicitation(
  source: string,
  params: FormParams,
): ToolQuestion | undefined {
  if (params.mode !== undefined && params.mode !== "form") return undefined;
  const properties = params.requestedSchema?.properties;
  if (!properties || typeof properties !== "object") return undefined;
  const entries = Object.entries(properties as Record<string, unknown>);
  if (entries.length > TOOL_QUESTION_FIELDS_MAX) return undefined;
  const required = new Set(
    Array.isArray(params.requestedSchema?.required) ? params.requestedSchema.required : [],
  );
  // A required answer the form gives no field for cannot be given.
  for (const name of required) if (!Object.hasOwn(properties, name)) return undefined;
  const fields: ToolQuestionField[] = [];
  for (const [name, schema] of entries) {
    if (name.length === 0 || name.length > 64) return undefined;
    const field = questionField(name, schema, required.has(name));
    if (!field) return undefined;
    fields.push(field);
  }
  return {
    // The integration's name reaches the bot's history: one line, whatever it was named.
    source: plain(source, 200).replace(/\s+/g, " "),
    message: plain(params.message, TOOL_QUESTION_MESSAGE_MAX),
    fields,
  };
}

function questionField(
  name: string,
  schema: unknown,
  required: boolean,
): ToolQuestionField | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const s = schema as Record<string, unknown>;
  const base = {
    name,
    label: plain(s.title, TOOL_QUESTION_LABEL_MAX) || plain(name, TOOL_QUESTION_LABEL_MAX),
    ...(plain(s.description, TOOL_QUESTION_DESCRIPTION_MAX)
      ? { description: plain(s.description, TOOL_QUESTION_DESCRIPTION_MAX) }
      : {}),
    required,
  };
  const num = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  if (s.type === "boolean")
    return {
      ...base,
      type: "boolean",
      ...(typeof s.default === "boolean" ? { default: s.default } : {}),
    };
  if (s.type === "number" || s.type === "integer") {
    const minimum = num(s.minimum);
    const maximum = num(s.maximum);
    // A range nothing fits cannot be answered.
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) return undefined;
    // Nor can a whole-number field whose range holds no whole number.
    if (
      s.type === "integer" &&
      minimum !== undefined &&
      maximum !== undefined &&
      Math.ceil(minimum) > Math.floor(maximum)
    )
      return undefined;
    const value = num(s.default);
    // A default the field itself would refuse is no default: the person starts empty.
    const fallback =
      value !== undefined &&
      (s.type !== "integer" || Number.isInteger(value)) &&
      (minimum === undefined || value >= minimum) &&
      (maximum === undefined || value <= maximum)
        ? value
        : undefined;
    return {
      ...base,
      type: "number",
      integer: s.type === "integer",
      ...(minimum !== undefined ? { minimum } : {}),
      ...(maximum !== undefined ? { maximum } : {}),
      ...(fallback !== undefined ? { default: fallback } : {}),
    };
  }
  if (s.type !== "string") return undefined;
  const options = choiceOptions(s);
  if (options === null) return undefined;
  // A default longer than this client takes is left out rather than cut short.
  const fallback =
    typeof s.default === "string" && s.default.length <= TOOL_QUESTION_TEXT_MAX
      ? s.default
      : undefined;
  if (options) {
    return {
      ...base,
      type: "choice",
      options,
      ...(fallback !== undefined && options.some((option) => option.value === fallback)
        ? { default: fallback }
        : {}),
    };
  }
  const format =
    s.format === "email" || s.format === "uri" || s.format === "date" || s.format === "date-time"
      ? s.format
      : undefined;
  const maxLength = Math.min(num(s.maxLength) ?? TOOL_QUESTION_TEXT_MAX, TOOL_QUESTION_TEXT_MAX);
  const minLength = num(s.minLength);
  // A form whose shortest answer is longer than this client takes cannot be answered here.
  if (maxLength < 1 || (minLength !== undefined && minLength > maxLength)) return undefined;
  return {
    ...base,
    type: "text",
    ...(format ? { format } : {}),
    ...(minLength !== undefined && minLength >= 0 ? { minLength: Math.floor(minLength) } : {}),
    maxLength: Math.floor(maxLength),
    ...(fallback !== undefined &&
    fallback.length <= maxLength &&
    (minLength === undefined || fallback.length >= minLength)
      ? { default: fallback }
      : {}),
  };
}

/** A single-choice field's options; undefined for free text, null for one this client skips. */
function choiceOptions(
  s: Record<string, unknown>,
): { value: string; label: string }[] | undefined | null {
  let options: { value: unknown; label: unknown }[] | undefined;
  if (Array.isArray(s.oneOf)) {
    options = s.oneOf.map((option) => ({
      value: (option as { const?: unknown })?.const,
      label: (option as { title?: unknown })?.title,
    }));
  } else if (Array.isArray(s.enum)) {
    const names = Array.isArray(s.enumNames) ? s.enumNames : [];
    options = s.enum.map((value, index) => ({ value, label: names[index] ?? value }));
  }
  if (!options) return undefined;
  if (options.length === 0 || options.length > TOOL_QUESTION_OPTIONS_MAX) return null;
  const out: { value: string; label: string }[] = [];
  for (const option of options) {
    if (typeof option.value !== "string" || option.value.length > TOOL_QUESTION_TEXT_MAX)
      return null;
    out.push({
      value: option.value,
      label:
        plain(option.label, TOOL_QUESTION_LABEL_MAX) ||
        plain(option.value, TOOL_QUESTION_LABEL_MAX),
    });
  }
  return out;
}

/**
 * How much answering time a call may spend beyond its own total, in all: one full question (see
 * TOOL_QUESTION_WAIT_MS) and part of another. Past it the call ends however often the server
 * asks again.
 */
export const MCP_ANSWER_ALLOWANCE_MS = 15 * 60_000;

/**
 * How long a tool call may go without an answer, a progress report, and how long in all,
 * leaving out the time the person spends answering the server's questions, and a wall-clock
 * ceiling nothing pauses, so a server that keeps asking still ends. Fires `onTimeout` once; the
 * call aborts on it.
 */
export class McpCallClock {
  private idle?: ReturnType<typeof setTimeout>;
  private total?: ReturnType<typeof setTimeout>;
  private readonly ceiling: ReturnType<typeof setTimeout>;
  private totalLeft: number;
  private totalStartedAt = 0;
  private asking = 0;
  private done = false;
  private readonly totalMs: number;

  constructor(
    private readonly idleMs: number,
    totalMs: number,
    /** Hears which limit ran out: the idle wait, the total or the wall-clock ceiling. */
    private readonly onTimeout: (
      limit: { [key in "timeout" | "maxTotalTimeout" | "ceiling"]?: number },
    ) => void,
    ceilingMs = totalMs + MCP_ANSWER_ALLOWANCE_MS,
  ) {
    this.totalLeft = totalMs;
    this.totalMs = totalMs;
    this.ceiling = setTimeout(() => this.fire({ ceiling: ceilingMs }), ceilingMs);
    this.run();
  }

  /** Progress from the server restarts the idle wait. */
  progress(): void {
    if (this.done || this.asking > 0) return;
    this.startIdle();
  }

  /** Stops both waits until the returned function is called, when they start again. */
  pause(): () => void {
    if (this.done) return () => undefined;
    this.asking += 1;
    if (this.asking === 1) this.stop();
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      this.asking -= 1;
      if (this.asking === 0 && !this.done) this.run();
    };
  }

  end(): void {
    this.done = true;
    clearTimeout(this.ceiling);
    this.stop();
  }

  private run(): void {
    this.totalStartedAt = Date.now();
    this.total = setTimeout(
      () => this.fire({ maxTotalTimeout: this.totalMs }),
      Math.max(0, this.totalLeft),
    );
    this.startIdle();
  }

  private startIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.fire({ timeout: this.idleMs }), this.idleMs);
  }

  private stop(): void {
    if (this.idle) clearTimeout(this.idle);
    if (this.total) {
      clearTimeout(this.total);
      this.totalLeft -= Date.now() - this.totalStartedAt;
    }
    this.idle = undefined;
    this.total = undefined;
  }

  private fire(limit: Parameters<McpCallClock["onTimeout"]>[0]): void {
    if (this.done) return;
    this.end();
    this.onTimeout(limit);
  }
}

/** The error a call ends with when its clock runs out, naming the limit as the SDK's own does. */
export function mcpCallTimeoutError(limit: Record<string, number | undefined>): McpError {
  return new McpError(ErrorCode.RequestTimeout, "Request timed out", limit);
}

type InFlightCall = {
  owner: string;
  source: string;
  ask?: ToolAsk;
  clock?: McpCallClock;
  /** Ends when the call does: its question closes with it. */
  signal?: AbortSignal;
};

/**
 * Routes a server's `elicitation/create` to the tool call it belongs to. The protocol does not
 * say which request a server's question is about, so it goes to the calls in flight on this
 * client when they all belong to one run; with none, or calls from several runs, it is
 * declined rather than shown to someone it may not concern.
 */
export class McpElicitationRouter {
  private readonly calls = new Set<InFlightCall>();
  /** Owners with a question open: a second one while the first waits is declined. */
  private readonly asking = new Set<string>();

  install(client: Client): void {
    client.setRequestHandler(ElicitRequestSchema, (request, extra) =>
      this.answer(request.params as FormParams, extra.signal),
    );
  }

  /** Registers a call for the time it is in flight; the returned function ends it. */
  track(call: InFlightCall): () => void {
    this.calls.add(call);
    return () => {
      this.calls.delete(call);
    };
  }

  private async answer(params: FormParams, signal: AbortSignal): Promise<ElicitResult> {
    const calls = [...this.calls];
    const owners = new Set(calls.map((call) => call.owner));
    const asker = calls.find((call) => call.ask);
    // Each automatic decline says why, so a gateway's failed approval can be traced to its rule.
    const decline = (reason: string) => {
      getLogger().info("mcp.elicitation.declined", { reason, owner: asker?.owner ?? "" });
      return DECLINE;
    };
    if (owners.size > 1) return decline("calls_from_several_runs");
    if (!asker?.ask) return decline("nobody_to_ask");
    const ask = asker.ask;
    const question = toolQuestionFromElicitation(asker.source, params);
    if (!question) return decline("unsupported_form");
    if (this.asking.has(asker.owner)) return decline("question_already_open");
    this.asking.add(asker.owner);
    const resumes = calls.map((call) => call.clock?.pause() ?? (() => undefined));
    // Which of the run's calls asked is unknown, so the question closes once none of them runs.
    const callsEnded = whenAllEnd(calls.flatMap((call) => (call.signal ? [call.signal] : [])));
    try {
      // A failed ask is a question nobody answered: the server hears a cancel and decides
      // what its call does next.
      const answer = (await bestEffort(
        "mcp.elicitation",
        ask(question, AbortSignal.any([signal, callsEnded.signal])),
      )) ?? {
        action: "cancel",
      };
      if (answer.action === "accept") return { action: "accept", content: answer.values };
      return { action: answer.action };
    } finally {
      callsEnded.stop();
      this.asking.delete(asker.owner);
      for (const resume of resumes) resume();
    }
  }
}

/** Who a call may ask: the run it belongs to, the integration's name, and how to reach them. */
export interface McpCallAsker {
  owner: string;
  source: string;
  ask?: ToolAsk;
}

/** Longest wait the SDK's own timer takes; past it a timer fires at once. The call's clock and
 * signal end it long before. */
const NO_SDK_TIMEOUT_MS = 2_147_483_647;

/**
 * `tools/call` timed by an `McpCallClock` instead of the SDK's timer, so the minutes a person
 * spends answering the server's questions never count against the call. Questions the server
 * asks while it runs go to `asker`.
 */
export async function callMcpToolAsking(
  client: Client,
  router: McpElicitationRouter,
  name: string,
  args: Record<string, unknown>,
  options: { signal?: AbortSignal; idleMs: number; totalMs: number; asker?: McpCallAsker },
) {
  const timedOut = new AbortController();
  const clock = new McpCallClock(options.idleMs, options.totalMs, (limit) =>
    timedOut.abort(mcpCallTimeoutError(limit)),
  );
  const signal = options.signal
    ? AbortSignal.any([options.signal, timedOut.signal])
    : timedOut.signal;
  // Ends however the call does (a result, an error, a timeout), closing any question it left open.
  const ended = new AbortController();
  const untrack = router.track({
    owner: options.asker?.owner ?? "",
    source: options.asker?.source ?? "",
    ask: options.asker?.ask,
    clock,
    signal: AbortSignal.any([signal, ended.signal]),
  });
  try {
    return await client.callTool({ name, arguments: args }, undefined, {
      signal,
      timeout: NO_SDK_TIMEOUT_MS,
      // A progress handler is what asks the server for progress reports at all.
      onprogress: () => clock.progress(),
    });
  } finally {
    clock.end();
    ended.abort();
    untrack();
  }
}

/** What this client tells every server it can do: show apps, and when asked for, take questions. */
export function mcpClientCapabilities(elicitation: boolean): ClientCapabilities {
  return { ...MCP_APP_CLIENT_CAPABILITIES, ...(elicitation ? MCP_ELICITATION_CAPABILITIES : {}) };
}

/** A client for a remote server: it shows apps, and with a router it may be asked questions. */
export function newRemoteMcpClient(router?: McpElicitationRouter): Client {
  const client = createMcpClient(
    { name: "rakazo", version: "0.1.0" },
    { capabilities: mcpClientCapabilities(router !== undefined) },
  );
  router?.install(client);
  return client;
}

/** Aborts once every one of `signals` has; never, when there are none. `stop` drops its
 * listeners once the question is over. */
function whenAllEnd(signals: readonly AbortSignal[]): { signal: AbortSignal; stop: () => void } {
  const ended = new AbortController();
  const check = () => {
    if (signals.every((signal) => signal.aborted)) ended.abort();
  };
  for (const signal of signals) signal.addEventListener("abort", check, { once: true });
  if (signals.length > 0) check();
  return {
    signal: ended.signal,
    stop: () => {
      for (const signal of signals) signal.removeEventListener("abort", check);
    },
  };
}
