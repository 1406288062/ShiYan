 
 
 
from __future__ import annotations
import asyncio, hashlib, hmac, os, plistlib, time
from pathlib import Path
from urllib.parse import urlsplit
from fastapi import HTTPException, Request
from .workbench import valid_name

EDITOR_IDS = {
 'com.microsoft.VSCode','com.microsoft.VSCodeInsiders','com.todesktop.230313mzl4w4u92',
 'com.exafunction.windsurf','dev.zed.Zed','com.sublimetext.4','com.sublimetext.3',
 'com.apple.dt.Xcode','com.jetbrains.intellij','com.jetbrains.intellij.ce',
 'com.jetbrains.pycharm','com.jetbrains.pycharm.ce','com.jetbrains.WebStorm',
 'com.jetbrains.goland','com.jetbrains.clion','com.apple.TextEdit','com.barebones.bbedit','com.panic.Nova'
}

def editor_registry():
 result={}
 for root in [Path('/Applications'),Path.home()/'Applications',Path('/System/Applications')]:
  if not root.is_dir():continue
  candidates=[]
  for p in root.iterdir():
   if p.suffix=='.app':candidates.append(p)
   elif p.is_dir() and not p.is_symlink() and not p.name.startswith('.'):
    try:candidates.extend(p.glob('*.app'))
    except OSError:pass
  for app in candidates:
   try:
    with (app/'Contents/Info.plist').open('rb') as h:info=plistlib.load(h)
    bid=info.get('CFBundleIdentifier','');exe=info.get('CFBundleExecutable')
    if bid not in EDITOR_IDS or not exe or not os.access(app/'Contents/MacOS'/exe,os.X_OK):continue
    key=hashlib.sha256(str(app.resolve()).encode()).hexdigest()[:24]
    result[key]={'id':key,'name':app.stem,'bundleId':bid,'path':str(app.resolve())}
   except (OSError,ValueError,plistlib.InvalidFileException):continue
 return result

def file_target(work,data):
 if data.get('fileId'):
  entry=work.storage.get('workspaceFiles',str(data['fileId']))
  if not entry:raise HTTPException(404,'文件授权不存在，请重新选择文件')
  path=Path(entry['path']).resolve()
  if entry.get('projectId'):
   _,root=work.project(entry['projectId'])
   if not path.is_relative_to(root):raise HTTPException(403,'文件已移出项目')
 else:path,_=work.resolve(data.get('projectId'),data.get('path'))
 if not path.is_file():raise ValueError('文件不存在或不是普通文件')
 return path

def directory_details(work,project_id,relative,offset=0,limit=100):
 folder,root=work.resolve(project_id,relative)
 if not folder.is_dir():raise ValueError('目录不存在')
 offset=max(0,int(offset));limit=max(1,min(200,int(limit)));entries=[]
 with os.scandir(folder) as scan:
  for item in scan:
   try:
    target=Path(item.path);safe=target.resolve().is_relative_to(root);info=item.stat(follow_symlinks=False)
    entries.append({'name':item.name,'path':str(target.relative_to(root)),
      'directory':item.is_dir(follow_symlinks=True) if safe else False,'blocked':not safe,
      'symlink':item.is_symlink(),'bytes':info.st_size,'modifiedAt':info.st_mtime})
   except OSError:continue
 entries.sort(key=lambda v:(not v['directory'],v['name'].casefold()))
 return {'path':str(folder.relative_to(root)),'absolutePath':str(folder),'name':folder.name,
  'total':len(entries),'modifiedAt':folder.stat().st_mtime,'offset':offset,
  'entries':entries[offset:offset+limit],'nextOffset':offset+limit if offset+limit<len(entries) else None}

def search_files(work,project_id,query):
 _,root=work.project(project_id);query=str(query or '').strip().casefold()
 if not query or len(query)>160:return {'entries':[],'truncated':False,'searched':0}
 excluded={'.git','node_modules','.venv','__pycache__','build','dist','.Trash','.cache'}
 entries=[];searched=0;truncated=False;deadline=time.monotonic()+2.5
 for parent,folders,names in os.walk(root,followlinks=False):
  folders[:]=[d for d in folders if d not in excluded and not (Path(parent)/d).is_symlink()]
  for name in folders+names:
   searched+=1
   if searched>40000 or time.monotonic()>deadline:truncated=True;break
   path=Path(parent)/name;relative=str(path.relative_to(root))
   if query not in relative.casefold():continue
   try:
    safe=path.resolve().is_relative_to(root)
    entries.append({'name':name,'path':relative,'directory':path.is_dir() if safe else False,'blocked':not safe,'symlink':path.is_symlink()})
   except OSError:continue
   if len(entries)>=300:truncated=True;break
  if truncated:break
 entries.sort(key=lambda e:(not e['directory'],e['path'].casefold()))
 return {'entries':entries,'truncated':truncated,'searched':searched,'omittedGeneratedFolders':sorted(excluded)}

