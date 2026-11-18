// Exercise the actual UI HTTP endpoint against isolated SQLite and public signed indexes.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const root=process.env.CC_BRIDGE_TEST_ROOT || '/root/.cc-update-admin/center-protocol25-bridge';
const source=process.env.CC_CENTER_SOURCE || root+'/stage';
const {createUpdateServer}=await import(pathToFileURL(source+'/apps/update-service/src/http.ts'));
const {UpdateStore}=await import(pathToFileURL(source+'/apps/update-service/src/store.ts'));
const hostModule=await import(pathToFileURL(source+'/apps/update-service/src/host-updates.ts'));
const production=JSON.parse(readFileSync(process.env.CC_BRIDGE_PUBLICATION_CONFIG || '/etc/cc-update-service/config.json'));
const actualIndex=JSON.parse(readFileSync(join(production.dataDir,'server/index.json')));
const actualPayload=JSON.parse(Buffer.from(actualIndex.payload,'base64url'));
assert.equal(actualPayload.release.build,30);
assert.equal(actualPayload.release.protocol,25);
assert.equal(actualPayload.release.runtimeLevel,'node24-cli2.1.325-v5');
const actualAgent=JSON.parse(readFileSync(join(production.dataDir,'host-agent/index.json')));
const actualAgentPayload=JSON.parse(Buffer.from(actualAgent.payload,'base64url'));
const hash=value=>createHash('sha256').update(value).digest('hex');
const rejecting=process.env.EXPECT_BRIDGE_REJECTION==='1';

async function fixture(options={}) {
  const data=mkdtempSync(root+'/fixture-');
  mkdirSync(join(data,'server'),{recursive:true});
  mkdirSync(join(data,'host-agent/artifacts'),{recursive:true});
  const keys=generateKeyPairSync('ed25519');
  const admin='isolated_bridge_admin_token_1234567890123456';
  const config={origin:production.origin,dataDir:data,port:0,adminName:'fixture',adminTokenSha256:hash(admin),
    monitorNodes:{fixture:hash('synthetic-monitor-credential')},
    trustedKeys:{...production.trustedKeys,'fixture-test':keys.publicKey.export({type:'spki',format:'pem'}).toString()}};
  let index=actualIndex;
  if (options.release) {
    const payload={...actualPayload,release:{...actualPayload.release,...options.release}};
    const bytes=Buffer.from(JSON.stringify(payload));
    index={keyId:'fixture-test',payload:bytes.toString('base64url'),signature:sign(null,bytes,keys.privateKey).toString('base64url')};
  }
  if (options.badSignature)index={...index,signature:'A'.repeat(86)};
  writeFileSync(join(data,'server/index.json'),JSON.stringify(index));
  writeFileSync(join(data,'host-agent/index.json'),JSON.stringify(actualAgent));
  cpSync(join(production.dataDir,'host-agent/artifacts',actualAgentPayload.archive.sha256+'.tar.gz'),
         join(data,'host-agent/artifacts',actualAgentPayload.archive.sha256+'.tar.gz'));
  const store=await UpdateStore.open(data,config.trustedKeys,'fixture');
  const hosts=new hostModule.HostUpdates(data,()=>['fixture']);
  const grant=hosts.issue('fixture');
  const credential=hosts.enroll({nodeId:'fixture',code:grant.code}).token;
  hosts.poll(credential,{nodeId:'fixture',current:{build:21,protocol:24,phase:options.phase || 'committed'}});
  const server=await createUpdateServer(store,config);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const selected=JSON.parse(Buffer.from(index.payload,'base64url')).release;
  const wanted={confirmed:true,agent:{version:actualAgentPayload.version,sha256:actualAgentPayload.archive.sha256},
    app:{build:selected.build,sha256:selected.sha256}};
  return {data,hosts,wanted,async post(input=wanted,auth=admin,requestOrigin=config.origin){
    const response=await fetch(origin+'/cc-updates/admin/api/host-workflows/fixture',{
      method:'POST',headers:{Authorization:'Bearer '+auth,Origin:requestOrigin,'Content-Type':'application/json'},body:JSON.stringify(input)});
    return {status:response.status,body:await response.json()};
  },async close(){
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await store.close();
    hosts.db.close();rmSync(data,{recursive:true});
  }};
}

