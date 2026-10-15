import type { AgentRunRequest, SandboxProcessRequest } from "@rakazo/adapter-kit";
import { codexProviderFailure, nativeProviderError } from "./primary-harness-errors.js";
import { prepareNativeMedia } from "./primary-harness-media.js";
import type { NativeProtocolChannel, NativeProtocolContext } from "./primary-harness-protocol.js";
import { nativeObject, nativeString } from "./primary-harness-protocol.js";

/** All native environment tools are suppressed, including apply_patch and view_image. */
export const CODEX_RESTRICTED_CONFIG = {
  "analytics.enabled": false,
  "features.shell_tool": false,
  "features.image_generation": false,
  "features.artifact": false,
  "features.view_image": false,
  "features.codex_hooks": false,
  "features.memory_tool": false,
  "features.remote_plugin": false,
  "features.skill_mcp_dependency_install": false,
  "features.stable_environment_tools": false,
  "features.multi_agent": false,
  "features.multi_agent_v2": false,
  "features.apps": false,
  "features.plugins": false,
  "features.recommended_plugins": false,
  "features.code_mode": false,
  "features.browser_use": false,
  "features.computer_use": false,
  "features.standalone_web_search": false,
  "features.request_permissions_tool": false,
  "features.deferred_executor": false,
  "features.goals": false,
  "features.current_time_reminder": false,
  "features.sleep_tool": false,
  "features.token_budget": false,
  "features.send_message_to_user_async": false,
  web_search: "disabled",
  project_doc_max_bytes: 0,
  "tools.experimental_request_user_input.enabled": false,
  "tools.update_plan.enabled": false,
  model_provider: "rakazo",
  approval_policy: "on-request",
  sandbox_mode: "read-only",
  sqlite_home: "/sessions/codex-state",
} as const;

