import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";

export type ObservedToolCall = { runId: string; name: string; args: Record<string, unknown> };
/** What the model was offered on a run's first call: tool count and serialized definition size. */
export type ObservedToolList = { runId: string; count: number; bytes: number };

export function toolListSize(tools: AgentRunRequest["tools"]): Omit<ObservedToolList, "runId"> {
  const definitions = tools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
  return { count: tools.length, bytes: Buffer.byteLength(JSON.stringify(definitions)) };
}

/** Records every tool call the model makes, including ones the runtime answers itself (ask_user). */
export function observeToolCalls(
  runtime: AgentRuntime,
  calls: ObservedToolCall[],
  lists: ObservedToolList[],
): AgentRuntime {
  return {
    describe: () => runtime.describe(),
    abort: (id) => runtime.abort(id),
    async *run(request, context) {
      if (!lists.some((list) => list.runId === request.runId))
        lists.push({ runId: request.runId, ...toolListSize(request.tools) });
      for await (const event of runtime.run(request, context)) {
        if (event.type === "tool")
          calls.push({ runId: request.runId, name: event.name, args: structuredClone(event.args) });
        yield event;
      }
    },
  };
}
