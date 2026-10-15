import type { AgentRunRequest, SandboxProcessRequest } from "@rakazo/adapter-kit";
import { kimiProviderFailure, nativeProviderError } from "./primary-harness-errors.js";
import { prepareNativeMedia } from "./primary-harness-media.js";
import type { NativeProtocolChannel, NativeProtocolContext } from "./primary-harness-protocol.js";
import { nativeObject, nativeString } from "./primary-harness-protocol.js";

/** Official successor CLI, verified against its ACP and persisted wire schemas. */
export const KIMI_CLI_VERSION = "2.2.0";
const PROMPT_ID = "rakazo:kimi:prompt";
const SESSION_ID = /^[a-zA-Z0-9_-]{1,128}$/;

// This trusted supervisor runs ONLY in the isolated harness container. Kimi's
// public ACP interface is used unchanged. Its internal SDK is not published.
// A private loopback MCP server exposes only Rakazo-authorized tools. Native
// tools are additionally disabled by the engine's global enabled-tool policy.
export const KIMI_SANDBOX_RUNNER = String.raw`
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,symlinkSync,existsSync,statSync,openSync,readSync,closeSync,fstatSync,realpathSync,lstatSync,constants} from 'node:fs';
import {createServer} from 'node:http';
import {createInterface} from 'node:readline';
import {Transform} from 'node:stream';
import {Server} from '/opt/rakazo-harness/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js';
import {StreamableHTTPServerTransport} from '/opt/rakazo-harness/node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '/opt/rakazo-harness/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js';
const root='/opt/rakazo-harness/node_modules/@moonshot-ai/kimi-code';
const version=JSON.parse(readFileSync(root+'/package.json','utf8')).version;
if(version!=='2.2.0')throw new Error('Unsupported Kimi Code version');
process.umask(0o077);
const home='/home/harness', state=home+'/.kimi-code', sessions='/sessions/kimi-code-sessions';
process.env.HOME=home;process.env.KIMI_CODE_HOME=state;process.chdir(home);
mkdirSync(state,{mode:0o700});mkdirSync(state+'/agents',{mode:0o700});mkdirSync(sessions,{recursive:true,mode:0o700});
symlinkSync(sessions,state+'/sessions');
const pending=new Map(), internal=new Map(), resumes=new Map(), durableCalls=new Map(), announcedCalls=new Map(), durableResults=new Set();let bridgeTail=Promise.resolve(),awaitingResult,mediaRejected=false;let child,server,started=false,sessionId,wirePath,wireOffset=0,recordStart=0,recordBytes=0,recordParts=[],turnEnd,seq=0,poll;
const send=(m)=>{const line=JSON.stringify({jsonrpc:'2.0',...m})+'\n';if(Buffer.byteLength(line)>1048576)throw new Error('Output frame limit');process.stdout.write(line);};
const fail=()=>{try{send({method:'rakazo/failure',params:mediaRejected?{code:'media_stripped'}:{}});}finally{child?.kill();server?.close();process.exitCode=1;input.close();clearInterval(poll);}};
const forward=(m)=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',...m})+'\n');
const rpc=(method,params)=>new Promise((resolve,reject)=>{if(internal.size>=8)return reject(new Error('Internal RPC limit'));const id='bootstrap-'+(++seq);const timer=setTimeout(()=>{internal.delete(id);reject(new Error('Internal RPC timeout'));},30000);internal.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});forward({id,method,params});});
function record(line,offset){
 if(!line.length)return;const entry=JSON.parse(line.toString('utf8'));
 if(entry.type==='llm.request'&&entry.agentId==='main'&&['media-degraded','media-stripped','strict-media-degraded','strict-media-stripped'].includes(entry.projection)){mediaRejected=true;throw new Error('Native media fallback is disabled');}
 if(entry.type==='usage.record'&&entry.agentId==='main')send({method:'rakazo/usage',params:{...entry,callId:sessionId+':wire-byte:'+offset}});
 if(entry.type==='context.append_loop_event'&&entry.agentId==='main'&&entry.event?.type==='tool.call'){const e=entry.event;if(durableCalls.size>=128)throw new Error('Native tool event limit');durableCalls.set(e.turnId+':'+e.toolCallId,{name:e.name,args:e.args,uuid:e.uuid});}
 if(entry.type==='context.append_loop_event'&&entry.agentId==='main'&&entry.event?.type==='tool.result'){if(durableResults.size>=128)throw new Error('Native tool result limit');durableResults.add(entry.event.parentUuid);}
 if(entry.type==='turn.ended'&&entry.agentId==='main')turnEnd=entry;
}
function openWire(){const fd=openSync(wirePath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const info=fstatSync(fd);if(realpathSync(sessions)!==sessions)throw new Error('Native session root must be canonical');const expected=sessions+wirePath.slice(sessions.length);if(!info.isFile()||realpathSync('/proc/self/fd/'+fd)!==expected||info.size>1073741824)throw new Error('Invalid native session file');return {fd,size:info.size};}catch(error){closeSync(fd);throw error;}}
function wire(){
 if(!wirePath||!existsSync(wirePath))return;
 const {fd,size}=openWire();if(size<wireOffset){closeSync(fd);throw new Error('Native session log truncated');}
 // Read new bytes only. Both one partial record and one polling batch are bounded.
 const end=Math.min(size,wireOffset+16777216),buffer=Buffer.allocUnsafe(65536);
 try{while(wireOffset<end){const startOffset=wireOffset;const length=readSync(fd,buffer,0,Math.min(buffer.length,end-wireOffset),wireOffset);if(!length)throw new Error('Native session read made no progress');wireOffset+=length;let start=0;
  for(let index=0;index<=length;index++){if(index!==length&&buffer[index]!==10)continue;const part=buffer.subarray(start,index);recordBytes+=part.length;if(recordBytes>16777216)throw new Error('Native session record limit');if(part.length)recordParts.push(Buffer.from(part));
   if(index<length){record(Buffer.concat(recordParts,recordBytes),recordStart);recordParts=[];recordBytes=0;recordStart=startOffset+index+1;}start=index+1;
  }
 }}finally{closeSync(fd);}
}
async function drainWire(){while(wirePath&&existsSync(wirePath)&&wireOffset<statSync(wirePath).size){wire();await new Promise(resolve=>setImmediate(resolve));}if(recordBytes)throw new Error('Incomplete native session record');}
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));return value;}
async function durableTool(name,args){const qualified='mcp__rakazo__'+name.replace(/_+/g,'_'),signature=JSON.stringify(canonical(args));const until=Date.now()+10000;while(Date.now()<until){wire();for(const[id,call]of durableCalls){if(call.name===qualified&&announcedCalls.get(id)===qualified&&JSON.stringify(canonical(call.args))===signature){durableCalls.delete(id);announcedCalls.delete(id);return {callId:sessionId+':tool:'+id,uuid:call.uuid};}}await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Native tool journal did not flush');}
async function previousResult(){if(!awaitingResult)return;const until=Date.now()+10000;while(Date.now()<until){wire();if(durableResults.has(awaitingResult)){durableResults.delete(awaitingResult);awaitingResult=undefined;return;}await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Native tool result did not flush');}
function serializedTool(fn){const task=bridgeTail.then(fn);bridgeTail=task.then(()=>undefined,()=>undefined);return task.catch(error=>{fail();throw error;});}
function bindSession(id){
 if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(id))throw new Error('Invalid session ID');sessionId=id;
 const normalized=home.replaceAll('\\','/').replace(/\/+$/,'');const slug=normalized.split('/').pop().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40);
 const key='wd_'+slug+'_'+createHash('sha256').update(normalized).digest('hex').slice(0,12);
 wirePath=sessions+'/'+key+'/'+id+'/agents/main/wire.jsonl';
 // Old records belong to prior turns and are never emitted again.
 if(existsSync(wirePath)){const {fd,size}=openWire();wireOffset=size;try{if(wireOffset){const last=Buffer.alloc(1);if(readSync(fd,last,0,1,wireOffset-1)!==1||last[0]!==10)throw new Error('Incomplete native session log; reset required');}}finally{closeSync(fd);}recordStart=wireOffset;}
 poll=setInterval(()=>{try{wire();}catch{fail();}},50);poll.unref();
}
function bounded(stream){let bytes=0;const guard=new Transform({transform(chunk,encoding,done){const data=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk,encoding);let start=0;for(let i=0;i<data.length;i++){if(data[i]===10){bytes+=i-start;if(bytes>16777216)return done(new Error('Partial protocol frame limit'));bytes=0;start=i+1;}}bytes+=data.length-start;if(bytes>16777216)return done(new Error('Partial protocol frame limit'));done(null,data);}});guard.on('error',fail);stream.pipe(guard);return guard;}
const input=createInterface({input:bounded(process.stdin),crlfDelay:Infinity});
input.on('line',(line)=>{if(Buffer.byteLength(line)>16777216)return fail();let m;try{m=JSON.parse(line);}catch{return fail();}
 if(m.method==='rakazo/start'&&!started){started=true;void start(m).catch(fail);return;}
 if(m.method==='rakazo/interrupt'){if(sessionId)forward({method:'session/cancel',params:{sessionId}});return;}
 const waiting=pending.get(m.id);if(waiting&&!m.method){pending.delete(m.id);m.error?waiting.reject(new Error('Host tool denied')):waiting.resolve(m.result);return;}
 if(!child)return fail();
 if(m.method==='session/resume')resumes.set(m.id,m.params.sessionId);
 if(m.method==='session/new'||m.method==='session/resume')m.params={...m.params,cwd:home,mcpServers:[{type:'http',name:'rakazo',url:'http://127.0.0.1:'+server.address().port+'/mcp',headers:[]}]};
 if(m.method==='session/prompt'){turnEnd=undefined;wire();}
 forward(m);
});
async function start(m){
 const p=m.params;if(!p||!Array.isArray(p.tools)||typeof p.instructions!=='string'||typeof p.endpoint!=='string'||typeof p.modelId!=='string'||(!p.nativeLogin&&!process.env.KIMI_API_KEY))throw new Error('Invalid startup');
 const names=p.tools.map(t=>'mcp__rakazo__'+t.name.replace(/_+/g,'_'));if(new Set(names).size!==names.length)throw new Error('Tool name collision');if(names.some(n=>n.length>64||!/^[a-zA-Z0-9_-]+$/.test(n)))throw new Error('Unsupported tool name');
 const q=JSON.stringify;
 let provider='rakazo',providerConfig=['[providers.rakazo]','type = "openai"','model_source = "static"','base_url = '+q(p.endpoint),'api_key_env = "KIMI_API_KEY"'];
 if(p.nativeLogin){
  const credentials='/credentials/kimi';if(realpathSync(credentials)!==credentials||!['global','mainland-cn'].includes(p.region)||readFileSync(credentials+'/region','utf8').trim()!==p.region)throw new Error('Native account region mismatch');
  for(const name of ['credentials','oauth']){const path=credentials+'/'+name;if(!lstatSync(path).isDirectory()||realpathSync(path)!==path)throw new Error('Invalid native credential directory');symlinkSync(path,state+'/'+name);}
  if(!lstatSync(credentials+'/device_id').isFile())throw new Error('Invalid native account identity');symlinkSync(credentials+'/device_id',state+'/device_id');
  const endpoints=p.region==='mainland-cn'?{oauthHost:'https://auth.kimi.com',baseUrl:'https://api.kimi.com/coding/v1'}:{oauthHost:'https://auth.kimi.ai',baseUrl:'https://api.kimi.ai/coding/v1'};
  if(p.endpoint!==endpoints.baseUrl)throw new Error('Native account endpoint mismatch');
  const key=p.region==='mainland-cn'?'oauth/kimi-code':'oauth/kimi-code-env-'+createHash('sha256').update(JSON.stringify(endpoints)).digest('hex').slice(0,16);
  provider='managed:kimi-code';providerConfig=['[providers."managed:kimi-code"]','type = "kimi"','model_source = "static"','base_url = '+q(endpoints.baseUrl),'api_key = ""','[providers."managed:kimi-code".oauth]','storage = "file"','key = '+q(key),'oauth_host = '+q(endpoints.oauthHost)];
 }
 const config=['default_model = "rakazo"','telemetry = false','default_permission_mode = "manual"',
 ...providerConfig,
 '[models.rakazo]','provider = '+q(provider),'model = '+q(p.modelId),'max_context_size = '+p.contextWindow,'capabilities = '+q(['tool_use',...(p.images?['image_in']:[])]),
 '[tools]','enabled = '+q(names.length?names:['mcp__rakazo__disabled']),
 '[database]','base = false','search = false','[loop_control]','max_steps_per_turn = 100','max_attempts_per_step = 1','max_ralph_iterations = 0',
 '[[permission.rules]]','decision = "allow"','pattern = "mcp__rakazo__*"'].join('\n');
 writeFileSync(state+'/config.toml',config,{mode:0o600});
 writeFileSync(state+'/AGENTS.md',p.instructions,{mode:0o600});
 writeFileSync(state+'/agents/agent.md','---\nname: agent\ndescription: Authorized Rakazo agent\noverride: true\ntools: '+q(names.length?names:['mcp__rakazo__disabled'])+'\nsubagents: []\n---\n'+('$'+'{agents_md}')+'\nUse only the provided Rakazo tools. Never create native agents or request native permissions.\n',{mode:0o600});
 // Stateless HTTP transports are created per request; no auth/config leaves tmpfs.
 server=createServer((req,res)=>{void(async()=>{
  if(req.url!=='/mcp'||req.method!=='POST'){res.writeHead(404);res.end();return;}
  const chunks=[];let bytes=0;for await(const c of req){bytes+=c.length;if(bytes>16777216)throw new Error('MCP input limit');chunks.push(c);}
  const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const bridge=new Server({name:'rakazo',version:'1.0.0'},{capabilities:{tools:{}}});
  bridge.setRequestHandler(ListToolsRequestSchema,async()=>({tools:p.tools}));
  bridge.setRequestHandler(CallToolRequestSchema,(call)=>serializedTool(async()=>{
   if(!p.tools.some(t=>t.name===call.params.name))throw new Error('Unknown tool');
   if(pending.size>=32)throw new Error('Too many pending tool calls');await previousResult();const {callId,uuid}=await durableTool(call.params.name,call.params.arguments??{});const id='kimi-tool-'+(++seq);
   const result=await new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});send({id,method:'rakazo/tool',params:{name:call.params.name,args:call.params.arguments??{},callId}});});
   awaitingResult=uuid;return {content:result.content??[{type:'text',text:result.text}],isError:result.isError};
  }));
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  res.on('close',()=>{void transport.close();void bridge.close();});await bridge.connect(transport);await transport.handleRequest(req,res,body);
 })().catch(()=>{if(!res.headersSent)res.writeHead(500);res.end();});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 child=spawn(process.execPath,[root+'/dist/main.mjs','acp'],{cwd:home,env:{...process.env},stdio:['pipe','pipe','pipe']});
 child.stderr.on('data',()=>{});child.on('error',fail);child.on('exit',()=>{clearInterval(poll);server.close();input.close();});
 const output=createInterface({input:bounded(child.stdout),crlfDelay:Infinity});
 output.on('line',(line)=>{void(async()=>{
  if(Buffer.byteLength(line)>16777216)throw new Error('ACP output limit');const event=JSON.parse(line);
  const waiter=internal.get(event.id);if(waiter&&!event.method){internal.delete(event.id);event.error?waiter.reject(new Error('Internal ACP failed')):waiter.resolve(event.result??{});return;}
  if(event.result?.sessionId&&!sessionId)bindSession(event.result.sessionId);
  if(resumes.has(event.id)&&!event.method){const id=resumes.get(event.id);resumes.delete(event.id);if(!event.error)bindSession(id);}
  if(event.id==='rakazo:kimi:prompt'&&!event.method){await rpc('session/close',{sessionId});await drainWire();await previousResult();clearInterval(poll);
   event.rakazoFailureCode=['auth.login_required','auth.provisioning_required','auth.token_missing','auth.token_unauthorized','provider.auth_error','provider.rate_limit','provider.connection_error','provider.overloaded','model.not_configured','model.config_invalid','model.not_found','auth.model_not_resolved','context.overflow'].includes(turnEnd?.error?.code)?turnEnd.error.code:undefined;
   if(event.result)event.result={...event.result,verifiedReason:turnEnd?.reason??'missing'};
  }
  if(event.method==='session/update'&&['tool_call','tool_call_update'].includes(event.params?.update?.sessionUpdate)){const u=event.params.update;if(u.sessionUpdate==='tool_call'){if(announcedCalls.size>=128)throw new Error('Native tool announcement limit');announcedCalls.set(u.toolCallId,u.title);}event.params.update={sessionUpdate:u.sessionUpdate,toolCallId:u.toolCallId,title:u.title,kind:u.kind,status:u.status};}
  send(event);
 })().catch(fail);});
 send({id:m.id,result:{version}});
}
`;