def register_v2(app):
 def auth(request):
  port=request.scope.get('server',(None,None))[1];allowed={f'127.0.0.1:{port}',f'localhost:{port}'}
  if request.headers.get('host','').lower() not in allowed:raise HTTPException(403,'本地地址无效')
  origin=request.headers.get('origin')
  if origin:
   p=urlsplit(origin)
   if p.scheme!='http' or p.netloc.lower() not in allowed:raise HTTPException(403,'不允许跨站工作区访问')
  if request.headers.get('sec-fetch-site')=='cross-site':raise HTTPException(403,'不允许跨站工作区访问')
  work=request.app.state.workbench
  if not hmac.compare_digest(request.headers.get('x-shiyan-workspace',''),work.token):raise HTTPException(403,'工作区授权已失效')
  return work
 async def body(request):
  try:data=await request.json()
  except ValueError as exc:raise ValueError('请求格式无效') from exc
  if not isinstance(data,dict):raise ValueError('请求应为 JSON 对象')
  return data
 @app.get('/api/workspace/directory-details')
 async def details(request:Request,projectId:str,path:str='',offset:int=0):
  return {'ok':True,**await asyncio.to_thread(directory_details,auth(request),projectId,path,offset)}
 @app.get('/api/workspace/files/search')
 async def search(request:Request,projectId:str,q:str=''):
  return {'ok':True,**await asyncio.to_thread(search_files,auth(request),projectId,q)}
 @app.get('/api/workspace/editors')
 async def editors(request:Request):
  auth(request);registry=await asyncio.to_thread(editor_registry)
  items=[{k:v for k,v in a.items() if k!='path'} for a in registry.values()]
  items.sort(key=lambda a:(a['bundleId']=='com.apple.TextEdit',a['name'].casefold()))
  return {'ok':True,'editors':items}
 @app.patch('/api/workspace/projects/{identifier}')
 async def update_project(identifier:str,request:Request):
  work=auth(request);data=await body(request)
  if not data or not set(data).issubset({'name','isPinned'}):
   raise ValueError('只能修改项目名称或置顶状态')
  project=work.storage.get('projects',identifier)
  if not project:raise HTTPException(404,'项目不存在')
  if 'name' in data:
   name=valid_name(data['name'])
   for item in work.storage.list('projects'):
    if item['id']!=identifier and item.get('name','').casefold()==name.casefold():
     raise ValueError('已有同名项目')
   project['name']=name
  if 'isPinned' in data:
   if not isinstance(data['isPinned'],bool):raise ValueError('置顶状态无效')
   project['isPinned']=data['isPinned']
  work.storage.put('projects',project)
  work.runtime.notify()
  return {'ok':True,'project':project,'projects':work.storage.list('projects')}
 @app.delete('/api/workspace/projects/{identifier}')
 async def unlink_project(identifier:str,request:Request):
  work=auth(request);project=work.storage.get('projects',identifier)
  if not project:raise HTTPException(404,'项目不存在')
   
   
  affected=0
  for conv in work.storage.list('conversations'):
   if conv.get('projectId')==identifier:
    conv['projectId']=None
    work.storage.put('conversations',conv)
    affected+=1
  work.storage.remove('projects',identifier)
  preferences=work.preferences()
  if preferences.get('selectedProjectId')==identifier:
   preferences['selectedProjectId']=None
   
  for tab in preferences.get('tabs',[]):
   if tab.get('projectId')==identifier:
    tab.pop('projectId',None)
  work.storage.set_setting('workspace',preferences)
  work.runtime.notify()
  return {'ok':True,'removedProjectId':identifier,'detachedConversations':affected,
          'projects':work.storage.list('projects'),'state':work.runtime.snapshot()}
 @app.post('/api/workspace/files/open-editor')
 async def open_editor(request:Request):
  work=auth(request);data=await body(request);target=await asyncio.to_thread(file_target,work,data)
  registry=await asyncio.to_thread(editor_registry);editor=registry.get(str(data.get('editorId','')))
  if not editor:raise ValueError('编辑器不存在或已移除，请重新选择')
  proc=await asyncio.create_subprocess_exec('/usr/bin/open','-a',editor['path'],str(target),stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
  try:_,error=await asyncio.wait_for(proc.communicate(),15)
  except asyncio.TimeoutError:
   proc.kill();await proc.wait();raise ValueError('打开编辑器超时')
  if proc.returncode:raise ValueError('编辑器未能打开文件：'+error.decode(errors='replace')[:300])
  return {'ok':True,'editor':editor['name'],'filename':target.name}