test('actual signed Build30 protocol 25 v5 UI confirmation creates one exact legacy bridge job',async()=>{
  const f=await fixture();
  try {
    const response=await f.post();
    if (rejecting) {
      assert.equal(response.status,409);
      assert.match(response.body.error,/supported signed bridge runtime/);
      assert.equal(f.hosts.status('fixture').job,null);
      console.log('REPRODUCED_ACTUAL_UI_409_WITH_SIGNED_BUILD30');return;
    }
    assert.equal(response.status,202,JSON.stringify(response.body));
    const job=f.hosts.status('fixture').job;
    assert.equal(job.build,30);assert.equal(job.sha256,actualPayload.release.sha256);
    assert.deepEqual(job.index,actualIndex);
    assert.equal(response.body.workflow.appJobId,job.id);
    const again=await f.post();assert.equal(again.status,202);
    assert.equal(f.hosts.status('fixture').job.id,job.id);
    console.log('SIGNED_BUILD30_UI_CONFIRMATION_AND_EXACT_JOB_ASSOCIATION_PASSED');
  } finally {await f.close();}
});

test('reviewed v5 requires Build26+ protocol 24 or Build30+ protocol 25; v4 remains supported',{skip:rejecting},()=>{
  const supported=hostModule.supportsLegacyBridge;
  for (const runtimeLevel of ['node24-cli2.1.295-v4','node24-cli2.1.325-v4'])
    assert(supported({build:25,protocol:24,runtimeLevel}));
  assert(supported({build:26,protocol:24,runtimeLevel:'node24-cli2.1.325-v5'}));
  assert(supported({build:30,protocol:24,runtimeLevel:'node24-cli2.1.325-v5'}));
  assert(supported({build:30,protocol:25,runtimeLevel:'node24-cli2.1.325-v5'}));
  for (const value of [null,{build:21,protocol:24,runtimeLevel:'node24-cli2.1.325-v4'},
      {build:25,protocol:24,runtimeLevel:'node24-cli2.1.325-v5'},
      {build:26,protocol:25,runtimeLevel:'node24-cli2.1.325-v5'},
      {build:29,protocol:25,runtimeLevel:'node24-cli2.1.325-v5'},
      {build:30,protocol:26,runtimeLevel:'node24-cli2.1.325-v5'},
      {build:30,protocol:25,runtimeLevel:'node24-cli2.1.325-v6'},
      {build:26,protocol:24,runtimeLevel:'node24-cli2.1.325-v6'},
      {build:26,protocol:24,runtimeLevel:'node24-cli9.9.9-v5'}])assert.equal(supported(value),false);
});

test('failed preparation admits only reserved bridge v5, ordinary enqueue stays blocked',{skip:rejecting},async()=>{
  const f=await fixture({phase:'failed'});
  try {
    assert.throws(()=>f.hosts.enqueue('fixture',{confirmed:true,build:30,sha256:actualPayload.release.sha256},actualPayload.release,actualIndex),/请先处理当前状态/);
    const response=await f.post();assert.equal(response.status,202,JSON.stringify(response.body));
    assert.equal(f.hosts.status('fixture').job.build,30);
  }finally{await f.close();}
});

test('old signed v4 bridge remains eligible through real HTTP',{skip:rejecting},async()=>{
  const f=await fixture({release:{build:25,protocol:24,runtimeLevel:'node24-cli2.1.325-v4'}});
  try{const response=await f.post();assert.equal(response.status,202,JSON.stringify(response.body));assert.equal(f.hosts.status('fixture').job.build,25);}
  finally{await f.close();}
});

test('unknown signed runtime or premature v5 cannot create a workflow/job',{skip:rejecting},async()=>{
  for (const release of [{runtimeLevel:'node24-cli2.1.325-v6'}, {build:25,runtimeLevel:'node24-cli2.1.325-v5'}, {build:29,runtimeLevel:'node24-cli2.1.325-v5'}, {protocol:26}]){
    const f=await fixture({release});
    try {const response=await f.post();assert.equal(response.status,409);assert.match(response.body.error,/supported signed bridge runtime/);assert.equal(f.hosts.status('fixture').job,null);}
    finally{await f.close();}
  }
});

test('tampered signature, wrong exact target, missing auth and wrong origin stay rejected',{skip:rejecting},async()=>{
  for (const mode of ['signature','target','auth','origin']) {
    const f=await fixture({badSignature:mode==='signature'});
    try {
      const request=mode==='target'?{...f.wanted,app:{...f.wanted.app,sha256:'0'.repeat(64)}}:f.wanted;
      const response=await f.post(request,mode==='auth'?'invalid':'isolated_bridge_admin_token_1234567890123456',mode==='origin'?'https://invalid.example':production.origin);
      assert.equal(response.status,mode==='auth'?401:mode==='origin'?403:409,JSON.stringify(response.body));
      assert.equal(f.hosts.status('fixture').job,null);
    }finally{await f.close();}
  }
});
