 
(() => {
  'use strict';
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const limit = (v, n=4000) => String(v ?? '').slice(0,n);
  const allowed = new Set(['command_execution','mcp_tool_call','todo_list','web_search','file_change','collab_tool_call','image_generation','error']);
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
  let parser;
  function getParser() {
    if(parser || !window.markdownit)return parser;
    parser=window.markdownit({html:false,linkify:true,breaks:true,typographer:false});
    parser.validateLink=href=>generatedFileLink(href)||!!safeURL(href);
    const link=parser.renderer.rules.link_open || ((t,i,o,e,s)=>s.renderToken(t,i,o));
    parser.renderer.rules.link_open=(tokens,index,options,env,self)=>{
      const t=tokens[index],raw=t.attrGet('href');
      if(generatedFileLink(raw)){t.attrSet('data-generated-file',raw);t.attrSet('href','#');}
      else {t.attrSet('href',safeURL(raw)||'#');t.attrSet('target','_blank');t.attrSet('rel','noopener noreferrer');}
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
  function markdown(text,copyIcon='') {
    const p=getParser();return p?p.render(String(text??''),{copyIcon}):'<p>'+esc(text).replace(/\n/g,'<br>')+'</p>';
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
  function itemHTML(item) {
    const s=status(item);let label='',body='';
    if(item.type==='command_execution'){
      label='终端命令';body='<pre class="output-command"><code>'+esc(limit(item.command,1000))+'</code></pre>'+output(item.aggregated_output,'输出');
      if(Number.isFinite(item.exit_code))body+='<p class="output-exit">退出码 '+esc(item.exit_code)+'</p>';
    }else if(item.type==='mcp_tool_call'){
      label=[limit(item.server,100),limit(item.tool,100)].filter(Boolean).join(' · ')||'工具调用';
      body=output(toolText(item),'工具结果');
      if(item.error)body+='<p class="output-error">'+esc(limit(typeof item.error==='string'?item.error:item.error.message||'工具调用失败'))+'</p>';
    }else if(item.type==='todo_list'){
      label='执行计划';const rows=(Array.isArray(item.items)?item.items:[]).slice(0,50);s.label=rows.filter(t=>t.completed).length+'/'+rows.length+' 已完成';
      body='<ul class="output-plan">'+rows.map(t=>'<li'+(t.completed?' class="is-done"':'')+'><input type="checkbox" disabled'+(t.completed?' checked':'')+' aria-label="'+(t.completed?'已完成':'未完成')+'"><span>'+esc(limit(t.text,1000))+'</span></li>').join('')+'</ul>';
    }else if(item.type==='file_change'){
      label='文件修改';body='<ul class="output-files">'+(Array.isArray(item.changes)?item.changes:[]).slice(0,50).map(f=>'<li><span>'+esc(limit(f.path,1000))+'</span><small>'+esc(({add:'新增',delete:'删除',update:'修改'})[f.kind]||limit(f.kind,40))+'</small></li>').join('')+'</ul>';
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
  function details(message,busy) {
    const items=itemsFor(message);if(!items.length)return '';
    const errors=items.filter(i=>status(i).key==='failed').length;
    return '<details class="output-details"'+(busy?' open':'')+'><summary><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg><span>执行过程</span><small>'+items.length+' 项'+(errors?' · '+errors+' 项失败':'')+'</small></summary><div class="output-detail-body">'+items.map(itemHTML).join('')+'</div></details>';
  }
  window.ShiYanOutput={markdown,details,itemsFor,executionStats,generatedAssetVisible,generatedDocumentVisible};
})();