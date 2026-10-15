/**
 * Auth-only supervisor for the unmodified, pinned Kimi CLI. Runs inside the
 * credential sandbox, without workspace/session mounts. Provider credentials
 * never cross stdout: only the small Rakazo login-state protocol does.
 */
export const KIMI_AUTH_SANDBOX_RUNNER = String.raw`
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,symlinkSync,lstatSync,realpathSync,readdirSync,openSync,fstatSync,closeSync,readSync,constants} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {Transform} from 'node:stream';

const root='/opt/rakazo-harness/node_modules/@moonshot-ai/kimi-code';
const credentials='/credentials/kimi';
const MAX_FRAME=65536, provider='managed:kimi-code';
const FAILED={state:'failed',code:'unavailable'};
const regions={
 global:{oauthHost:'https://auth.kimi.ai',baseUrl:'https://api.kimi.ai/coding/v1'},
 'mainland-cn':{oauthHost:'https://auth.kimi.com',baseUrl:'https://api.kimi.com/coding/v1'},
};
const verificationHosts=new Set(['auth.kimi.ai','www.kimi.ai','kimi.ai','auth.kimi.com','www.kimi.com','kimi.com']);
let child,origin,token,home,stateDir,region,flowId,flowExpiresAt,poll,timer,stopping=false;
let current={state:'signed_out'},queue=Promise.resolve(),queued=0;
process.umask(0o077);

function send(message){
 if(stopping)return;
 const line=JSON.stringify({jsonrpc:'2.0',...message})+'\n';
 if(Buffer.byteLength(line)>MAX_FRAME)throw new Error('Frame limit');
 if(process.stdout.writableLength>MAX_FRAME*4)throw new Error('Output limit');
 process.stdout.write(line);
}
function terminal(state,notify=true){
 current=state;clearTimeout(poll);poll=undefined;
 if(notify)send({method:'rakazo/auth/state',params:state});
 return state;
}
function stop(code=0){
 if(stopping)return;stopping=true;clearTimeout(poll);clearTimeout(timer);
 input.close();process.stdin.destroy();
 if(!child||child.exitCode!==null||child.signalCode!==null){process.exit(code);return;}
 child.once('exit',()=>process.exit(code));child.kill('SIGTERM');
 setTimeout(()=>{child.kill('SIGKILL');process.exit(code);},1500).unref();
}
function fail(){try{terminal(FAILED);}finally{stop(1);}}
function privateDirectory(path){
 mkdirSync(path,{recursive:true,mode:0o700});
 const info=lstatSync(path);
 if(!info.isDirectory()||realpathSync(path)!==path||(info.mode&0o077)!==0)throw new Error('Unsafe directory');
}
function readSmall(path,max){
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const info=fstatSync(fd);if(!info.isFile()||info.size>max)throw new Error('Invalid file');
  const buffer=Buffer.alloc(max+1);const size=readSync(fd,buffer,0,buffer.length,0);
  if(size>max)throw new Error('Invalid file');return buffer.subarray(0,size).toString('utf8');
 }finally{closeSync(fd);}
}
function text(value,max=200){
 return typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value)?value:null;
}
function verificationUri(value){
 if(typeof value!=='string'||value.length>2048)throw new Error('Invalid verification URI');
 const url=new URL(value);
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||!verificationHosts.has(url.hostname))throw new Error('Invalid verification URI');
 return url.href;
}
function pendingState(data){
 const uri=verificationUri(data.verification_uri);
 if(typeof data.user_code!=='string'||!/^[A-Za-z0-9 -]{1,64}$/.test(data.user_code))throw new Error('Invalid code');
 const expiry=typeof data.expires_at==='string'?Date.parse(data.expires_at):NaN;
 if(!Number.isFinite(expiry)||expiry<=Date.now()||expiry>Date.now()+30*60*1000)throw new Error('Invalid expiry');
 flowExpiresAt??=Math.min(expiry,Date.now()+9*60*1000);
 return {state:'pending',verificationUri:uri,userCode:data.user_code,expiresAt:new Date(flowExpiresAt).toISOString()};
}
async function api(method,path,body){
 const response=await fetch(origin+'/api/v1/'+path,{
  method,redirect:'error',signal:AbortSignal.timeout(30000),
  headers:{Authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},
  ...(body?{body:JSON.stringify(body)}:{}),
 });
 if(!response.ok)throw new Error('Native request failed');
 const chunks=[];let size=0;
 for await(const chunk of response.body){size+=chunk.length;if(size>MAX_FRAME)throw new Error('Native response limit');chunks.push(chunk);}
 const envelope=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 if(envelope?.code!==0)throw new Error('Native request failed');
 return envelope.data;
}
async function ready(){
 let label=null,plan=null;
 try{
  const info=await api('GET','oauth/userinfo?provider='+encodeURIComponent(provider));
  if(info?.kind==='ok'){label=text(info.userInfo?.email)??text(info.userInfo?.nickname);plan=text(info.userInfo?.userLevelName,100);}
 }catch{}
 return {state:'ready',accountLabel:label,plan};
}
async function authStatus(){
 const result=await api('GET','auth');
 if(result?.managed_provider?.name===provider&&result.managed_provider.status==='authenticated')return ready();
 return {state:'signed_out'};
}
async function flowState(data){
 if(!data||data.provider!==provider||typeof data.flow_id!=='string'||data.flow_id.length>128)throw new Error('Invalid native flow');
 if(flowId&&flowId!==data.flow_id)throw new Error('Unexpected native flow');
 flowId=data.flow_id;
 if(data.status==='pending')return pendingState(data);
 if(data.status==='authenticated')return ready();
 if(['denied','expired','cancelled'].includes(data.status))return {state:'failed',code:data.status};
 throw new Error('Invalid native flow');
}
function schedulePoll(){
 clearTimeout(poll);
 poll=setTimeout(()=>{
  queue=queue.then(async()=>{
   if(stopping||current.state!=='pending')return;
   if(Date.now()>=flowExpiresAt){
    await api('DELETE','oauth/login?provider='+encodeURIComponent(provider));
    terminal({state:'failed',code:'expired'});return;
   }
   const data=await api('GET','oauth/login?provider='+encodeURIComponent(provider));
   const next=await flowState(data);
   if(next.state==='pending'){current=next;schedulePoll();}else terminal(next);
  }).catch(fail);
 },1000);
}
async function boot(requestedRegion){
 if(child){if(requestedRegion&&requestedRegion!==region)throw new Error('Region conflict');return;}
 if(JSON.parse(readSmall(root+'/package.json',MAX_FRAME)).version!=='2.2.0')throw new Error('Unsupported version');
 privateDirectory(credentials);privateDirectory(credentials+'/credentials');privateDirectory(credentials+'/oauth');
 try{const device=lstatSync(credentials+'/device_id');if(!device.isFile()||device.size>256||(device.mode&0o077)!==0)throw new Error('Invalid device identity');}catch(error){if(error.code!=='ENOENT')throw error;}
 let saved;
 try{saved=readSmall(credentials+'/region',64).trim();}catch(error){if(error.code!=='ENOENT')throw error;}
 if(saved&&!Object.hasOwn(regions,saved))throw new Error('Invalid region');
 if(saved&&requestedRegion&&saved!==requestedRegion)throw new Error('Region conflict');
 region=saved??requestedRegion??'global';
 if(!saved)writeFileSync(credentials+'/region',region,{mode:0o600,flag:'wx'});
 home=mkdtempSync(join(tmpdir(),'rakazo-kimi-auth-'));stateDir=home+'/.kimi-code';privateDirectory(stateDir);
 // Whole directories preserve Kimi's atomic credential replacement and its
 // cross-process refresh lock. No native token is read by this supervisor.
 symlinkSync(credentials+'/credentials',stateDir+'/credentials');
 symlinkSync(credentials+'/oauth',stateDir+'/oauth');
 symlinkSync(credentials+'/device_id',stateDir+'/device_id');
 const endpoints=regions[region];
 const key=region==='mainland-cn'?'oauth/kimi-code':'oauth/kimi-code-env-'+createHash('sha256').update(JSON.stringify(endpoints)).digest('hex').slice(0,16);
 writeFileSync(stateDir+'/config.toml',[
  'telemetry = false','default_permission_mode = "manual"',
  '[providers."managed:kimi-code"]','type = "kimi"','model_source = "static"','base_url = '+JSON.stringify(endpoints.baseUrl),'api_key = ""',
  '[providers."managed:kimi-code".oauth]','storage = "file"','key = '+JSON.stringify(key),'oauth_host = '+JSON.stringify(endpoints.oauthHost),
  '[tools]','enabled = ["mcp__rakazo__disabled"]','[database]','base = false','search = false',
 ].join('\n'),{mode:0o600});
 const env={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:home,TMPDIR:home,LANG:'C.UTF-8',KIMI_CODE_HOME:stateDir,KIMI_DISABLE_TELEMETRY:'1',KIMI_CODE_NO_AUTO_UPDATE:'1',KIMI_CODE_REGION_MARKER:'off'};
 child=spawn(process.execPath,[root+'/dist/main.mjs','web','--no-open','--host','127.0.0.1','--port','0'],{cwd:home,env,stdio:['ignore','ignore','ignore']});
 child.on('error',fail);child.on('exit',()=>{if(!stopping)fail();});
 const deadline=Date.now()+30000;
 while(Date.now()<deadline){
  if(stopping)throw new Error('Stopped');
  try{
   const files=readdirSync(stateDir+'/server/instances');
   if(files.length>8)throw new Error('Instance limit');
   for(const file of files){
    if(!/^[A-Za-z0-9_-]{1,64}\.json$/.test(file))continue;
    const info=JSON.parse(readSmall(stateDir+'/server/instances/'+file,4096));
    if(info.pid!==child.pid||info.host!=='127.0.0.1'||!Number.isInteger(info.port)||info.port<1||info.port>65535)continue;
    const candidate=readSmall(stateDir+'/server.token',256).trim();
    if(!/^[A-Za-z0-9_-]{32,128}$/.test(candidate))throw new Error('Invalid server token');
    origin='http://127.0.0.1:'+info.port;token=candidate;
    await api('GET','auth');return;
   }
  }catch{}
  await new Promise(resolve=>setTimeout(resolve,50));
 }
 throw new Error('Native startup timed out');
}
async function handle(message){
 const id=message?.id;
 if(message?.jsonrpc!=='2.0'||!(typeof id==='string'&&id.length<=128||Number.isSafeInteger(id))||!['rakazo/auth/start','rakazo/auth/status','rakazo/auth/cancel','rakazo/auth/logout'].includes(message.method)){
  send({id:typeof id==='string'&&id.length<=128||Number.isSafeInteger(id)?id:null,error:{code:-32600,message:'Invalid authentication request'}});return;
 }
 const params=message.params??{};
 if(!params||typeof params!=='object'||Array.isArray(params)||Object.keys(params).some(key=>key!=='region')||params.region!==undefined&&!Object.hasOwn(regions,params.region)){
  send({id,result:FAILED});return;
 }
 try{
  await boot(params.region);
  if(message.method==='rakazo/auth/start'){
   if(current.state!=='pending'){
    flowId=undefined;flowExpiresAt=undefined;
    current=await flowState(await api('POST','oauth/login',{provider,region}));
   }
   send({id,result:current});if(current.state==='pending')schedulePoll();return;
  }
  if(message.method==='rakazo/auth/status'){
   if(current.state!=='pending'&&current.state!=='failed')current=await authStatus();
   send({id,result:current});return;
  }
  if(message.method==='rakazo/auth/cancel'){
   const result=await api('DELETE','oauth/login?provider='+encodeURIComponent(provider));
   if(result?.status==='authenticated')current=await ready();
   else if(result?.cancelled===true||result?.status==='cancelled')current={state:'failed',code:'cancelled'};
   else if(['denied','expired'].includes(result?.status))current={state:'failed',code:result.status};
   else throw new Error('Invalid cancellation');
   send({id,result:current});terminal(current);return;
  }
  const result=await api('POST','oauth/logout',{provider});
  if(result?.logged_out!==true||result.provider!==provider)throw new Error('Invalid logout');
  current={state:'signed_out'};flowId=undefined;flowExpiresAt=undefined;send({id,result:current});terminal(current);
 }catch{send({id,result:FAILED});fail();}
}
let frameBytes=0;
const guard=new Transform({transform(chunk,encoding,done){
 const data=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk,encoding);
 for(const byte of data){if(byte===10)frameBytes=0;else if(++frameBytes>MAX_FRAME)return done(new Error('Input limit'));}
 done(null,data);
}});
guard.on('error',fail);process.stdin.pipe(guard);
const input=createInterface({input:guard,crlfDelay:Infinity});
input.on('line',line=>{
 if(++queued>16)return fail();
 let message;try{message=JSON.parse(line);}catch{return fail();}
 queue=queue.then(()=>handle(message)).catch(fail).finally(()=>{queued--;});
});
input.on('close',()=>stop());
process.on('SIGTERM',()=>stop());process.on('SIGINT',()=>stop());process.stdout.on('error',()=>stop(1));
// The host owns longer-lived credential volumes; this auth-only process has a
// bounded lifetime so an abandoned login cannot leave a native server running.
timer=setTimeout(()=>{terminal({state:'failed',code:'expired'});stop();},10*60*1000);
`;
