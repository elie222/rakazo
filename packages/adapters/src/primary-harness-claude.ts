import type { AgentRunRequest, SandboxProcessRequest } from "@rakazo/adapter-kit";
import {
  claudeProviderFailure,
  nativeHttpFailure,
  nativeProviderError,
} from "./primary-harness-errors.js";
import { prepareNativeMedia } from "./primary-harness-media.js";
import type { NativeProtocolChannel, NativeProtocolContext } from "./primary-harness-protocol.js";
import { nativeObject, nativeString } from "./primary-harness-protocol.js";

/**
 * Executes only inside the isolated harness container. SDK 0.3.300 / CLI 2.1.300.
 * Official SDK tools: [] disables built-ins; strictMcpConfig and settingSources: []
 * exclude workspace/user MCP, hooks and settings. The only MCP server is in-process.
 */
export const CLAUDE_SANDBOX_RUNNER = String.raw`
import {readFileSync, mkdirSync, symlinkSync, constants} from 'node:fs';
import {open,realpath} from 'node:fs/promises';
import {basename,sep} from 'node:path';
import {createInterface} from 'node:readline';
import {query, createSdkMcpServer, tool} from '/opt/rakazo-harness/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import {z} from '/opt/rakazo-harness/node_modules/zod/index.js';
const version=JSON.parse(readFileSync('/opt/rakazo-harness/node_modules/@anthropic-ai/claude-agent-sdk/package.json','utf8')).version;
if(version!=='0.3.300') throw new Error('Unsupported Claude SDK version');
process.env.CLAUDE_CONFIG_DIR='/home/harness/.claude';
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1';
process.env.DISABLE_TELEMETRY='1';
process.env.DISABLE_ERROR_REPORTING='1';
mkdirSync(process.env.CLAUDE_CONFIG_DIR,{recursive:true,mode:0o700});
mkdirSync('/sessions/claude-projects',{recursive:true,mode:0o700});
symlinkSync('/sessions/claude-projects','/home/harness/.claude/projects');
const pending=new Map(); let started=false, session, seq=0;
const send=(message)=>{const line=JSON.stringify(message)+'\n';if(Buffer.byteLength(line)>1048576)throw new Error('Protocol frame limit');process.stdout.write(line);};
const input=createInterface({input:process.stdin,crlfDelay:Infinity});
input.on('line',(line)=>{
  if(Buffer.byteLength(line)>16777216)process.exit(1);
  let message;try{message=JSON.parse(line);}catch{process.exit(1);}
  if(message.method==='rakazo/start'&&!started){started=true;void start(message).catch(()=>{send({method:'rakazo/failure',params:{}});process.exitCode=1;input.close();});return;}
  if(message.method==='rakazo/interrupt'){void session?.interrupt().catch(()=>{});return;}
  const waiting=pending.get(message.id);
  if(waiting&&!message.method){pending.delete(message.id);message.error?waiting.reject(new Error('Host tool denied')):waiting.resolve(message.result);return;}
  send({id:message.id??null,error:{code:-32601,message:'Unsupported request'}});process.exit(1);
});
async function awaitJournal(input){
 if(typeof input.session_id!=='string'||typeof input.tool_use_id!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(input.session_id)||!/^[A-Za-z0-9_-]{1,200}$/.test(input.tool_use_id)||typeof input.transcript_path!=='string')throw new Error('Invalid native journal identity');
 const root=await realpath('/sessions/claude-projects');
 if(root!=='/sessions/claude-projects')throw new Error('Native journal root mismatch');
 const deadline=Date.now()+10000;
 while(Date.now()<deadline){
  let file;
  try{
   const path=await realpath(input.transcript_path);
   if(!path.startsWith(root+sep)||basename(path)!==input.session_id+'.jsonl')throw new Error('Native journal scope mismatch');
   file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
   const opened=await realpath('/proc/self/fd/'+file.fd);
   if(!opened.startsWith(root+sep)||basename(opened)!==input.session_id+'.jsonl')throw new Error('Native journal scope mismatch');
   const stat=await file.stat();if(!stat.isFile())throw new Error('Invalid native journal');
   const start=Math.max(0,stat.size-2097152), bytes=Buffer.alloc(Math.min(stat.size,2097152));
   const read=await file.read(bytes,0,bytes.length,start);
   let tail=bytes.subarray(0,read.bytesRead).toString('utf8');
   if(start>0)tail=tail.slice(tail.indexOf('\n')+1);
   const needle=JSON.stringify(input.tool_use_id);
   for(const line of tail.split('\n')){
    if(!line.includes(needle))continue;
    let entry;try{entry=JSON.parse(line);}catch{continue;}
    if(entry.sessionId===input.session_id&&entry.type==='assistant'&&entry.message?.content?.some(part=>part.type==='tool_use'&&part.id===input.tool_use_id))return;
   }
  }catch(error){if(error.code!=='ENOENT')throw error;}
  finally{await file?.close();}
  await new Promise(resolve=>setTimeout(resolve,50));
 }
 throw new Error('Native journal did not acknowledge the tool request');
}
async function start(message){
  const p=message.params;
  if(!p||!Array.isArray(p.tools)||typeof p.prompt!=='string'||typeof p.instructions!=='string'||typeof p.modelId!=='string')throw new Error('Invalid startup');
  const names=new Set(p.tools.map(t=>'mcp__rakazo__'+t.name));
  const bridge=createSdkMcpServer({name:'rakazo',version:'1.0.0',alwaysLoad:true,tools:p.tools.map(t=>{
    const schema=z.fromJSONSchema(t.inputSchema);
    if(!schema.shape)throw new Error('Tool schema must be an object');
    return tool(t.name,t.description,schema.shape,async(args)=>{
      const id='claude-tool-'+(++seq);
      const result=await new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});send({id,method:'rakazo/tool',params:{name:t.name,args,callId:id}});});
      return {content:result.content??[{type:'text',text:result.text}],isError:result.isError};
    });
  })});
  const options={model:p.modelId,systemPrompt:p.instructions,tools:[],allowedTools:[...names],
    settingSources:[],strictMcpConfig:true,skills:[],plugins:[],agents:{},mcpServers:{rakazo:bridge},
    permissionMode:'default',includePartialMessages:true,maxTurns:100,
    canUseTool:async(name,args)=>names.has(name)?{behavior:'allow',updatedInput:args}:{behavior:'deny',message:'Use the authorized Rakazo tool bridge.'},
    hooks:{PreToolUse:[{hooks:[async(input)=>{if(!names.has(input.tool_name))return {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'Native tools are disabled.'}};try{await awaitJournal(input);return {};}catch{send({method:'rakazo/failure',params:{}});process.exit(1);}}]}]},
    env:{...process.env},stderr:()=>{},
    ...(p.nativeSessionId?{resume:p.nativeSessionId}:{}),
  };
  async function* userMessages(){
    const content=[{type:'text',text:'Rakazo conversation input:\n'+p.prompt}];
    for(const part of p.media??[]){
      if(part.kind!=='image'||typeof part.label!=='string'||typeof part.data!=='string'||!['image/png','image/jpeg','image/webp','image/gif'].includes(part.mimeType))throw new Error('Invalid image input');
      content.push({type:'text',text:part.label},{type:'image',source:{type:'base64',media_type:part.mimeType,data:part.data}});
    }
    yield {type:'user',message:{role:'user',content},parent_tool_use_id:null};
  }
  session=query({prompt:p.media?.length?userMessages():'Rakazo conversation input:\n'+p.prompt,options});
  send({id:message.id,result:{version}});
  for await(const event of session){
    if(event.type==='system'&&event.subtype==='init')send({method:'rakazo/session',params:{id:event.session_id}});
    else if(event.type==='system'&&event.subtype==='api_retry')send({method:'rakazo/provider-failure',params:{code:event.error,status:event.error_status}});
    else if(event.type==='stream_event')send({method:'rakazo/sdk',params:event});
    else if(event.type==='result')send({method:'rakazo/sdk',params:event});
    else if(event.type==='assistant')send({method:'rakazo/assistant',params:event});
  }
  input.close();
}
`;

