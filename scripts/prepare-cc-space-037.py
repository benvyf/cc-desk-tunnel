#!/usr/bin/env python3
"""Prepare the confirmed ubuntu-cc image offline; never replace its running container."""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import tarfile
import tempfile


CONTAINER = "cc-desk-tunnel-ba938975-proxy-1"
BASE = "sha256:365918cb8abf4f4b784502a6bbabeda5704dc928e5c899438199776001b1adb2"
ARCHIVE_SHA256 = "9c5d6210ac8d3fe9b546abe0c71acae53bb4b7580dcb515388103d1409debb27"
SOURCE = "0c2caa8f235d1d5f85d7245fcee898177204dbff"
IMAGE = "cc-space-preview:0.3.7-build4"
CLI_SHA256 = "4503bfe11a6c7fcc1e0b39b5e0d347c04248f750b03b0977b3ad6b531fe6f358"

# Same isolated supervisor check as the reviewed bootstrap, without running its installer.
SMOKE = r"""import{spawn}from'node:child_process';import{mkdirSync,existsSync}from'node:fs';import assert from'node:assert/strict';
for(const p of ['/data/home','/data/workspace'])mkdirSync(p,{recursive:true});
const token='offline-bootstrap-service-token-123456';
const child=spawn('/opt/runtime/node/bin/node',['/app/apps/server/src/managed-main.ts'],{cwd:'/data/workspace',env:{PATH:'/opt/runtime/node/bin:/usr/bin:/bin',HOME:'/data/home',PROXY_TOKEN:token,PROXY_DATA_DIR:'/data/state',PROXY_TLS_MODE:'reverse-proxy',PROXY_PORT:'8787'},stdio:['ignore','pipe','pipe']});
let logs='';for(const s of[child.stdout,child.stderr])s.on('data',b=>logs+=b);const exited=new Promise(r=>child.once('exit',r));
try{let ready;const end=Date.now()+30000;while(Date.now()<end){assert.equal(child.exitCode,null,'Supervisor exited: '+logs);try{const r=await fetch('http://127.0.0.1:8787/cc-managed/server/v1/status',{headers:{authorization:'Bearer '+token}});if(r.status===200){const s=await r.json();if(s.phase==='idle'){ready=s;break}}}catch{}await new Promise(r=>setTimeout(r,100))}
assert(ready,'Readiness timeout: '+logs);assert.equal(ready.current.build,4);assert.equal(ready.current.protocol,21);assert.equal(ready.current.appVersion,'0.3.7');assert.equal((await fetch('http://127.0.0.1:8787/health')).status,200);
child.kill('SIGTERM');assert.equal(await Promise.race([exited,new Promise((_,j)=>setTimeout(()=>j(Error('Shutdown timeout')),6000).unref())]),0);assert.equal(existsSync('/data/claude-was-invoked'),false);console.log('OFFLINE_PREFLIGHT_OK: Build 4 / protocol 21 / no Claude invocation');
}finally{if(child.exitCode===null)child.kill('SIGKILL')}
"""


def command(args, capture=False, timeout=180):
    return subprocess.run(args, check=True, text=True, capture_output=capture, timeout=timeout).stdout


