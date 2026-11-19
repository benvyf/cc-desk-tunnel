"""Signed-agent adapter for a narrowly verified Build31 memory runtime.

It executes the publisher's unchanged signed image runner. Native hashes,
source validation, cold backups, image checks, admission and rollback stay on.
Unknown mount profiles or changed runtime dependencies are refused.
"""
import copy,hashlib,importlib.util,json,os
from pathlib import Path
import subprocess,sys,types

CLI_SHA='0dc4f4a9a165fc60746d7ae8489712e5fc352f1e7ad4eb22e7141bd0812eb0cf'
NODE_SHA='904a6d3484241d466989f9df9ba3aab822b1496191bdb28230eb491a55c32a52'
LOCK_SHA='a884b488d89edb4075a507ce49955ea009cc20378555f9d07bcad865469c3bde'
PROFILES={
 'ubuntu-cc':{'/opt/runtime/cli/bin/claude':'/run/cc-first-build31-runtime/claude','/opt/runtime/node/bin/node':'/run/cc-first-build31-runtime/node','/app/node_modules':'/run/cc-first-build31-dependencies','/opt/runtime/terminal-integrity.json':'/run/cc-first-build31-dependencies/.terminal-integrity.json','/usr/libexec/gcc/x86_64-linux-gnu/13/cc1plus':'/run/cc-first-build31-system/cc1plus'},
 'ubuntu-cc-04':{'/opt/runtime/cli/bin/claude':'/run/cc-build31-runtime/claude','/opt/runtime/node/bin/node':'/run/cc-build31-runtime/node'},
}

def sha(path):
    with Path(path).open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()

def normalized(original,node):
    profile=PROFILES.get(node,{})
    value=copy.deepcopy(original)
    extras=[x for x in value.get('Mounts',[]) if x['Destination'] not in ['/data','/etc/claude-code']]
    if not extras:return value,[]
    assert node in PROFILES,'Unrecognized memory-runtime node'
    by_dest={x['Destination']:x for x in extras}
    assert len(by_dest)==len(extras)
    assert {'/opt/runtime/cli/bin/claude','/opt/runtime/node/bin/node'}.issubset(by_dest)
    for destination,mount in by_dest.items():
        assert destination in profile and mount['Source']==profile[destination],'Unrecognized runtime bind'
        assert mount['Type']=='bind' and mount['RW'] is False,'Runtime binds must be read-only'
    value['Mounts']=[x for x in value['Mounts'] if x not in extras]
    value['HostConfig']['Binds']=[x for x in (value['HostConfig'].get('Binds') or []) if x.split(':')[1] not in by_dest]
    return value,extras

def verify_sources(extra):
    for mount in extra:
        path=Path(mount['Source'])
        for entry in [path,*path.parents]:
            st=entry.lstat();assert not entry.is_symlink() and st.st_uid==0 and not st.st_mode&0o022
            if entry==Path('/run'):break
        info=subprocess.check_output(['findmnt','-n','-o','FSTYPE,OPTIONS','--target',str(path)],text=True).split()
        assert info[0]=='tmpfs' and {'ro','noswap'}.issubset(info[1].split(','))
        if mount['Destination']=='/opt/runtime/cli/bin/claude':assert sha(path)==CLI_SHA
        elif mount['Destination']=='/opt/runtime/node/bin/node':assert sha(path)==NODE_SHA
        elif mount['Destination']=='/app/node_modules':
            manifest=json.loads((path/'.verified-manifest.json').read_text())
            assert manifest['profileSha256']=='1f76713867e6e30ae4495bfcad81760525dc99efe577a89493fbc11de97046ae'
            for rel,h in manifest['files'].items():
                target=path/rel;assert not target.is_symlink() and sha(target)==h
            for rel,target in manifest['links'].items():assert os.readlink(path/rel)==target
        elif mount['Destination']=='/opt/runtime/terminal-integrity.json':
            parent=path.parent
            manifest=json.loads((parent/'.verified-manifest.json').read_text())
            assert sha(path)==manifest['files']['.terminal-integrity.json']
        else:
            assert sha(path)=='840b332fb62ec6f694ac77d91fe69ef7f80b0d69512ed89374af0ee7a506255d'

