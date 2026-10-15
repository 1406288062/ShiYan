import os,sys,json,asyncio,datetime
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
os.environ['SHIYAN_OFFLINE_TEST']='1'
from desktop_backend.storage import Storage,now,new_id
from desktop_backend.runtime import Runtime
from desktop_backend.api import create_app
from PIL import Image
import uvicorn
QA=Path((ROOT/'qa/reasoning-alignment-active.txt').read_text())/'fixture';QA.mkdir(parents=True,exist_ok=True)
data=QA/'data';store=Storage(data,ROOT)
fixture=QA/'fixture-project';fixture.mkdir(exist_ok=True)
(fixture/'hello.py').write_text('# 你好，拾燕\nmessage = "sample text"\nprint(message)\n')
(fixture/'nested/child').mkdir(parents=True,exist_ok=True)
(fixture/'nested/child/deep.py').write_text('print(123)\n')
(fixture/'many.txt').write_text('\n'.join('第 %d 行预览文字'%i for i in range(1000)))
if not store.list('history'):
 for i,(w,h) in enumerate([(200,180),(200,290),(180,200),(220,170),(180,260)]):
  import io
  b=io.BytesIO();Image.new('RGB',(w,h),[(230,240,250),(250,250,250),(210,180,150),(190,210,200),(230,180,190)][i]).save(b,format='PNG')
  a=store.save_bytes(b.getvalue(),f'fixture-{i}.png','image/png');store.add_history(a['id'],'QA fixture')
project_id=new_id();store.put('projects',{'id':project_id,'name':'codex','path':str(fixture),'createdAt':now()})
store.close()
raw=json.loads((ROOT/'qa/v22-model-list-verified.json').read_text())
models=[{'id':m['model'],'displayName':m['displayName'],'reasoningEfforts':[e['reasoningEffort'] for e in m['supportedReasoningEfforts']],'defaultReasoning':m['defaultReasoningEffort']} for m in raw['models']['data']]
original_init=Runtime.__init__
def init(self,*args,**kw):
 original_init(self,*args,**kw)
 self.capabilities={'model':'gpt-6-luna','models':models,'reasoningEfforts':models[3]['reasoningEfforts'],'defaultReasoning':models[3]['defaultReasoning'],'maxUploadImages':8}
 self.connection={'status':'ready','error':None}
 c=self.conversation(self.storage.setting('selectedConversationId'))
 if not c['messages']:
  started=now();completed=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(seconds=2)).isoformat().replace('+00:00','Z')
  c['messages']=[{'id':new_id(),'role':'user','text':'请检查这段测试消息，验证时间与复制编辑功能。','createdAt':started,'state':'completed','assets':[]},{'id':new_id(),'role':'assistant','text':'这是隔离测试回复。\n\n可以选择这段文字添加到对话，或编辑为新草稿。','createdAt':started,'requestStartedAt':started,'completedAt':completed,'state':'completed','assets':[]}]
  c['title']='恢复会话界面验收';c['projectId']=project_id;c['messages'][-1]['text']='这是一段用于验证输入框与输出内容对齐的测试文字。\n\n' + '| 目录 | 大小 | 说明 |\n| --- | --- | --- |\n' + ''.join('| ~/Library/Logs | 495 MB | 保留最近的日志与会话记录 |\n' for _ in range(28));c['messages'][-1]['text']='已调整图标并更新代码。';c['messages'][-1]['fileChanges']=[{'path':'tools/build_macos_app.py','available':True,'diff':'--- a/tools/build_macos_app.py\n+++ b/tools/build_macos_app.py\n@@ -1,2 +1,2 @@\n-old_icon = 3\n+new_icon = 6\n unchanged = True\n'},{'path':'web/assets/workbench-v2.js','available':True,'diff':'--- a/web/assets/workbench-v2.js\n+++ b/web/assets/workbench-v2.js\n@@ -10,3 +10,3 @@\n const icons = {\n- expand: "old",\n- contract: "old"\n+ expand: "near",\n+ contract: "near"\n'}];self.save_conversation(c)
 self.spawn(self.expire_temporaries())
Runtime.__init__=init
async def fixture_agent(self,identifier):
 c,m=self.pending_message(identifier)
 await asyncio.sleep(.35)
 c,m=self.pending_message(identifier)
 if m:
  m.update(text='隔离测试完成',state='completed',completedAt=now(),phase='');c.update(pendingMessageId=None,pendingJobId=None);self.save_conversation(c)
Runtime.run_agent=fixture_agent
app=create_app(data,ROOT)
import socket
sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
(QA/'run.json').write_text(json.dumps({'url':f'http://127.0.0.1:{port}/','fixtureProject':str(fixture),'projectId':project_id}))
uvicorn.run(app,log_level='warning',host='127.0.0.1',port=port,fd=sock.fileno())