def unpack(archive, target):
    if hashlib.sha256(archive.read_bytes()).hexdigest() != ARCHIVE_SHA256:
        raise RuntimeError("Archive SHA256 mismatch; nothing installed")
    with tarfile.open(archive, "r:gz") as bundle:
        members = bundle.getmembers()
        for member in members:
            path = PurePosixPath(member.name)
            if not member.isfile() or path.is_absolute() or ".." in path.parts:
                raise RuntimeError("Unexpected archive entry")
            dest = target / member.name
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(bundle.extractfile(member).read())
            dest.chmod(0o644)
    descriptor = json.loads((target / "SERVER-RELEASE.json").read_text())
    if (descriptor["build"], descriptor["protocol"], descriptor["sourceCommit"]) != (4, 21, SOURCE):
        raise RuntimeError("Unexpected candidate identity")
    for path, info in descriptor["files"].items():
        content = (target / path).read_bytes()
        if len(content) != info["size"] or hashlib.sha256(content).hexdigest() != info["sha256"]:
            raise RuntimeError("Candidate file mismatch: " + path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("Run with sudo on the confirmed ubuntu-cc host")
    current = json.loads(command(["docker", "inspect", CONTAINER], capture=True))[0]
    if current["Image"] != BASE or not current["State"]["Running"]:
        raise RuntimeError("The confirmed running container changed; stop and inspect first")
    runtime = "const f=require('fs'),c=require('crypto');console.log(JSON.stringify({node:process.versions.node,sdk:require('/app/node_modules/@anthropic-ai/claude-agent-sdk/package.json').version,cli:c.createHash('sha256').update(f.readFileSync('/opt/runtime/cli/bin/claude')).digest('hex')}))"
    found = json.loads(command(["docker", "exec", CONTAINER, "/opt/runtime/node/bin/node", "-e", runtime], capture=True))
    if found != {"node": "24.21.0", "sdk": "0.3.286", "cli": CLI_SHA256}:
        raise RuntimeError("Reviewed runtime/CLI identity differs; nothing installed")
    work = Path(tempfile.mkdtemp(prefix="cc-space-037-", dir="/var/tmp"))
    work.chmod(0o755)
    program = work / "program"
    program.mkdir(mode=0o755)
    unpack(args.archive.resolve(), program)
    base_tag = "cc-space-reviewed-base:365918cb8abf"
    command(["docker", "tag", BASE, base_tag])
    (work / "Dockerfile").write_text(
        "FROM " + base_tag + "\nUSER root\nCOPY --chown=root:root program/ /app/\n"
        "COPY --chown=root:root program/deploy/docker/entrypoint.sh /usr/local/bin/proxy-entrypoint\n"
        "RUN chmod 755 /usr/local/bin/proxy-entrypoint && chmod -R go-w /app\nUSER ccdesktunnel\n"
    )
    print("Building candidate only; existing container and /srv data are untouched", flush=True)
    command(["docker", "build", "--network=none", "--pull=false", "-t", IMAGE, str(work)], timeout=600)
    fixtures = work / "fixtures"
    policy = fixtures / "policy"
    policy.mkdir(parents=True, mode=0o755)
    fixtures.chmod(0o755)
    (policy / "managed-settings.json").write_bytes((program / "deploy/docker/managed-settings.json").read_bytes())
    (policy / "moderation-node.json").write_text(json.dumps({"endpoint": "https://example.invalid/cc-updates/v1/moderation/check", "nodeId": "offline", "token": "x" * 43}))
    for path in policy.iterdir():
        path.chmod(0o644)
    sentinel = fixtures / "claude"
    sentinel.write_text("#!/bin/sh\ntouch /data/claude-was-invoked\nexit 93\n")
    sentinel.chmod(0o755)
    smoke = fixtures / "smoke.mjs"
    smoke.write_text(SMOKE)
    smoke.chmod(0o644)
    command(["docker", "run", "--rm", "--network=none", "--read-only", "--memory=384m", "--cpus=0.5", "--pids-limit=128",
             "--tmpfs", "/tmp:rw,size=128m", "--tmpfs", "/data:rw,uid=1000,gid=1000,size=128m",
             "--mount", "type=bind,src=" + str(policy) + ",dst=/etc/claude-code,readonly",
             "--mount", "type=bind,src=" + str(sentinel) + ",dst=/opt/runtime/cli/bin/claude,readonly",
             "--mount", "type=bind,src=" + str(smoke) + ",dst=/smoke.mjs,readonly",
             "--user", "1000:1000", "--workdir", "/app", "--entrypoint", "/opt/runtime/node/bin/node", IMAGE, "/smoke.mjs"])
    after = json.loads(command(["docker", "inspect", CONTAINER], capture=True))[0]
    if after["Id"] != current["Id"] or not after["State"]["Running"]:
        raise RuntimeError("Original container changed during preparation")
    print(json.dumps({"phase": "prepared-only", "candidateImage": IMAGE, "workDirectory": str(work), "originalContainerRunning": True}))


if __name__ == "__main__":
    main()
