 
import asyncio
import hashlib
import difflib
import subprocess
import os
from pathlib import Path
import shutil
import tempfile
from fastapi import Request
from .storage import new_id, now
from .workbench import TEXT_LIMIT


def register_v22(app, auth, body):
    def result(w, **extra):
        return {"ok":True,"state":w.runtime.snapshot(),**extra}

    @app.post('/api/workspace/temporary-chats')
    async def create_temporary(request:Request):
        w=auth(request)
        r=w.runtime
        identifier=new_id()
        item={"id":identifier,"temporary":True,"projectId":None,"title":"临时聊天",
              "titleIsManual":True,"titleWasGenerated":True,"isPinned":False,"hasUnread":False,
              "createdAt":now(),"updatedAt":now(),"lastSentAt":None,"lastOpenedAt":None,
              "reasoning":r.capabilities.get('defaultReasoning','low'),"model":r.capabilities.get('model'),
              "draft":"","draftAssets":[],"messages":[],"pendingJobId":None,"pendingMessageId":None,
              "lastEventId":0,"threadId":None,"remoteConversationId":identifier}
        r.save_conversation(item)
        return result(w,conversation=item)

    @app.post('/api/workspace/temporary-chats/{identifier}/send')
    async def send_temporary(identifier, request:Request):
        w=auth(request)
        data=await body(request)
        item=w.runtime.conversation(identifier)
        if not item.get('temporary'):raise ValueError('不是临时聊天')
        reply=await w.runtime.send(identifier,data.get('text',''),data.get('assetIds',[]),None)
        return result(w,message=reply)

    @app.delete('/api/workspace/temporary-chats/{identifier}')
    async def delete_temporary(identifier, request:Request):
        w=auth(request)
        item=w.runtime.conversation(identifier)
        if not item.get('temporary'):raise ValueError('不是临时聊天')
        if w.runtime.is_busy(item):await w.runtime.stop_conversation(identifier)
        w.storage.remove('temporaryConversations',identifier)
        w.runtime.notify()
        return result(w)

    def save_text(w, data):
        reference={k:data[k] for k in ['fileId','projectId','path'] if k in data}
        file=w.read_file(reference)
        if file.get('kind')!='text':raise ValueError('此文件不支持文本编辑')
        target=Path(file['path'])
        if not os.access(target,os.W_OK):raise ValueError('此文件没有写入权限')
        value=data.get('text')
        if not isinstance(value,str):raise ValueError('编辑内容无效')
        raw=value.encode('gb18030' if file['encoding']=='GB18030' else 'utf-8')
        original=target.read_bytes()
        if file['encoding']=='UTF-8' and original.startswith(b'\xef\xbb\xbf'):raw=b'\xef\xbb\xbf'+raw
        if len(raw)>TEXT_LIMIT:raise ValueError('编辑内容超过文件大小上限')
        expected=data.get('contentHash')
        if not expected or hashlib.sha256(original).hexdigest()!=expected:
            raise ValueError('文件已被其他程序修改，请重新读取后再编辑')
        folder=w.storage.root/'file-edit-backups';folder.mkdir(exist_ok=True,mode=0o700)
        backup=folder/(new_id()+'-'+target.name)
        shutil.copy2(target,backup)
        fd, temporary=tempfile.mkstemp(prefix='.shiyan-edit-',dir=target.parent)
        try:
            with os.fdopen(fd,'wb') as handle:
                handle.write(raw);handle.flush();os.fsync(handle.fileno())
            os.chmod(temporary,target.stat().st_mode & 0o777)
            if hashlib.sha256(target.read_bytes()).hexdigest()!=expected:
                raise ValueError('保存前文件发生变化，编辑内容未覆盖原文件')
            os.replace(temporary,target)
        finally:
            Path(temporary).unlink(missing_ok=True)
        w.storage.put('fileEdits',{'id':new_id(),'path':str(target),'backupName':backup.name,'createdAt':now(),'encoding':file['encoding']})
        return {'file':w.read_file(reference),'backupPath':str(backup)}

    @app.post('/api/workspace/files/save-text')
    async def edit_file(request:Request):
        w=auth(request)
        data=await body(request)
        if data.get('confirmed') is not True:raise ValueError('请确认保存到原文件')
        return {'ok':True,**await asyncio.to_thread(save_text,w,data)}

    def changes(w, data):
        reference={k:data[k] for k in ['fileId','projectId','path'] if k in data}
        file=w.read_file(reference)
        if file.get('kind')!='text':raise ValueError('此文件不支持文本变更预览')
        target=Path(file['path'])
        edits=sorted((e for e in w.storage.list('fileEdits') if e.get('path')==str(target)),key=lambda e:e['createdAt'],reverse=True)
        before=None;source=''
        if edits:
            folder=(w.storage.root/'file-edit-backups').resolve()
            backup=(folder/edits[0]['backupName']).resolve()
            if backup.is_relative_to(folder) and backup.is_file():
                before=backup.read_bytes().decode('gb18030' if edits[0]['encoding']=='GB18030' else 'utf-8-sig');source='最近一次保存前'
        if before is None:
            try:
                root=subprocess.run(['git','-C',str(target.parent),'rev-parse','--show-toplevel'],capture_output=True,text=True,timeout=5)
                if root.returncode==0:
                    relative=target.relative_to(Path(root.stdout.strip()).resolve()).as_posix()
                    saved=subprocess.run(['git','-C',root.stdout.strip(),'show','HEAD:'+relative],capture_output=True,timeout=5)
                    if saved.returncode==0:before=saved.stdout.decode('gb18030' if file['encoding']=='GB18030' else 'utf-8-sig');source='Git HEAD'
                    else:
                        tracked=subprocess.run(['git','-C',root.stdout.strip(),'ls-files','--error-unmatch','--',relative],capture_output=True,timeout=5)
                        if tracked.returncode!=0 and not isinstance(data.get('baselineText'),str):before='';source='未跟踪文件'
            except (OSError,ValueError,UnicodeError,subprocess.TimeoutExpired):pass
        if before is None and isinstance(data.get('baselineText'),str) and len(data['baselineText'].encode('utf-8'))<=TEXT_LIMIT:
            before=data['baselineText'];source='打开文件时'
        if before is None:return {'name':file['name'],'available':False,'diff':'','source':'暂无保存记录或 Git 基准'}
        lines=list(difflib.unified_diff(before.splitlines(),file['text'].splitlines(),fromfile=source,tofile='当前文件',lineterm=''))
        if not lines and before!=file['text']:lines=['文件末尾换行已'+('添加' if file['text'].endswith('\n') else '移除')]
        return {'name':file['name'],'available':True,'source':source,'diff':'\n'.join(lines),'added':sum(x.startswith('+') and not x.startswith('+++') for x in lines),'removed':sum(x.startswith('-') and not x.startswith('---') for x in lines)}

    @app.post('/api/workspace/files/changes')
    async def file_changes(request:Request):
        w=auth(request);data=await body(request)
        return {'ok':True,'changes':await asyncio.to_thread(changes,w,data)}
