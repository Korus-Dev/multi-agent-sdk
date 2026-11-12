import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import authorshipFixture from './fixtures/authorship-capability.json';
export async function writeAntigravityRuntimeFixture(root: string) { await writeFile(path.join(root, 'runtime'), `#!/usr/bin/env node
// The CLI answers its usage command in print mode, without a session.
if(process.argv.includes('/usage')) {require('node:fs').appendFileSync(require('node:path').join(__dirname,'quota-reads'),'x');process.stdout.write('{"status":"SUCCESS","command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","buckets":[{"id":"gemini-weekly","window":"weekly","remaining_fraction":0.97,"reset_time":"2026-11-19T00:54:02Z"}]},{"name":"Claude and GPT models","buckets":[{"id":"3p-weekly","window":"weekly","remaining_fraction":1,"reset_time":"2026-11-19T14:16:23Z"}]}]}}}');process.exit(0);}
const rl=require('node:readline').createInterface({input:process.stdin});
const send=v=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\\n');
const fs=require('node:fs'), homeFlag=process.argv.indexOf('--gemini-dir');
// The CLI takes its home as a path from the user's home.
const home=require('node:path').resolve(require('node:os').homedir(),homeFlag<0?'.gemini':process.argv[homeFlag+1]);
const catalogFile=require('node:path').join(home,'catalog.json');
fs.mkdirSync(home,{recursive:true});
const usageFile=require('node:path').join(process.cwd(),'usage-fixture.json');
const usageFixture=()=>fs.existsSync(usageFile)?JSON.parse(fs.readFileSync(usageFile,'utf8')):undefined;
const authorshipFixture=${JSON.stringify(authorshipFixture)};
const catalog=()=>fs.existsSync(catalogFile)?fs.readFileSync(catalogFile,'utf8').trim().split('\\n').map(JSON.parse):[];
let sessionId=require('node:crypto').randomUUID(), mode='default', promptId, mcpServers=[], planPhase, utility, permissionFixture, cancelPermissionFixture;
const update=update=>send({method:'session/update',params:{sessionId,update}});
async function review(text,reply) {
 const server=mcpServers.find(server=>server.name==='korus');
 if(!server) throw new Error('Missing korus server');
 const child=require('node:child_process').spawn(server.command,server.args,{env:{...process.env,...Object.fromEntries(server.env.map(item=>[item.name,item.value]))},stdio:['pipe','pipe','ignore']});
 const pending=new Map();let id=0;
 require('node:readline').createInterface({input:child.stdout}).on('line',line=>{const value=JSON.parse(line);const done=pending.get(value.id);if(done)done(value);});
 const rpc=(method,params)=>new Promise((resolve,reject)=>{const key=++id;pending.set(key,value=>value.error?reject(new Error(value.error.message)):resolve(value.result));child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:key,method,params})+'\\n');});
 const call=async(name,args)=>{const result=await rpc('tools/call',{name,arguments:args});if(result.isError)throw new Error(JSON.stringify(result));return result.structuredContent;};
 try {
  const tools=await rpc('tools/list',{});
  if(!tools.tools.some(tool=>tool.name==='report_finding')||tools.tools.some(tool=>tool.name==='create-agent')) throw new Error('Wrong review scope');
  const ledgerFile=require('node:path').join(process.cwd(),'fixture-ledger.json');
  if(text.split('</context>').at(-1).trim().startsWith('Fix the ')) {
   const finding=JSON.parse(fs.readFileSync(ledgerFile,'utf8'));
   fs.writeFileSync(require('node:path').join(process.cwd(),'fixture-code.txt'),'fixed');
   await call('update_finding',{findingId:finding.id,status:'fixed',evidence:'Fixture external tool wrote and verified fixed content.'});
  } else if(!fs.existsSync(require('node:path').join(process.cwd(),'fixture-code.txt'))) {
   const finding=await call('report_finding',{priority:'p2',title:'Fixture defect',body:'The fixture code needs a correction.'});
   fs.writeFileSync(ledgerFile,JSON.stringify(finding.finding??finding));
   await call('finish_review_round',{findingCount:1});
  } else await call('finish_review_round',{findingCount:0});
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Review turn complete.'}});reply({stopReason:'end_turn'});
 } finally {child.stdin.end();}
}
rl.on('line',line=>{
 const v=JSON.parse(line), reply=result=>send({id:v.id,result});
 if(v.method==='initialize') {fs.writeFileSync(require('node:path').join(process.cwd(),'fixture-initialize.json'),JSON.stringify(v.params));reply({protocolVersion:1,agentInfo:{name:'Antigravity ACP Server',version:'1.5.6'}});}
 else if(v.method==='authenticate') reply({});
 else if(v.method==='session/new') {mcpServers=v.params.mcpServers;fs.writeFileSync(require('node:path').join(process.cwd(),'fixture-session.json'),JSON.stringify(v.params));fs.appendFileSync(catalogFile,JSON.stringify({sessionId,cwd:v.params.cwd,title:'Saved conversation'})+'\\n');reply({sessionId,...(usageFixture()?.configuration??{}),models:usageFixture()?.configuration.models??{currentModelId:'gemini-low',availableModels:[{modelId:'gemini-low',name:'Gemini Low'},{modelId:'opaque-oss-id',name:'GPT-OSS 120B (Medium)'}]}});}
 else if(v.method==='session/set_mode') {mode=v.params.modeId;fs.appendFileSync(require('node:path').join(process.cwd(),'fixture-modes'),mode+'\\n');reply({});}
 else if(v.method==='session/set_config_option') {fs.writeFileSync(require('node:path').join(process.cwd(),'fixture-model.json'),JSON.stringify(v.params));reply({});}
 else if(v.method==='session/list') reply({sessions:[...catalog(),{sessionId:'stored-session',cwd:process.cwd(),title:'Create a file'},{sessionId:'other-folder',cwd:'/another-workspace',title:'Private'}]});
 else if(v.method==='session/load') {
   sessionId=v.params.sessionId;
   mcpServers=v.params.mcpServers;
   for(const item of usageFixture()?.updates??[]) update(item);
   const saved=require('node:path').join(home,sessionId+'.jsonl');
   if(fs.existsSync(saved)) {
     for(const line of fs.readFileSync(saved,'utf8').trim().split('\\n')) {const prompt=JSON.parse(line);update({...authorshipFixture.historyUpdate,content:{...authorshipFixture.historyUpdate.content,text:prompt.replace(/^\\/plan\\s*/,'')}});update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Recovered.'}});}
     reply({});return;
   }
   update({sessionUpdate:'user_message_chunk',content:{type:'text',text:'Create a file'}});
   update({sessionUpdate:'tool_call',toolCallId:'replay-id',title:'Create file',kind:'edit',status:'completed'});
   update({sessionUpdate:'tool_call_update',toolCallId:'replay-id',status:'failed',rawOutput:'Rejected by user'});
   update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Denied.'}});
   reply({models:{currentModelId:'gemini-low',availableModels:[{modelId:'gemini-low',name:'Gemini Low'}]}});
 } else if(v.method==='session/prompt') {
   promptId=v.id;
   const text=v.params.prompt[0].text;
   fs.writeFileSync(require('node:path').join(process.cwd(),'fixture-prompt.json'),JSON.stringify(v.params.prompt));
   if(text.startsWith('usage-fixture:')) {
     const fixture=usageFixture();
     for(const item of fixture.updates) update(item);
     update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Public ACP response.'}});
     if(text.startsWith('usage-fixture:crash')) process.exit(1);
     if(text.startsWith('usage-fixture:wait')) return;
     if(text.startsWith('usage-fixture:schema-only')) {update(fixture.schemaOnlyNegativeControl.update);reply(fixture.schemaOnlyNegativeControl.completion);}
     else reply(fixture.completion);
     setTimeout(()=>update(fixture.lateUpdate),10);return;
   }
   if(text.startsWith('permission-fixture:')||text.startsWith('cancel-permission-fixture:')) {
     permissionFixture=JSON.parse(text.slice(text.indexOf(':')+1));
     if(text.startsWith('cancel-permission-fixture:')) {cancelPermissionFixture=true;fs.writeFileSync(require('node:path').join(process.cwd(),'cancel-permission-ready'),'');return;}
     update({sessionUpdate:'tool_call',...permissionFixture.toolCall,status:'pending'});
     send({id:v.id,method:'session/request_permission',params:{sessionId,...permissionFixture}});return;
   }
   if(text.endsWith('utility-fixture')) {utility=true;send({id:211,method:'fs/write_text_file',params:{sessionId,path:require('node:path').join(process.cwd(),'unwanted-write'),content:'bad'}});return;}
   fs.appendFileSync(require('node:path').join(home,sessionId+'.jsonl'),JSON.stringify(text)+'\\n');
   if(mode==='plan') {
     planPhase='question';
     send({id:v.id,method:'session/request_permission',params:{sessionId,toolCall:{toolCallId:'interaction_plan',title:'Use the minimal plan?'},options:[{optionId:'minimal-plan',name:'Minimal',kind:'allow_once'}]}});return;
   }
   if(mcpServers.some(server=>server.env.some(item=>item.name==='HARNESS_ACP_MCP_URL'&&item.value.includes('reviewContextId=')))) {void review(text,reply).catch(error=>{fs.writeFileSync(require('node:path').join(process.cwd(),'fixture-error.txt'),error.message);send({id:v.id,error:{code:-32603,message:error.message}});});return;}
   if(text==='crash') process.exit(1);
   if(text==='wait'||text.endsWith('utility-wait')) return;
   if(text==='question'||text==='deny') {
     update({sessionUpdate:'tool_call',toolCallId:'live-id',title:'Create file',kind:'edit',status:'pending'});
     send({id:v.id,method:'session/request_permission',params:{sessionId,toolCall:{toolCallId:text==='question'?'interaction_1':'live-id',title:text==='question'?'Which option?':'Create file'},options:text==='question'?[{optionId:'native-choice-7',name:'Proceed',kind:'allow_once'}]:[{optionId:'native-deny-9',name:'Deny',kind:'reject_once'}]}});
   } else {update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Recovered.'}});reply({stopReason:'end_turn'});}
 } else if(v.method==='session/cancel') {
   if(cancelPermissionFixture) send({id:901,method:'session/request_permission',params:{sessionId,...permissionFixture}});
   else send({id:promptId,result:{stopReason:'cancelled'}});
 }
 else if(!v.method) {
   if(permissionFixture) {
     fs.writeFileSync(require('node:path').join(process.cwd(),'permission-response.json'),JSON.stringify(v));
     const selected=permissionFixture.options.find(option=>option.optionId===v.result?.outcome?.optionId);
     update({sessionUpdate:'tool_call_update',toolCallId:permissionFixture.toolCall.toolCallId,status:selected?.kind.startsWith('allow_')?'completed':'failed'});
     permissionFixture=undefined;send({id:promptId,result:{stopReason:cancelPermissionFixture?'cancelled':'end_turn'}});cancelPermissionFixture=false;return;
   }
   if(utility) {utility=false;update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:v.error?'Tools denied; text result.':'Unexpected write'}});send({id:promptId,result:{stopReason:'end_turn'}});return;}
   if(planPhase==='question') {
     // The CLI keeps the plan among the conversation's own files.
     const brain=require('node:path').join(home,'antigravity-cli','brain',sessionId);fs.mkdirSync(brain,{recursive:true});
     fs.writeFileSync(require('node:path').join(brain,'implementation_plan.md'),'# Native plan\\n\\n1. Make the scoped change.\\n2. Verify it.');
     planPhase=undefined;update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'The plan is ready.'}});send({id:promptId,result:{stopReason:'end_turn'}});return;}
   update({sessionUpdate:'tool_call_update',toolCallId:'live-id',status:v.result.outcome.optionId==='native-deny-9'?'failed':'completed',rawOutput:v.result.outcome.optionId});
   send({id:promptId,result:{stopReason:'end_turn'}});
 } else reply({});
});
`, { mode: 0o700 }); }