export const CODEX_SANDBOX_RUNNER = String.raw`
import {readFileSync,writeFileSync,mkdirSync,symlinkSync,lstatSync,realpathSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
const root='/opt/rakazo-harness/node_modules/@openai/codex';
if(JSON.parse(readFileSync(root+'/package.json','utf8')).version!=='0.162.1')throw new Error('Unsupported Codex version');
const cli=root+'/bin/codex.js';
const check=spawnSync(process.execPath,[cli,'--version'],{encoding:'utf8',timeout:10000,maxBuffer:8192});
if(check.status!==0||check.stdout.trim()!=='codex-cli 0.162.1')throw new Error('Unsupported Codex binary version');
process.env.CODEX_HOME='/home/harness/.codex';
mkdirSync(process.env.CODEX_HOME,{recursive:true,mode:0o700});
for(const name of ['codex-sessions','codex-state'])mkdirSync('/sessions/'+name,{recursive:true,mode:0o700});
symlinkSync('/sessions/codex-sessions',process.env.CODEX_HOME+'/sessions');
let buffer=Buffer.alloc(0);
function first(data){
 buffer=Buffer.concat([buffer,data]);if(buffer.length>1048576)process.exit(1);
 const end=buffer.indexOf(10);if(end<0)return;
 process.stdin.off('data',first);process.stdin.pause();
 let frame;try{frame=JSON.parse(buffer.subarray(0,end).toString());}catch{process.exit(1);}
 if(frame.method!=='rakazo/start'||!frame.params||typeof frame.params.endpoint!=='string')process.exit(1);
 if(frame.params.nativeLogin){if(realpathSync('/credentials/codex')!=='/credentials/codex'||!lstatSync('/credentials/codex/auth.json').isFile())throw new Error('Native login required');symlinkSync('/credentials/codex/auth.json',process.env.CODEX_HOME+'/auth.json');}
 const config={...frame.params.config,...(frame.params.nativeLogin?{}:{
  'model_providers.rakazo.name':'Rakazo account',
  'model_providers.rakazo.base_url':frame.params.endpoint,
  'model_providers.rakazo.env_key':'OPENAI_API_KEY',
  'model_providers.rakazo.wire_api':'responses',
  'model_providers.rakazo.requires_openai_auth':false,
 })};
 if(frame.params.audioModel){
  const model=frame.params.audioModel;if(typeof model.slug!=='string'||!Array.isArray(model.input_modalities)||!model.input_modalities.includes('audio'))process.exit(1);
  const catalog=process.env.CODEX_HOME+'/rakazo-models.json';
  writeFileSync(catalog,JSON.stringify({models:[model]}),{mode:0o600,flag:'wx'});
  config.model_catalog_json=catalog;
 }
 const args=[cli,'app-server','--listen','stdio://'];
 for(const [key,value]of Object.entries(config))args.push('-c',key+'='+JSON.stringify(value));
 const child=spawn(process.execPath,args,{stdio:['pipe','pipe','pipe'],env:process.env});
 child.on('error',()=>process.exit(1));
 // The native engine echoes inline media in user/tool lifecycle notifications.
 // Those are not assistant output and are never forwarded across the host boundary.
 // Keep both this private parser and forwarded diagnostic frames independently bounded.
 let output='';
 child.stdout.setEncoding('utf8');
 child.stdout.on('data',(data)=>{
  output+=data;
  for(let end;(end=output.indexOf('\n'))>=0;){
   const line=output.slice(0,end);output=output.slice(end+1);
   if(Buffer.byteLength(line)>16777216)process.exit(1);
   let event;try{event=JSON.parse(line);}catch{process.exit(1);}
   if(typeof event.method==='string'&&(event.method.startsWith('codex/event/')||
     (event.method==='item/completed'&&['userMessage','dynamicToolCall'].includes(event.params?.item?.type))))continue;
   if(Buffer.byteLength(line)>1048576)process.exit(1);
   if(!process.stdout.write(line+'\n')){child.stdout.pause();process.stdout.once('drain',()=>child.stdout.resume());}
  }
  if(Buffer.byteLength(output)>16777216)process.exit(1);
 });
 child.stdout.on('end',()=>{if(output.length)process.exit(1);});
 child.stderr.pipe(process.stderr);
 process.stdin.pipe(child.stdin);if(buffer.length>end+1)child.stdin.write(buffer.subarray(end+1));
 process.stdout.write(JSON.stringify({id:frame.id,result:{version:'0.162.1'}})+'\n');
 child.on('exit',(code)=>{process.exit(code??1);});
}
process.stdin.on('data',first);
`;

export function buildCodexProcess(request: AgentRunRequest): SandboxProcessRequest {
  return {
    isolation: "primary-harness",
    argv: ["node", "--input-type=module", "--eval", CODEX_SANDBOX_RUNNER],
    env: request.model.nativeLogin ? {} : { OPENAI_API_KEY: request.model.apiKey ?? "" },
  };
}

