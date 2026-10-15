 
from pathlib import Path
import json,os,difflib,re
SKIP={'.git','node_modules','.venv','venv','__pycache__','inputs','.next','dist','build','qa','.runtime','.local-python','.bundled-python','.build','models','_backups'}
BINARY={'.png','.jpg','.jpeg','.webp','.gif','.ico','.heic','.pdf','.zip','.gz','.tar','.mp4','.mov','.woff','.woff2','.ttf','.sqlite3','.db','.pt','.pth','.safetensors'}
def snapshot(root):
    root=Path(root).resolve();files={};omitted=[];total=0;visited=0;truncated=False
    for folder,dirs,names in os.walk(root,followlinks=False):
        dirs[:]=sorted(d for d in dirs if d not in SKIP and not (Path(folder)/d).is_symlink())
        for name in sorted(names):
            visited+=1
            if visited>30000:truncated=True;break
            p=Path(folder)/name;rel=p.relative_to(root).as_posix()
            if p.is_symlink() or p.suffix.lower() in BINARY:continue
            try:
                size=p.stat().st_size
                if size>512*1024 or total+size>16*1024*1024:omitted.append(rel);continue
                data=p.read_bytes()
                if b'\0' in data:omitted.append(rel);continue
                text=data.decode('utf-8');files[rel]=text;total+=len(data)
            except (OSError,UnicodeError):omitted.append(rel)
        if truncated:break
    return {'root':str(root),'files':files,'omitted':omitted,'truncated':truncated}
def snapshot_path(storage,request_id):
    if not re.fullmatch(r'[A-Za-z0-9_-]{8,100}',str(request_id)):return None
    folder=storage.root/'file-change-snapshots';folder.mkdir(parents=True,exist_ok=True)
    return folder/(str(request_id)+'.json')
def begin_changes(storage,conversation,message):
    project=storage.get('projects',str(conversation.get('projectId') or ''))
    roots=list(conversation.get('fileChangeRoots') or [])
    if project:roots.append(project.get('path',''))
    roots=list(dict.fromkeys(str(Path(p).resolve()) for p in roots if isinstance(p,str) and Path(p).is_dir()))
    if not roots:return
    target=snapshot_path(storage,message.get('requestId'))
    if target is None:return
    data=json.loads(target.read_text()) if target.exists() else {'snapshots':[]}
    if 'snapshots' not in data:data={'snapshots':[data]}
    known={s['root'] for s in data['snapshots']}
    missing=[root for root in roots if root not in known]
    if not missing:return
    data['snapshots'].extend(snapshot(root) for root in missing)
    temp=target.with_suffix('.tmp')
    with temp.open('w',encoding='utf-8') as f:
        os.chmod(temp,0o600);json.dump(data,f,ensure_ascii=False)
    temp.replace(target)
def diff_record(path,before,after,kind='update'):
    lines=list(difflib.unified_diff(before.splitlines(),after.splitlines(),fromfile='a/'+path,tofile='b/'+path,lineterm=''))
    return {'path':path,'kind':kind,'available':True,'diff':'\n'.join(lines),'added':sum(l.startswith('+') and not l.startswith('+++') for l in lines),'removed':sum(l.startswith('-') and not l.startswith('---') for l in lines)}
def finish_changes(storage,message):
    target=snapshot_path(storage,message.get('requestId'))
    if target is None or not target.exists():return []
    try:
        data=json.loads(target.read_text());snapshots=data.get('snapshots',[data]);files=[];seen=set()
        for before in snapshots:
            root=Path(before['root'])
            if not root.is_dir():continue
            after=snapshot(root)
            for name in sorted(set(before['files'])|set(after['files'])):
                path=str(root/name)
                if any(part in SKIP for part in Path(name).parts[:-1]):continue
                if len(files)>=200:return files
                if path in seen or name in before['omitted'] or name in after['omitted']:continue
                if name not in before['files'] and before['truncated'] or name not in after['files'] and after['truncated']:continue
                old=before['files'].get(name,'');new=after['files'].get(name,'')
                if old==new and (name in before['files'])==(name in after['files']):continue
                record=diff_record(path,old,new,'add' if name not in before['files'] else 'delete' if name not in after['files'] else 'update')
                if record['diff']:files.append(record);seen.add(path)
        return files
    finally:target.unlink(missing_ok=True)