def run(runner,arguments,preflight=False):
    assert os.geteuid()==0
    runner=Path(runner);assert runner.is_absolute() and runner==runner.resolve()
    assert runner.parts[-3:]==('deploy','host-update','apply.py')
    program=runner.parents[2]
    descriptor=json.loads((program/'SERVER-RELEASE.json').read_text())
    assert sha(runner)==descriptor['files']['deploy/host-update/apply.py']['sha256']
    spec=importlib.util.spec_from_file_location('authenticated_image_runner',runner);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
    configuration=json.loads(Path('/var/lib/cc-host-updater/config.json').read_text());node=configuration['nodeId']
    engine_module=m.load('runtime_adapter_inspect',program/'apps/update-service/web/server-bootstrap.py')
    review=m.load('runtime_adapter_review',program/'scripts/upgrade-message-review.py')
    name=m.selected_container(engine_module,review,node,configuration)
    original=engine_module.Engine().request('GET','/containers/'+name+'/json')
    _,extra=normalized(original,node)
    if not extra:
        sys.argv=[str(runner),*arguments];m.main();return
    verify_sources(extra)
    assert m.CLI==CLI_SHA and m.NODE_VERSION=='24.22.2' and m.LOCK==LOCK_SHA, 'This signed release changes the native/dependency runtime; a new verified runtime profile is required'
    candidate_images=set()
    original_load=m.load
    def adapted_run(command,*a,**kw):
        command=list(command)
        matches=[x for x in candidate_images if x in command]
        if command[:2]==['docker','run'] and matches:
            image=matches[0]
            for mount in extra:
                destination=mount['Destination']
                if not any('dst='+destination in str(x) for x in command):
                    index=command.index(image);command[index:index]=['--mount','type=bind,src='+mount['Source']+',dst='+destination+',readonly']
        return subprocess.run(command,*a,**kw)
    process_adapter=types.SimpleNamespace(**{**vars(subprocess),'run':adapted_run})
    def adapted_load(name,path):
        module=original_load(name,path)
        if Path(path).name=='server-bootstrap.py':
            validate=module.validate_runtime
            def validate_runtime(current):
                normal,found=normalized(current,node)
                assert {x['Destination']:x['Source'] for x in found}=={x['Destination']:x['Source'] for x in extra}
                verify_sources(found);validate(normal)
            module.validate_runtime=validate_runtime
        if hasattr(module,'subprocess'):module.subprocess=process_adapter
        return module
    m.load=adapted_load;m.subprocess=process_adapter
    check=m.candidate_check
    def candidate_check(image,release):
        verify_sources(extra);candidate_images.add(image);return check(image,release)
    m.candidate_check=candidate_check
    if preflight:
        info=json.loads(subprocess.check_output(['docker','inspect',name]))[0]
        tested=adapted_load('adapter_bootstrap_test',program/'apps/update-service/web/server-bootstrap.py')
        review.adapt(tested,info);tested.validate_runtime(info)
        release=json.loads(Path(arguments[arguments.index('--release')+1]).read_text())
        assert release['descriptorSha256']==sha(program/'SERVER-RELEASE.json')
        candidate_check(info['Image'],release)
        print('Signed adapter preflight passed: mounted native/dependency verification, unchanged candidate assertions',flush=True)
        return
    sys.argv=[str(runner),*arguments]
    print('Using signed-agent support for verified read-only memory runtime; original image checks remain enabled',flush=True)
    m.main()

if __name__=='__main__':
    if len(sys.argv)<3:raise RuntimeError('Expected authenticated signed image runner and release arguments')
    values=sys.argv[2:];preflight='--adapter-preflight' in values
    if preflight:values.remove('--adapter-preflight')
    run(sys.argv[1],values,preflight)