export async function runCodexProtocol(
  channel: NativeProtocolChannel,
  context: NativeProtocolContext,
): Promise<void> {
  const media = await prepareNativeMedia(context.request, "codex");
  const nativeLogin = Boolean(context.request.model.nativeLogin);
  const config = {
    ...CODEX_RESTRICTED_CONFIG,
    ...(nativeLogin
      ? {
          model_provider: "openai",
          cli_auth_credentials_store: "file",
          forced_login_method: "chatgpt",
        }
      : {}),
  };
  const bootstrap = await channel.request("rakazo/start", {
    endpoint: context.request.model.baseUrl,
    config,
    nativeLogin,
    // The native default catalog omits audio for unknown slugs. An explicit profile
    // declaration must reach the engine's catalog or it silently replaces audio with text.
    ...(context.request.model.acceptsAudio
      ? {
          audioModel: {
            slug: context.request.model.id,
            display_name: context.request.model.id,
            base_instructions: "Use only the authorized Rakazo tool namespace.",
            supported_reasoning_levels: [],
            shell_type: "disabled",
            visibility: "none",
            supported_in_api: true,
            priority: 0,
            support_verbosity: false,
            include_apps_usage_instructions: false,
            supports_reasoning_summary_parameter: false,
            node_repl_disabled: true,
            truncation_policy: { mode: "bytes", limit: 10000 },
            experimental_supported_tools: [],
            input_modalities: [
              "text",
              ...(context.request.model.acceptsImages ? ["image"] : []),
              "audio",
            ],
          },
        }
      : {}),
  });
  if (bootstrap.version !== "0.162.1") throw new Error("Unsupported Codex runtime version.");
  await channel.request("initialize", {
    clientInfo: { name: "rakazo", title: "Rakazo", version: "1.0.0" },
    capabilities: {
      experimentalApi: true,
      optOutNotificationMethods: ["item/started", "codex/event/user_message"],
    },
  });
  await channel.send({ method: "initialized" });
  if (nativeLogin) {
    const account = await channel.request("account/read", { refreshToken: false });
    if (nativeObject(account.account).type !== "chatgpt")
      throw new Error("Native ChatGPT account is disconnected. Sign in again.");
  }
  const tools = context.tools.length
    ? [
        {
          type: "namespace",
          name: "rakazo",
          description:
            "Authorized Rakazo tools. Use these for all computer and integration actions.",
          tools: context.tools.map(({ name, description, inputSchema }) => ({
            type: "function",
            name,
            description,
            inputSchema,
          })),
        },
      ]
    : [];
  const parameters = {
    model: context.request.model.id,
    modelProvider: nativeLogin ? "openai" : "rakazo",
    baseInstructions: context.request.instructions,
    developerInstructions:
      "Use only the rakazo tool namespace. Native tools and environments are disabled.",
    approvalPolicy: "on-request",
    sandbox: "read-only",
    environments: [],
    config,
    ...(context.nativeSessionId
      ? { threadId: context.nativeSessionId, excludeTurns: true }
      : { dynamicTools: tools, ephemeral: false }),
  };
  const thread = await channel.request(
    context.nativeSessionId ? "thread/resume" : "thread/start",
    parameters,
  );
  const threadId = nativeString(nativeObject(thread.thread).id);
  if (context.nativeSessionId && threadId !== context.nativeSessionId) {
    throw new Error("Codex resumed a different native session.");
  }
  await context.onSession(threadId);
  const turn = await channel.request("turn/start", {
    threadId,
    input: [
      { type: "text", text: context.prompt, textElements: [] },
      ...media.flatMap((part) => [
        { type: "text", text: part.label, textElements: [] },
        { type: part.kind, url: `data:${part.mimeType};base64,${part.data}` },
      ]),
    ],
    environments: [],
    ...(context.request.model.thinkingLevel && context.request.model.thinkingLevel !== "off"
      ? { effort: context.request.model.thinkingLevel }
      : {}),
  });
  const turnId = nativeString(nativeObject(turn.turn).id);
  context.setInterrupt(() =>
    channel.send({
      id: "rakazo:interrupt",
      method: "turn/interrupt",
      params: { threadId, turnId },
    }),
  );
  let usage: Record<string, unknown> | undefined = context.usageState?.codex
    ? nativeObject(context.usageState.codex)
    : undefined;
  let usageCount = 0;
  let streamed = false;
  const finalText: string[] = [];
  for await (const message of channel.messages) {
    context.signal.throwIfAborted();
    if (typeof message.method !== "string") continue;
    const p = nativeObject(message.params ?? {});
    if (p.threadId !== undefined && p.threadId !== threadId)
      throw new Error("Codex thread identity mismatch.");
    if (p.turnId !== undefined && p.turnId !== turnId) {
      // Resume replays the preceding turn's cumulative usage before the new turn starts.
      // It is not new billable usage; only accept the exact already-persisted baseline.
      if (
        context.nativeSessionId &&
        message.id === undefined &&
        message.method === "thread/tokenUsage/updated" &&
        usage &&
        JSON.stringify(nativeObject(p.tokenUsage).total) === JSON.stringify(usage)
      )
        continue;
      throw new Error("Codex turn identity mismatch.");
    }
    if (message.method === "error") {
      const failure = codexProviderFailure(p.error);
      if (failure) throw nativeProviderError("Codex", failure);
    } else if (message.method === "item/tool/call") {
      if (p.namespace !== "rakazo")
        throw new Error("Codex requested a tool outside the authorized bridge.");
      const result = await context.callTool(
        nativeString(p.tool),
        nativeObject(p.arguments),
        nativeString(p.callId),
      );
      await channel.send({
        id: message.id,
        result: {
          contentItems: result.content?.map((part) =>
            part.type === "image"
              ? { type: "inputImage", imageUrl: `data:${part.mimeType};base64,${part.data}` }
              : { type: "inputText", text: part.text },
          ) ?? [{ type: "inputText", text: result.text }],
          success: !result.isError,
        },
      });
    } else if (message.method === "item/agentMessage/delta") {
      if (typeof p.delta !== "string") throw new Error("Invalid Codex text delta.");
      streamed = true;
      context.emit({ type: "text", text: p.delta });
    } else if (message.method === "item/completed") {
      const item = nativeObject(p.item);
      if (item.type === "agentMessage" && typeof item.text === "string") finalText.push(item.text);
      // These must not be reachable with environments: [] and the pinned feature policy.
      if (
        ["commandExecution", "fileChange", "mcpToolCall", "webSearch", "computerUse"].includes(
          String(item.type),
        )
      ) {
        throw new Error("Codex attempted an action outside the authorized tool bridge.");
      }
    } else if (message.method === "thread/tokenUsage/updated") {
      const next = nativeObject(nativeObject(p.tokenUsage).total);
      if (JSON.stringify(next) === JSON.stringify(usage)) continue;
      const delta = (key: string): number | null => {
        const current = count(next[key]);
        const previous = usage ? count(usage[key]) : context.nativeSessionId ? null : 0;
        return current === null || previous === null || current < previous
          ? null
          : current - previous;
      };
      const input = delta("inputTokens");
      const cached = delta("cachedInputTokens");
      context.emit({
        type: "usage",
        provider: context.request.model.provider,
        model: context.request.model.id,
        inputTokens: input === null ? null : Math.max(0, input - (cached ?? 0)),
        outputTokens: delta("outputTokens"),
        cacheReadTokens: cached,
        cacheWriteTokens: delta("cacheWriteInputTokens"),
        reasoningTokens: delta("reasoningOutputTokens"),
        totalTokens: delta("totalTokens"),
        costUsd: null,
        usageSource: "codex-app-server",
        callId: `${context.request.runId}:${turnId}:usage:${usageCount++}`,
      });
      usage = next;
      context.onUsageState?.({ codex: next });
    } else if (message.method === "turn/completed") {
      const completed = nativeObject(p.turn);
      if (completed.id !== turnId || completed.status !== "completed" || completed.error) {
        const failure = codexProviderFailure(completed.error);
        throw failure
          ? nativeProviderError("Codex", failure)
          : new Error("Codex did not complete the turn successfully.");
      }
      if (!streamed && finalText.length) context.emit({ type: "text", text: finalText.join("\n") });
      if (usageCount === 0)
        context.emit({
          type: "usage",
          provider: context.request.model.provider,
          model: context.request.model.id,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          usageSource: "codex-app-server",
          callId: `${context.request.runId}:${turnId}`,
        });
      return;
    } else if (message.id !== undefined) {
      // Never translate native approvals into automatic approval. Host tools own policy.
      if (
        message.method === "item/commandExecution/requestApproval" ||
        message.method === "item/fileChange/requestApproval"
      ) {
        await channel.send({ id: message.id, result: { decision: "decline" } });
      } else {
        await channel.send({ id: message.id, error: { code: -32601, message: "Request denied." } });
      }
      throw new Error("Codex requested an unsupported operation.");
    }
  }
  throw new Error("Codex ended without an explicit terminal result.");
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
