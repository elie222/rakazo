/** Pinned official app-server authentication only; no model turn or native tool is reachable. */
export const CODEX_AUTH_SANDBOX_RUNNER = String.raw`
import {spawn} from 'node:child_process';
import {mkdirSync,readFileSync,lstatSync,realpathSync,symlinkSync,unlinkSync} from 'node:fs';
const root='/opt/rakazo-harness/node_modules/@openai/codex';
if(JSON.parse(readFileSync(root+'/package.json','utf8')).version!=='0.162.1')throw new Error('Unsupported Codex version');
process.umask(0o077);
const credentials='/credentials/codex';
mkdirSync(credentials,{recursive:true,mode:0o700});
if(realpathSync(credentials)!==credentials||!lstatSync(credentials).isDirectory()||(lstatSync(credentials).mode&0o077)!==0)throw new Error('Invalid credential directory');
const authFile=credentials+'/auth.json';
function hasAuth(){try{const info=lstatSync(authFile);if(!info.isFile()||realpathSync(authFile)!==authFile)throw new Error('Invalid credential file');return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
hasAuth();
process.env.CODEX_HOME='/home/harness/.codex';
mkdirSync(process.env.CODEX_HOME,{recursive:true,mode:0o700});
symlinkSync(authFile,process.env.CODEX_HOME+'/auth.json');
const child=spawn(process.execPath,[root+'/bin/codex.js','app-server','--listen','stdio://',
 '-c','cli_auth_credentials_store="file"','-c','forced_login_method="chatgpt"',
 '-c','analytics.enabled=false','-c','features.plugins=false','-c','features.recommended_plugins=false','-c','features.apps=false','-c','model_provider="openai"'],{stdio:['pipe','pipe','pipe'],env:process.env});
const pending=new Map();let sequence=0,loginId,completionNotice,terminal=false,timer,started=false;
const send=(m)=>{const line=JSON.stringify(m)+'\n';if(Buffer.byteLength(line)>65536)throw new Error('Auth frame limit');process.stdout.write(line);};
const failure=()=>{try{send({method:'rakazo/auth/state',params:{state:'failed',code:'unavailable'}});}finally{child.kill();process.exit(1);}};
function lines(stream,handle){let buffer=Buffer.alloc(0);stream.on('data',chunk=>{try{buffer=Buffer.concat([buffer,chunk]);for(let at;(at=buffer.indexOf(10))>=0;){if(at>65536)throw new Error();const line=buffer.subarray(0,at);buffer=buffer.subarray(at+1);if(line.length)handle(JSON.parse(line.toString('utf8')));}if(buffer.length>65536)throw new Error();}catch{failure();}});}
const rpc=(method,params)=>new Promise((resolve,reject)=>{if(pending.size>=8)return reject(new Error('Auth request limit'));const id='auth-'+(++sequence);const timeout=setTimeout(()=>{pending.delete(id);reject(new Error('Auth request timeout'));},20000);pending.set(id,{resolve:v=>{clearTimeout(timeout);resolve(v);},reject:()=>{clearTimeout(timeout);reject(new Error('Native authentication failed'));}});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
async function account(){const result=await rpc('account/read',{refreshToken:false});if(!result.account)return {state:'signed_out'};if(result.account.type!=='chatgpt')throw new Error('Unexpected native account');return {state:'ready',accountLabel:typeof result.account.email==='string'?result.account.email.slice(0,200):null,plan:typeof result.account.planType==='string'?result.account.planType.slice(0,100):null};}
function completed(params){if(!loginId){completionNotice=params;return;}if(params?.loginId!==loginId)return;void (params.success?account():Promise.resolve({state:'failed',code:'denied'})).then(finish).catch(failure);}
function finish(state){if(terminal)return;terminal=true;clearTimeout(timer);send({method:'rakazo/auth/state',params:state});}
lines(child.stdout,m=>{if(m.id!==undefined&&!m.method){const waiting=pending.get(m.id);if(!waiting)return;pending.delete(m.id);m.error?waiting.reject():waiting.resolve(m.result??{});return;}if(m.method==='account/login/completed'){completed(m.params);}else if(m.id!==undefined){child.stdin.write(JSON.stringify({id:m.id,error:{code:-32601,message:'Denied'}})+'\n');failure();}});
child.stderr.on('data',()=>{});child.on('error',failure);child.on('exit',()=>{if(!terminal)failure();});
const ready=rpc('initialize',{clientInfo:{name:'rakazo',title:'Rakazo',version:'1.0.0'},capabilities:{experimentalApi:true}}).then(()=>child.stdin.write(JSON.stringify({method:'initialized'})+'\n'));
lines(process.stdin,m=>{void(async()=>{await ready;if(typeof m.id!=='string')throw new Error('Invalid auth request');let result;
 if(m.method==='rakazo/auth/start'&&!started){started=true;const login=await rpc('account/login/start',{type:'chatgptDeviceCode'});if(login.type!=='chatgptDeviceCode'||typeof login.loginId!=='string'||typeof login.verificationUrl!=='string'||typeof login.userCode!=='string')throw new Error('Invalid native login');loginId=login.loginId;if(completionNotice)completed(completionNotice);const url=new URL(login.verificationUrl);if(url.protocol!=='https:'||url.hostname!=='auth.openai.com'||url.username||url.password)throw new Error('Invalid verification URL');result={state:'pending',verificationUri:url.href,userCode:login.userCode,expiresAt:new Date(Date.now()+600000).toISOString()};timer=setTimeout(()=>{void rpc('account/login/cancel',{loginId}).finally(()=>finish({state:'failed',code:'expired'}));},600000);}
 else if(m.method==='rakazo/auth/status')result=await account();
 else if(m.method==='rakazo/auth/cancel'){if(loginId)await rpc('account/login/cancel',{loginId});result={state:'failed',code:'cancelled'};finish(result);}
 else if(m.method==='rakazo/auth/logout'){if(loginId&&!terminal)await rpc('account/login/cancel',{loginId});await rpc('account/logout',{});if(hasAuth())unlinkSync(authFile);result={state:'signed_out'};}
 else throw new Error('Unsupported auth request');send({id:m.id,result});
 })().catch(failure);});
process.stdin.on('end',()=>{terminal=true;clearTimeout(timer);child.kill();});
`;
