 
(() => {
  'use strict';
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const limit = (v, n=4000) => String(v ?? '').slice(0,n);
  const allowed = new Set(['reasoning','command_execution','mcp_tool_call','todo_list','web_search','file_change','collab_tool_call','image_generation','error']);
  function safeURL(value, image=false) {
    try { const u=new URL(String(value),location.href);return (image?['http:','https:']:['http:','https:','mailto:']).includes(u.protocol)?u.href:''; } catch { return ''; }
  }
  function generatedFileLink(value) {
    return /^(?:sandbox:|\/Users\/|\/home\/|\/mnt\/data\/|\/?outputs\/|\/?artifacts\/)/.test(String(value||''));
  }
  const generatedDocuments=new Set(['doc','docx','docm','dot','dotx','dotm','rtf','odt','pdf','xls','xlsx','xlsm','xlsb','xlt','xltx','xltm','csv','ods','ppt','pptx','pptm','pot','potx','potm','pps','ppsx','ppsm','odp','pages','numbers']);
  const generatedImages=new Set(['png','jpg','jpeg','webp','gif','heic','heif','tif','tiff','bmp','avif','svg']);
  function generatedAssetVisible(asset) {
    if(!asset||typeof asset.filename!=='string')return false;
    const parts=asset.filename.replace(/\\/g,'/').split('/');
    if(parts.some(part=>part.startsWith('.')||['inputs','node_modules','__pycache__'].includes(part.toLowerCase())))return false;
    const extension=parts.at(-1).split('.').at(-1).toLowerCase();
    return generatedDocuments.has(extension)||generatedImages.has(extension);
  }
  function generatedDocumentVisible(asset) {
    return generatedAssetVisible(asset)&&!(asset.mimeType||'').startsWith('image/')&&generatedDocuments.has(asset.filename.split('.').at(-1).toLowerCase());
  }
  const parsers=new Map();
  function getParser(prose=false) {
    if(!window.markdownit)return;
    if(parsers.has(prose))return parsers.get(prose);
    const parser=window.markdownit({html:false,linkify:true,breaks:true,typographer:false});
    if(prose){
      parser.disable('code');
      // Email HTML often leaves layout-sized runs of non-breaking spaces.
      // Normalize text tokens only: fenced code, URLs and Markdown structure stay intact.
      parser.core.ruler.after('text_join','shiyan-prose-spacing',state=>{
        for(const block of state.tokens){
          if(block.type!=='inline'||!block.children)continue;
          block.children=block.children.flatMap(token=>{
            if(token.type!=='text')return [token];
            const parts=token.content.replace(/[ \t\u00a0\u3000]{4,}/g,'\n').split('\n');
            const result=[];
            parts.forEach((part,index)=>{
              if(index)result.push(new state.Token('softbreak','br',0));
              const text=new state.Token('text','',0);
              text.content=part.replace(/[ \t\u00a0\u3000]+/g,' ');
              if(index)text.content=text.content.trimStart();
              if(index<parts.length-1)text.content=text.content.trimEnd();
              if(text.content)result.push(text);
            });
            return result;
          });
        }
      });
    }
    parsers.set(prose,parser);
    parser.validateLink=href=>generatedFileLink(href)||!!safeURL(href);
    const link=parser.renderer.rules.link_open || ((t,i,o,e,s)=>s.renderToken(t,i,o));
    parser.renderer.rules.link_open=(tokens,index,options,env,self)=>{
      const t=tokens[index],raw=t.attrGet('href');
      if(generatedFileLink(raw)){t.attrSet('data-generated-file',raw);t.attrSet('href','#');}
      else {
        const href=safeURL(raw),next=tokens[index+1];
        t.attrSet('href',href||'#');t.attrSet('target','_blank');t.attrSet('rel','noopener noreferrer');
        if(href){
          t.attrJoin('class','message-reference');t.attrSet('title',href);
          if(next?.type==='text' && tokens[index+2]?.type==='link_close'){
            const label=next.content;
            if(/^(?:https?:\/\/|www\.)/i.test(label)){
              const url=new URL(href),path=url.pathname.split('/').filter(Boolean)[0];
              next.content=url.hostname.replace(/^www\./,'')+(path?' / '+(path.length>24?path.slice(0,23)+'…':path):'');
            }
          }
        }
      }
      return link(tokens,index,options,env,self);
    };
    parser.renderer.rules.image=(tokens,index,options,env,self)=>{
      const t=tokens[index],src=safeURL(t.attrGet('src'),true),alt=self.renderInlineAsText(t.children||[],options,env);
      if(!src)return esc(alt);
      return '<img src="'+esc(src)+'" alt="'+esc(alt)+'" loading="lazy" decoding="async">';
    };
    function code(tokens,index,options,env) {
      const t=tokens[index],source=t.content,label=limit((t.info||'').trim().split(/\s+/)[0]||'代码',40);
      return '<section class="code-block"><div class="code-header"><span>'+esc(label)+'</span><button type="button" data-copy-code="'+esc(source)+'" aria-label="复制代码">'+(env.copyIcon||'')+'<span>复制</span></button></div><pre><code>'+esc(source)+'</code></pre></section>';
    }
    parser.renderer.rules.fence=code;parser.renderer.rules.code_block=code;
    parser.renderer.rules.table_open=()=>'<div class="table-scroll"><table>';
    parser.renderer.rules.table_close=()=>'</table></div>';
    parser.core.ruler.after('inline','shiyan-task-list',state=>{
      for(let i=2;i<state.tokens.length;i++){
        const t=state.tokens[i],first=t.children?.[0];
        if(t.type!=='inline'||state.tokens[i-1].type!=='paragraph_open'||state.tokens[i-2].type!=='list_item_open'||first?.type!=='text')continue;
        const match=first.content.match(/^\[([ xX])\]\s+/);if(!match)continue;
        first.content=first.content.slice(match[0].length);
        const checkbox=new state.Token('html_inline','',0);checkbox.content='<input class="markdown-task-check" type="checkbox" disabled'+(match[1].toLowerCase()==='x'?' checked':'')+' aria-label="'+(match[1].toLowerCase()==='x'?'已完成':'未完成')+'">';
        t.children.unshift(checkbox);state.tokens[i-2].attrJoin('class','markdown-task-item');
      }
    });
    return parser;
  }
  function markdown(text,copyIcon='',{prose=false}={}) {
    const p=getParser(prose);return p?p.render(String(text??''),{copyIcon}):'<p>'+esc(text).replace(/\n/g,'<br>')+'</p>';
  }
  function itemsFor(message) {
    if(Array.isArray(message.displayItems))return message.displayItems.filter(i=>i&&allowed.has(i.type)).slice(-60);
    let raw=message.rawResult;
    if(typeof raw==='string'){if(raw.length>1000000)return [];try{raw=JSON.parse(raw);}catch{return [];}}
    return (Array.isArray(raw)?raw:[]).filter(i=>i&&allowed.has(i.type)).slice(-60);
  }
  function status(item) {
    const failed=item.type==='error'||item.status==='failed'||!!item.error||item.result?.isError===true||(item.type==='command_execution'&&Number.isFinite(item.exit_code)&&item.exit_code!==0);
    if(failed)return {key:'failed',label:'失败'};
    if(['cancelled','canceled','interrupted'].includes(item.status))return {key:'cancelled',label:'已停止'};
    if(['in_progress','running','started'].includes(item.status))return {key:'running',label:'进行中'};
    if(item.status==='completed')return {key:'completed',label:'已完成'};
    return {key:'recorded',label:'已记录'};
  }
  function output(text,label) {
    if(!text)return '';const raw=String(text);
    return '<div class="output-log-label">'+esc(label)+'</div><pre class="output-log">'+esc(limit(raw))+'</pre>'+(raw.length>4000?'<p class="output-truncated">较长输出已显示前 4000 个字符</p>':'');
  }
  function toolText(item) {
    if(typeof item.result_text==='string')return item.result_text;
    const content=item.result?.content;
    return Array.isArray(content)?content.filter(c=>c?.type==='text'&&typeof c.text==='string').map(c=>c.text).join('\n'):'';
  }
  // 每一步用一句话说明在做什么（按命令 / 工具推断，推断不出就不写）。
  function commandPurpose(command){
    let c=String(command||'').trim();
    const wrapped=c.match(/^(?:\/bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/);if(wrapped)c=wrapped[2];
    c=c.replace(/^(?:cd\s+\S+\s*&&\s*)+/,'').trim();
    const rules=[
      [/^(rg|grep|ag|git\s+grep)\b/,'在代码里搜索'],[/^(ls|tree|find|fd)\b/,'查看目录和文件'],[/^(cat|head|tail|less|nl|wc|sed\s+-n)\b/,'读取文件内容'],
      [/^git\s+(status|diff|log|show|blame)\b/,'查看代码改动和历史'],[/^git\s+(add|commit)\b/,'提交改动'],[/^git\s+push\b/,'推送到远端仓库'],[/^git\s+(pull|fetch|clone|checkout|switch|merge|rebase)\b/,'同步代码'],
      [/^(npm|pnpm|yarn|bun)\s+(i|install|add|ci)\b|^pip3?\s+install\b|^brew\s+install\b/,'安装依赖'],
      [/\b(test|pytest|vitest|jest|--test)\b/,'运行测试'],[/^(npm|pnpm|yarn)\s+run\s+build\b|^xcodebuild\b|^make\b|^cargo\s+build\b|^tsc\b/,'构建项目'],
      [/^(curl|wget|http)\b/,'请求网络地址'],[/^(mkdir|cp|mv|rm|touch|ln|chmod)\b/,'整理文件'],[/^apply_patch\b|^(cat|tee)\b.*>\s*\S/,'写入文件'],
      [/^(python3?|node|deno|ruby|bash|sh)\b/,'运行脚本'],[/^(systemctl|launchctl|service)\b/,'管理系统服务'],[/^(ps|top|df|du|free|uptime|lsof|netstat|ss)\b/,'查看系统状态'],[/^(open|osascript)\b/,'打开应用或文件'],
    ];
    for(const [re,text] of rules)if(re.test(c))return text;
    return '';
  }
  function toolPurpose(item){
    const server=String(item.server||'').toLowerCase(),tool=String(item.tool||'').toLowerCase();
    if(server==='shiyan-input')return '向你确认信息';
    if(/memory/.test(server+tool))return '读取或更新记忆';
    if(/fetch|browser|web/.test(server)||/fetch|navigate|browse/.test(tool))return '读取网页内容';
    if(/sponge|device|remote/.test(server))return '访问你的设备';
    if(/file|fs/.test(server)||/read_file|write_file|list_dir/.test(tool))return '读写文件';
    if(/search/.test(tool))return '搜索资料';
    return '';
  }
  function purposeHTML(text){return text?'<p class="output-purpose">'+esc(text)+'</p>':'';}
  function itemHTML(item) {
    const s=status(item);let label='',body='';
    if(item.type==='reasoning'){
      const text=String(item.text||'').trim();
      return text?'<section class="output-item output-reasoning" data-output-id="'+esc(item.id||'')+'"><header><span>思考</span></header><p class="output-thought">'+esc(limit(text,8000))+'</p></section>':'';
    }
    if(item.type==='command_execution'){
      label='终端命令';body=purposeHTML(commandPurpose(item.command))+'<pre class="output-command"><code>'+esc(limit(item.command,1000))+'</code></pre>'+output(item.aggregated_output,'输出');
      if(Number.isFinite(item.exit_code))body+='<p class="output-exit">退出码 '+esc(item.exit_code)+'</p>';
    }else if(item.type==='mcp_tool_call'){
      label=[limit(item.server,100),limit(item.tool,100)].filter(Boolean).join(' · ')||'工具调用';
      body=purposeHTML(toolPurpose(item))+output(toolText(item),'工具结果');
      if(item.error)body+='<p class="output-error">'+esc(limit(typeof item.error==='string'?item.error:item.error.message||'工具调用失败'))+'</p>';
    }else if(item.type==='todo_list'){
      label='执行计划';const rows=(Array.isArray(item.items)?item.items:[]).slice(0,50);s.label=rows.filter(t=>t.completed).length+'/'+rows.length+' 已完成';
      body='<ul class="output-plan">'+rows.map(t=>'<li'+(t.completed?' class="is-done"':'')+'><input type="checkbox" disabled'+(t.completed?' checked':'')+' aria-label="'+(t.completed?'已完成':'未完成')+'"><span>'+esc(limit(t.text,1000))+'</span></li>').join('')+'</ul>';
    }else if(item.type==='file_change'){
      label='文件修改';body=purposeHTML('修改了 '+(Array.isArray(item.changes)?item.changes.length:0)+' 个文件')+'<ul class="output-files">'+(Array.isArray(item.changes)?item.changes:[]).slice(0,50).map(f=>'<li><span>'+esc(limit(f.path,1000))+'</span><small>'+esc(({add:'新增',delete:'删除',update:'修改'})[f.kind]||limit(f.kind,40))+'</small></li>').join('')+'</ul>';
    }else if(item.type==='web_search'){
      label='搜索网页';body='<p class="output-query">'+esc(limit(item.query,1000))+'</p>';
    }else if(item.type==='collab_tool_call'){
      const count=item.agents_count??item.count??item.receiver_thread_ids?.length;label='协作任务';body='<p class="output-query">'+esc(limit(item.tool,100))+(Number.isFinite(count)?' · '+esc(count)+' 个任务':'')+'</p>';
    }else if(item.type==='image_generation'){
      label='生成图片';
    }else if(item.type==='error'){
      label='执行错误';body='<p class="output-error">'+esc(limit(item.message||'执行时发生错误'))+'</p>';
    }
    return '<section class="output-item" data-output-id="'+esc(item.id||'')+'" data-output-status="'+s.key+'"><header><span>'+esc(label)+'</span><small>'+s.label+'</small></header>'+body+'</section>';
  }
  function executionStats(message) {
    const stored=message.executionStats;
    if(stored&&['total','success','failed','pending'].every(k=>Number.isSafeInteger(stored[k])&&stored[k]>=0)&&stored.total===stored.success+stored.failed+stored.pending)return {total:stored.total,success:stored.success,failed:stored.failed,pending:stored.pending};
    let raw=message.rawResult;
    if(typeof raw==='string'&&raw.length<=16000000){try{raw=JSON.parse(raw);}catch{raw=null;}}
    const projected=new Map((message.displayItems||[]).map(item=>[item.id,item]));
    const source=Array.isArray(raw)?raw.map(item=>item&&typeof item==='object'?{...projected.get(item.id),...item,status:item.status||projected.get(item.id)?.status}:item):Array.isArray(message.displayItems)?message.displayItems:[];
    const byID=new Map();let anonymous=0;
    for(const item of source){if(!item||!['command_execution','mcp_tool_call','web_search','file_change','collab_tool_call','image_generation'].includes(item.type))continue;byID.set(item.id||'anonymous:'+anonymous++,item);}
    const value={total:byID.size,success:0,failed:0,pending:0};
    for(const item of byID.values()){
      const kind=status(item).key;
      if(kind==='failed')value.failed++;
      else if(kind==='completed'||['succeeded','success'].includes(item.status)||(item.type==='command_execution'&&item.exit_code===0))value.success++;
      else value.pending++;
    }
    return value;
  }
  // —— 执行过程：时间线 + 思考链（2026-10-30） ——
  const glyphs={
    reasoning:'M12 3.5l1.7 4.4 4.4 1.7-4.4 1.7L12 15.7l-1.7-4.4L5.9 9.6l4.4-1.7zM18.5 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z',
    command_execution:'M5 7l4.5 4.5L5 16M12 17h7',
    web_search:'M10.5 4.5a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM15 15l4.5 4.5',
    mcp_tool_call:'M9 3.5v4M15 3.5v4M7 7.5h10v3.5a5 5 0 0 1-10 0zM12 16v4.5',
    todo_list:'M10 6.5h10M10 12h10M10 17.5h10M4 6.5l1.2 1.2L7.5 5.3M4 12l1.2 1.2 2.3-2.4M4 17.5l1.2 1.2 2.3-2.4',
    file_change:'M7 3.5h7l4.5 4.5v12.5H7zM14 3.5V8h4.5',
    collab_tool_call:'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3.5 19.5c0-3 2.5-5 5.5-5s5.5 2 5.5 5M16 5.2a3 3 0 0 1 0 5.6M17.5 14.6c1.8.6 3 2.4 3 4.9',
    image_generation:'M4.5 5.5h15v13h-15zM4.5 15l4-4 4 4 2.5-2.5 4.5 4.5M15.5 9.5h.01',
    error:'M12 9v4M12 16.5h.01M12 4l8.5 15h-17z'
  };
  const glyph=type=>'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="'+(glyphs[type]||glyphs.mcp_tool_call)+'"/></svg>';
  const toolNames={'shiyan-input':'向你确认',web:'网页',fetch:'读取网页',filesystem:'文件',memory:'记忆'};
  function stepTitle(item){
    switch(item.type){
      case 'reasoning':return '思考';
      case 'command_execution':return '运行命令';
      case 'web_search':return '搜索网页';
      case 'mcp_tool_call':return '使用工具'+(item.tool?' · '+(toolNames[item.server]||limit(item.server,40)||'')+(item.server?' / ':'')+limit(item.tool,60):'');
      case 'todo_list':return '制定计划';
      case 'file_change':{const n=(item.changes||[]).length;return n?'修改 '+n+' 个文件':'修改文件';}
      case 'collab_tool_call':return '分派协作任务';
      case 'image_generation':return '生成图片';
      case 'error':return '遇到问题';
    }
    return '处理';
  }
  function liveLabel(item){
    if(!item)return '正在思考';
    return ({reasoning:'正在思考',command_execution:'正在运行命令',web_search:'正在搜索网页',mcp_tool_call:'正在使用工具',todo_list:'正在规划',file_change:'正在修改文件',collab_tool_call:'正在协作处理',image_generation:'正在生成图片'})[item.type]||'正在处理';
  }
  function thoughtHTML(item,live){
    const raw=String(item.text||'').trim();if(!raw)return '';
    const text=live&&raw.length>360?'…'+raw.slice(-360):raw;
    return '<div class="exec-thought'+(live?' is-live':'')+'" title="'+(live?'':'点击展开 / 收起')+'">'+esc(limit(text,8000)).replace(/\n{2,}/g,'\n').replace(/\n/g,'<br>')+'</div>';
  }
  function stepBody(item,live){
    if(item.type==='reasoning')return thoughtHTML(item,live);
    if(item.type==='command_execution'){
      const out=String(item.aggregated_output||'').trim();
      return '<code class="exec-cmd">'+esc(limit(item.command,600))+'</code>'+(out?'<details class="exec-fold"><summary>输出'+(Number.isFinite(item.exit_code)&&item.exit_code!==0?' · 退出码 '+esc(item.exit_code):'')+'</summary><pre>'+esc(limit(out))+'</pre></details>':'');
    }
    if(item.type==='web_search')return item.query?'<p class="exec-quote">'+esc(limit(item.query,300))+'</p>':'';
    if(item.type==='mcp_tool_call'){
      const out=String(toolText(item)||'').trim(),err=item.error?(typeof item.error==='string'?item.error:item.error.message||'工具调用失败'):'';
      return (err?'<p class="exec-error">'+esc(limit(err,600))+'</p>':'')+(out?'<details class="exec-fold"><summary>结果</summary><pre>'+esc(limit(out))+'</pre></details>':'');
    }
    if(item.type==='todo_list'){
      const rows=(Array.isArray(item.items)?item.items:[]).slice(0,30);
      return '<ul class="exec-plan">'+rows.map(t=>'<li class="'+(t.completed?'is-done':'')+'"><i></i><span>'+esc(limit(t.text,300))+'</span></li>').join('')+'</ul>';
    }
    if(item.type==='file_change')return '<ul class="exec-files">'+(item.changes||[]).slice(0,30).map(f=>'<li><span>'+esc(limit(String(f.path).split('/').slice(-2).join('/'),200))+'</span><small class="is-'+esc(f.kind||'update')+'">'+esc(({add:'新增',delete:'删除',update:'修改'})[f.kind]||'修改')+'</small></li>').join('')+'</ul>';
    if(item.type==='collab_tool_call'){const count=item.agents_count??item.count;return Number.isFinite(count)?'<p class="exec-quote">'+esc(count)+' 个子任务</p>':'';}
    if(item.type==='error')return '<p class="exec-error">'+esc(limit(item.message||'执行时发生错误',600))+'</p>';
    return '';
  }
  function timelineHTML(items,busy){
    const last=items[items.length-1];
    return '<ol class="exec-timeline">'+items.map(item=>{
      const s=status(item),live=busy&&item===last&&s.key!=='failed';
      const state=s.key==='failed'?'failed':live||s.key==='running'?'running':'done';
      return '<li class="exec-step" data-kind="'+esc(item.type)+'" data-state="'+state+'"><span class="exec-node">'+glyph(item.type)+'</span><div class="exec-main"><div class="exec-title"><span>'+esc(stepTitle(item))+'</span>'+(state==='failed'?'<em>失败</em>':'')+'</div>'+(!busy||item===last||state==='failed'?stepBody(item,live):'')+'</div></li>';
    }).join('')+'</ol>';
  }
  function summaryText(items){
    const thoughts=items.filter(i=>i.type==='reasoning').length,steps=items.filter(i=>i.type!=='reasoning'&&i.type!=='todo_list').length;
    const failed=items.filter(i=>status(i).key==='failed').length;
    const parts=[];if(thoughts)parts.push('已思考');if(steps)parts.push('执行 '+steps+' 步');if(!parts.length)parts.push('处理过程');
    return parts.join(' · ')+(failed?' · <b>'+failed+' 步失败</b>':'');
  }
  // 聊天气泡内的执行过程：进行中展开并实时显示思考，完成后收起为一行。
  function inline(message,busy){
    const items=itemsFor(message);
    if(!items.length&&!busy)return '';
    if(busy){
      const last=items[items.length-1],label=message.phase&&!/处理中|正在回复/.test(message.phase)?message.phase:liveLabel(last);
      return '<div class="exec is-live" aria-live="polite"><div class="exec-head"><span class="exec-pulse" aria-hidden="true"></span><span class="exec-shimmer">'+esc(label)+'</span>'+(items.length>1?'<small>'+items.filter(i=>i.type!=='reasoning').length+' 步</small>':'')+'</div>'+(items.length?timelineHTML(items.slice(-6),true):'')+'</div>';
    }
    return '<details class="exec"><summary class="exec-head"><span class="exec-done" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5.5 12.5l4 4 9-9"/></svg></span><span>'+summaryText(items)+'</span><svg class="exec-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></summary>'+timelineHTML(items,false)+'</details>';
  }
  document.addEventListener('click',event=>{
    const thought=event.target.closest?.('.exec-thought:not(.is-live)');
    if(thought&&!String(window.getSelection?.()||''))thought.classList.toggle('is-expanded');
  });
  function details(message,busy) {
    const items=itemsFor(message);if(!items.length)return '';
    const errors=items.filter(i=>status(i).key==='failed').length,steps=items.filter(i=>i.type!=='reasoning').length;
    return '<details class="output-details"'+(busy?' open':'')+'><summary><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg><span>执行过程</span><small>'+steps+' 项'+(errors?' · '+errors+' 项失败':'')+'</small></summary><div class="output-detail-body">'+items.map(itemHTML).join('')+'</div></details>';
  }
  window.ShiYanOutput={markdown,details,inline,itemsFor,executionStats,generatedAssetVisible,generatedDocumentVisible};
})();