export function buildKimiProcess(request: AgentRunRequest): SandboxProcessRequest {
  if (request.model.oauth || (!request.model.nativeLogin && !request.model.apiKey?.trim())) {
    throw new Error("Kimi Code requires an explicit API key; OAuth is not supported");
  }
  if (!request.model.baseUrl)
    throw new Error("Kimi Code requires an explicit Chat Completions endpoint");
  return {
    isolation: "primary-harness",
    argv: ["node", "--input-type=module", "--eval", KIMI_SANDBOX_RUNNER],
    env: request.model.nativeLogin ? {} : { KIMI_API_KEY: request.model.apiKey! },
  };
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Kimi Code returned invalid token usage");
  }
  return value;
}

export async function runKimiProtocol(
  channel: NativeProtocolChannel,
  context: NativeProtocolContext,
): Promise<void> {
  const { request } = context;
  context.signal.throwIfAborted();
  const media = await prepareNativeMedia(request, "kimi");
  if (context.nativeSessionId && !SESSION_ID.test(context.nativeSessionId))
    throw new Error("Invalid Kimi native session ID");
  const startup = await channel.request("rakazo/start", {
    instructions: request.instructions,
    modelId: request.model.id,
    endpoint: request.model.baseUrl,
    nativeLogin: Boolean(request.model.nativeLogin),
    region: request.model.nativeLogin?.region,
    contextWindow: request.model.contextWindow ?? 128_000,
    images: Boolean(request.model.acceptsImages),
    tools: context.tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
  });
  if (startup.version !== KIMI_CLI_VERSION) throw new Error("Unsupported Kimi Code version");
  context.signal.throwIfAborted();
  const initialized = await channel.request("initialize", {
    protocolVersion: 1,
    clientInfo: { name: "rakazo", version: "1.0.0" },
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  });
  if (
    initialized.protocolVersion !== 1 ||
    nativeObject(initialized.agentInfo).version !== KIMI_CLI_VERSION
  )
    throw new Error("Unsupported Kimi ACP protocol");
  if (request.model.nativeLogin) await channel.request("authenticate", { methodId: "login" });
  const session = await channel.request(
    context.nativeSessionId ? "session/resume" : "session/new",
    {
      ...(context.nativeSessionId ? { sessionId: context.nativeSessionId } : {}),
      cwd: "/home/harness",
      mcpServers: [],
    },
  );
  if (
    context.nativeSessionId &&
    session.sessionId !== undefined &&
    session.sessionId !== context.nativeSessionId
  )
    throw new Error("Kimi session identity mismatch");
  const sessionId = context.nativeSessionId ?? nativeString(session.sessionId);
  if (!SESSION_ID.test(sessionId)) throw new Error("Invalid Kimi native session ID");
  await context.onSession(sessionId);
  context.signal.throwIfAborted();
  context.setInterrupt(() => channel.send({ method: "rakazo/interrupt" }));
  const prompt: Record<string, unknown>[] = [
    { type: "text", text: `Rakazo conversation input:\n${context.prompt}` },
  ];
  for (const part of media) {
    if (part.kind !== "image") throw new Error("Kimi Code does not support uploaded audio");
    prompt.push(
      { type: "text", text: part.label },
      { type: "image", data: part.data, mimeType: part.mimeType },
    );
  }
  await channel.send({ id: PROMPT_ID, method: "session/prompt", params: { sessionId, prompt } });
  const declaredNames = new Set(
    context.tools.map((tool) => `mcp__rakazo__${tool.name.replace(/_+/g, "_")}`),
  );
  const bridgeCalls = new Map<string, string>();
  const usageIds = new Set<string>();
  for await (const message of channel.messages) {
    context.signal.throwIfAborted();
    if (message.method === "rakazo/tool") {
      const p = nativeObject(message.params);
      const result = await context.callTool(
        nativeString(p.name),
        nativeObject(p.args),
        nativeString(p.callId),
      );
      context.signal.throwIfAborted();
      await channel.send({ id: message.id, result });
    } else if (message.method === "rakazo/usage") {
      const p = nativeObject(message.params),
        usage = nativeObject(p.usage);
      const input = count(usage.inputOther),
        output = count(usage.output),
        cacheRead = count(usage.inputCacheRead),
        cacheWrite = count(usage.inputCacheCreation);
      if (!Number.isSafeInteger(input + output + cacheRead + cacheWrite))
        throw new Error("Kimi Code returned invalid token usage");
      const callId = nativeString(p.callId);
      if (usageIds.has(callId)) continue;
      usageIds.add(callId);
      // The pinned engine substitutes emptyUsage() when a provider omits usage.
      // Its wire cannot distinguish that case from a genuinely measured zero.
      const measured = input + output + cacheRead + cacheWrite > 0;
      context.emit({
        type: "usage",
        model: request.model.id,
        provider: request.model.provider,
        callId,
        inputTokens: measured ? input : null,
        outputTokens: measured ? output : null,
        cacheReadTokens: measured ? cacheRead : null,
        cacheWriteTokens: measured ? cacheWrite : null,
        totalTokens: measured ? input + output + cacheRead + cacheWrite : null,
        usageSource: measured ? "kimi-code-wire" : "kimi-code-usage-unavailable",
      });
    } else if (message.method === "session/update") {
      const p = nativeObject(message.params);
      if (p.sessionId !== sessionId) throw new Error("Kimi session identity mismatch");
      const update = nativeObject(p.update);
      if (
        update.sessionUpdate === "tool_call" &&
        typeof update.toolCallId === "string" &&
        typeof update.title === "string"
      ) {
        if (!declaredNames.has(update.title))
          throw new Error("Kimi attempted a disabled native tool");
        if (bridgeCalls.size >= 128) throw new Error("Kimi native tool announcement limit");
        bridgeCalls.set(update.toolCallId, update.title);
      }
      if (update.sessionUpdate === "agent_message_chunk") {
        const content = nativeObject(update.content);
        if (content.type === "text" && typeof content.text === "string")
          context.emit({ type: "text", text: content.text });
      }
    } else if (message.method === "session/request_permission") {
      const p = nativeObject(message.params);
      const call = nativeObject(p.toolCall);
      const options = Array.isArray(p.options) ? p.options : [];
      if (
        p.sessionId === sessionId &&
        typeof call.toolCallId === "string" &&
        typeof call.title === "string" &&
        bridgeCalls.get(call.toolCallId) === call.title &&
        declaredNames.has(call.title) &&
        options.some((option) => {
          const value = nativeObject(option);
          return value.optionId === "approve_once" && value.kind === "allow_once";
        })
      ) {
        bridgeCalls.delete(call.toolCallId);
        await channel.send({
          id: message.id,
          result: { outcome: { outcome: "selected", optionId: "approve_once" } },
        });
      } else {
        await channel.send({ id: message.id, result: { outcome: { outcome: "cancelled" } } });
        throw new Error("Kimi requested an unsupported native permission");
      }
    } else if (message.id === PROMPT_ID && !message.method) {
      const result = nativeObject(message.result ?? {});
      if (
        message.error ||
        result.stopReason !== "end_turn" ||
        result.verifiedReason !== "completed"
      ) {
        const failure = kimiProviderFailure(message.rakazoFailureCode);
        throw failure
          ? nativeProviderError("Kimi Code", failure)
          : new Error("Kimi Code did not complete successfully");
      }
      if (usageIds.size === 0)
        context.emit({
          type: "usage",
          model: request.model.id,
          provider: request.model.provider,
          callId: `${sessionId}:${request.runId}:usage-unavailable`,
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          totalTokens: null,
          usageSource: "kimi-code-usage-unavailable",
        });
      return;
    } else if (message.method === "rakazo/failure") {
      if (nativeObject(message.params ?? {}).code === "media_stripped") {
        throw new Error(
          "Kimi attempted to remove attached media after a provider error; the run was stopped.",
        );
      }
      throw new Error("Kimi Code protocol failed");
    } else if (message.method && message.id !== undefined) {
      await channel.send({
        id: message.id,
        ...(message.method === "session/request_permission"
          ? { result: { outcome: { outcome: "cancelled" } } }
          : { error: { code: -32601, message: "Native actions are disabled" } }),
      });
      throw new Error("Kimi requested an unsupported native action");
    }
  }
  throw new Error("Kimi Code exited without a verified terminal result");
}