const CLAUDE_MODEL_ROLE_ENV = {
  haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  fable: "ANTHROPIC_DEFAULT_FABLE_MODEL",
  subagent: "CLAUDE_CODE_SUBAGENT_MODEL",
} as const;

export function buildClaudeProcess(request: AgentRunRequest): SandboxProcessRequest {
  const scheme = request.model.authScheme ?? "api-key";
  if (scheme !== "api-key" && scheme !== "bearer")
    throw new Error("Unsupported Anthropic authentication scheme.");
  const roles: Record<string, string> = {};
  for (const [role, model] of Object.entries(request.model.modelRoles ?? {})) {
    if (
      !Object.hasOwn(CLAUDE_MODEL_ROLE_ENV, role) ||
      typeof model !== "string" ||
      !model.length ||
      model.length > 200 ||
      model.trim() !== model ||
      Array.from(model).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      throw new Error("Invalid Claude model role mapping.");
    roles[CLAUDE_MODEL_ROLE_ENV[role as keyof typeof CLAUDE_MODEL_ROLE_ENV]] = model;
  }
  return {
    isolation: "primary-harness",
    argv: ["node", "--input-type=module", "--eval", CLAUDE_SANDBOX_RUNNER],
    env: {
      [scheme === "bearer" ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY"]:
        request.model.apiKey ?? "",
      ANTHROPIC_BASE_URL: request.model.baseUrl ?? "",
      ...roles,
    },
  };
}

export async function runClaudeProtocol(
  channel: NativeProtocolChannel,
  context: NativeProtocolContext,
): Promise<void> {
  const ready = await channel.request("rakazo/start", {
    instructions: context.request.instructions,
    prompt: context.prompt,
    media: await prepareNativeMedia(context.request, "claude"),
    modelId: context.request.model.id,
    tools: context.tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
    nativeSessionId: context.nativeSessionId,
  });
  if (ready.version !== "0.3.300") throw new Error("Unsupported Claude SDK version.");
  context.setInterrupt(() => channel.send({ method: "rakazo/interrupt" }));
  let streamed = false;
  const assistantText: string[] = [];
  const seenUsage = new Set<string>();
  let step:
    | { id: string; model: string; usage: Record<string, unknown>; completeOutput: boolean }
    | undefined;
  for await (const message of channel.messages) {
    context.signal.throwIfAborted();
    if (message.method === "rakazo/tool") {
      const p = nativeObject(message.params);
      const result = await context.callTool(
        nativeString(p.name),
        nativeObject(p.args),
        nativeString(p.callId),
      );
      await channel.send({ id: message.id, result });
    } else if (message.method === "rakazo/session") {
      await context.onSession(nativeString(nativeObject(message.params).id));
    } else if (message.method === "rakazo/assistant") {
      const assistant = nativeObject(message.params);
      if (assistant.error) {
        const failure = claudeProviderFailure(assistant.error);
        throw failure
          ? nativeProviderError("Claude Agent", failure)
          : new Error("Claude Agent provider request failed.");
      }
      const messageBody = nativeObject(assistant.message);
      if (Array.isArray(messageBody.content)) {
        for (const part of messageBody.content) {
          const item = nativeObject(part);
          if (item.type === "text" && typeof item.text === "string") assistantText.push(item.text);
        }
      }
    } else if (message.method === "rakazo/sdk") {
      const event = nativeObject(message.params);
      if (event.type === "stream_event") {
        const part = nativeObject(event.event);
        if (part.type === "message_start") {
          const message = nativeObject(part.message);
          step = {
            id: nativeString(message.id),
            model: nativeString(message.model),
            usage: nativeObject(message.usage ?? {}),
            completeOutput: false,
          };
        } else if (part.type === "message_delta" && step && part.usage) {
          const usage = nativeObject(part.usage);
          step.usage = { ...step.usage, ...usage };
          step.completeOutput = count(usage.output_tokens) !== null;
        } else if (part.type === "message_stop" && step) {
          if (!seenUsage.has(step.id)) {
            seenUsage.add(step.id);
            emitClaudeStepUsage(context, step.model, step.id, step.usage, step.completeOutput);
          }
          step = undefined;
        } else if (part.type === "content_block_delta") {
          const delta = nativeObject(part.delta);
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            streamed = true;
            context.emit({ type: "text", text: delta.text });
          }
        }
      } else if (event.type === "result") {
        if (seenUsage.size === 0) {
          // SDK result.usage covers this user turn, unlike cumulative modelUsage/cost.
          emitClaudeStepUsage(
            context,
            context.request.model.id,
            typeof event.uuid === "string" ? event.uuid : "result",
            event.usage ? nativeObject(event.usage) : {},
            true,
          );
        }
        if (event.subtype !== "success" || event.is_error !== false) {
          throw new Error("Claude Agent did not complete the turn successfully.");
        }
        if (!streamed) {
          const text = typeof event.result === "string" ? event.result : assistantText.join("\n");
          if (text) context.emit({ type: "text", text });
        }
        return;
      }
    } else if (message.method === "rakazo/provider-failure") {
      const detail = nativeObject(message.params);
      const failure = claudeProviderFailure(detail.code) ?? nativeHttpFailure(detail.status);
      if (failure) throw nativeProviderError("Claude Agent", failure);
    } else if (message.method === "rakazo/failure") {
      throw new Error("Claude Agent process failed.");
    } else if (message.method !== undefined && message.id !== undefined) {
      await channel.send({ id: message.id, error: { code: -32601, message: "Request denied." } });
      throw new Error("Claude Agent requested an unsupported operation.");
    }
  }
  throw new Error("Claude Agent ended without an explicit result.");
}

function emitClaudeStepUsage(
  context: NativeProtocolContext,
  model: string,
  messageId: string,
  usage: Record<string, unknown>,
  completeOutput: boolean,
): void {
  context.emit({
    type: "usage",
    provider: context.request.model.provider,
    model,
    inputTokens: count(usage.input_tokens),
    outputTokens: completeOutput ? count(usage.output_tokens) : null,
    cacheReadTokens: count(usage.cache_read_input_tokens),
    cacheWriteTokens: count(usage.cache_creation_input_tokens),
    // SDK monetary totals are estimates and may restore earlier session spend.
    costUsd: null,
    usageSource: "claude-agent-sdk",
    callId: `${context.request.runId}:claude:${messageId}`,
  });
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
