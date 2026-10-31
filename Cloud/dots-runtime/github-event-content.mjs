// Format one GitHub event from verified API data, with explicit partial-data labels.
const safe=v=>String(v??'').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/[\\`*_{}\[\]()<>!|]/g,'\\$&');
const clip=(v,n=240)=>safe(String(v??'').slice(0,n));
const number=v=>Number.isSafeInteger(v)&&v>=0;
const sha=v=>typeof v==='string'&&/^[a-f0-9]{40,64}$/i.test(v)&&!/^0+$/.test(v);
const zero=v=>typeof v==='string'&&/^0{40,64}$/.test(v);
const actions={opened:'创建',closed:'关闭',reopened:'重新打开',edited:'编辑',created:'新增',deleted:'删除',published:'发布',unpublished:'取消发布',prereleased:'发布预览版',released:'正式发布',submitted:'提交',dismissed:'撤销',labeled:'添加标签',unlabeled:'移除标签',assigned:'分配负责人',unassigned:'移除负责人',synchronize:'更新提交',converted_to_draft:'转为草稿',ready_for_review:'请求审查',locked:'锁定',unlocked:'解锁',review_requested:'请求审查',review_request_removed:'取消审查请求'};
const types={IssuesEvent:'Issue',IssueCommentEvent:'Issue 评论',PullRequestEvent:'PR',PullRequestReviewEvent:'PR 审查',PullRequestReviewCommentEvent:'PR 审查评论',ReleaseEvent:'版本',PushEvent:'代码',CreateEvent:'引用',DeleteEvent:'引用'};
function reason(error){
 if(error?.status===429||error?.rateRemaining==='0')return 'GitHub 请求受限';
 if([401,403,404].includes(error?.status))return '详情无访问权限或提交已不可访问';
 if(error?.message==='github_detail_limit')return '变更较大，详情获取已达本轮上限';
 return '详情暂不可用';
}
function filesValid(files){return Array.isArray(files)&&files.every(f=>typeof f.filename==='string'&&number(f.additions)&&number(f.deletions));}
function statsLines({additions,deletions,linesExact=false,basis='本次推送净变更'}={}){
 return [linesExact?`代码总计：新增 ${additions} 行，删除 ${deletions} 行（${basis}）`:'代码总计：暂未获取完整增减统计'];
}
async function mainChanges(commits,files,summarize,extra='',context={}){
 let summary;
 try{summary=await summarize?.({commits,files,...context});}catch{/* Keep notification delivery independent of model availability. */}
 const scope=extra||summary?.partial?'（'+(extra||'基于已获取的变更内容')+'）':'';
 return summary?.text?['','改动摘要'+scope+'：',...summary.text.split('\n').filter(Boolean).map(t=>'- '+clip(t,240)),'']:['','改动摘要：暂未生成，可通过下方链接查看详情。',''];
}
export const isGithubEventSupported=event=>Boolean(types[event.type]);
export async function formatGithubEvent(event,{repository,load,summarize,maxRequests=80,maxPages=20}={}){
 let summaryPending=false;
 const summarizeChanges=async input=>{let result;try{result=await summarize?.(input);}catch{}if(!result?.text)summaryPending=true;return result;};
 if(!types[event.type])return null;
 if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository||''))throw Error('github_repository_invalid');
 let requests=0;
 const get=async path=>{if(++requests>maxRequests)throw Error('github_detail_limit');return load(path);};
 const p=event.payload||{},repoUrl='https://github.com/'+repository;
 const lines=[`GitHub · ${clip(repository,240)}`,'',`操作人：${clip(event.actor?.login||'未知',120)}`];
 let url=repoUrl;
 if(event.type==='PushEvent'){
  const head=p.head||p.after,before=p.before,ref=String(p.ref||'').replace(/^refs\/(heads|tags)\//,'');
  lines.push('具体操作：'+(zero(head)||p.deleted?'删除分支或标签':zero(before)||p.created?'创建引用并推送代码':p.forced?'强制推送代码':'推送代码'),`分支 / 标签：${clip(ref||'未提供',200)}`);
  if(zero(head)||p.deleted){lines.push('代码变更统计：不适用（删除引用）');}
  else {
   const stats=[];
   let comparison,commits=[],complete=false,error,files,filesExact=false,additions,deletions,linesExact=false,basis='本次推送净变更',checked=0,total;
   if(sha(before)&&sha(head)){
    url=repoUrl+'/compare/'+before+'...'+head;
    try{
     for(let page=1;page<=maxPages;page++){
      const data=await get('/compare/'+before+'...'+head+'?per_page=100&page='+page);
      if(!data||!Array.isArray(data.commits)||!number(data.total_commits))throw Error('github_compare_invalid');
      if(page===1){comparison=data;total=data.total_commits;}
      else if(data.total_commits!==total)throw Error('github_compare_changed');
      if(new Set(data.commits.map(c=>c.sha)).size!==data.commits.length||data.commits.some(c=>!sha(c.sha)||commits.some(prior=>prior.sha===c.sha)))throw Error('github_compare_invalid');
      commits.push(...data.commits);
      // Do not infer completeness from a short page when total_commits says more.
      if(commits.length>=total){complete=true;break;}
      if(!data.commits.length)throw Error('github_compare_incomplete');
     }
     if(!complete)throw Error('github_detail_limit');
    }catch(e){error=e;}
    // GitHub compare returns the whole diff's files on page 1, capped at 300.
    // An exactly-full array cannot prove completeness; fall back to commit data.
    if(filesValid(comparison?.files)&&comparison.files.length<300){
     files=comparison.files;filesExact=true;linesExact=true;
     additions=files.reduce((n,f)=>n+f.additions,0);deletions=files.reduce((n,f)=>n+f.deletions,0);
    }
    if(comparison&&['diverged','behind'].includes(comparison.status)){
     lines[3]='具体操作：更新分支（提交历史非快进）';
    }
    if(!filesExact&&commits.length){
     const allFiles=new Map();let allFilesComplete=true,allStats=true,sumAdd=0,sumDel=0;
     // Each commit's stats are exact, but its files can require pagination (3000 cap).
     for(const c of commits){
      if(!sha(c.sha)){allFilesComplete=false;allStats=false;continue;}
      try{
       let data,commitFiles=[],commitComplete=false;
       for(let page=1;page<=30;page++){
        data=await get('/commits/'+c.sha+'?per_page=100&page='+page);
        if(!Array.isArray(data?.files))throw Error('github_commit_invalid');
        if(page===1){
         if(!number(data.stats?.additions)||!number(data.stats?.deletions))allStats=false;
         else{sumAdd+=data.stats.additions;sumDel+=data.stats.deletions;}
        }
        commitFiles.push(...data.files);
        if(data.files.length<100){commitComplete=true;break;}
       }
       checked++;
       if(!commitComplete)allFilesComplete=false;
       for(const f of commitFiles){
        if(typeof f.filename!=='string'){allFilesComplete=false;continue;}
        const prev=allFiles.get(f.filename);
        allFiles.set(f.filename,prev?{...f,additions:prev.additions+(f.additions||0),deletions:prev.deletions+(f.deletions||0)}:{...f});
       }
      }catch(e){error=e;allFilesComplete=false;allStats=false;break;}
     }
     filesExact=complete&&checked===commits.length&&allFilesComplete;
     // The capped compare diff still establishes a lower bound. Keep those
     // known paths if individual commit fetching is incomplete.
     if(!filesExact&&filesValid(comparison?.files))for(const f of comparison.files)if(!allFiles.has(f.filename))allFiles.set(f.filename,f);
     files=[...allFiles.values()];
     linesExact=complete&&checked===commits.length&&allStats;additions=sumAdd;deletions=sumDel;basis='按提交累计，含多次修改';
     if(!files.length&&filesValid(comparison?.files))files=comparison.files;
    }else if(!filesExact&&filesValid(comparison?.files))files=comparison.files;
   }else if(!sha(head)){error=Error('github_push_range_missing');}
   // Event APIs can omit the range, and a new branch has no before commit.
   // A head commit is useful context, never statistics for the entire push.
   if(!comparison&&sha(head)){
    try{
     const latest=await get('/commits/'+head+'?per_page=100&page=1');
     if(latest?.commit?.message)commits=[latest];
     if(Array.isArray(latest?.files))files=latest.files;
     stats.push('代码总计：暂未获取整次推送的完整增减统计');
     if(!url.includes('/compare/'))url=repoUrl+'/commit/'+head;
    }catch(e){error=error||e;stats.push(...statsLines());}
   }else stats.push(...statsLines({files,filesExact,additions,deletions,linesExact,basis,checked,total}));
   lines.push(...await mainChanges(commits,files,summarizeChanges,!comparison?'仅最近提交':complete?'':'部分提交',{partial:!complete||!filesExact}),...stats);
   if(error||(!sha(before)&&!zero(before)))lines.push('统计说明：'+(error?reason(error):'事件未提供完整推送范围')+'；未获取的数据不会按 0 统计。');
   if(zero(before)&&!comparison)lines.push('统计说明：新引用未提供可比较的起始提交，仅展示最近提交参考。');
  }
 }else{
  let item=p.issue||p.pull_request||p.release||{},warning;
  const isPR=event.type.startsWith('PullRequest'),num=p.number||item.number;
  if(isPR&&Number.isSafeInteger(num)&&num>0){try{item={...item,...await get('/pulls/'+num)};}catch(e){warning=e;}}
  const action=event.type==='CreateEvent'?'创建':event.type==='DeleteEvent'?'删除':actions[p.action]||clip(p.action||'更新',80);
  const noun=event.type==='CreateEvent'||event.type==='DeleteEvent'?({branch:'分支',tag:'标签',repository:'仓库'}[p.ref_type]||'引用'):types[event.type];
  lines.push('具体操作：'+(isPR&&p.action==='closed'&&item.merged?'合并 PR':action+' '+noun));
  const title=item.title||item.name||p.ref||item.tag_name;
  if(title)lines.push((num?'#'+num+' · ':'')+clip(title,300));
  if(isPR){
   if(item.base?.ref||item.head?.ref)lines.push(`分支：${clip(item.head?.ref||'未提供',100)} → ${clip(item.base?.ref||'未提供',100)}`);

  }
  const comment=p.comment||p.review;
  const detail=comment?.body||item.body;
  if(p.review?.state)lines.push('审查结果：'+clip({approved:'通过',changes_requested:'请求修改',commented:'评论',dismissed:'已撤销'}[p.review.state]||p.review.state,80));
  if(isPR&&!comment)lines.push(...await mainChanges([],[],summarizeChanges,'',{title:item.title,description:item.body}));
  else if(detail)lines.push((comment?'评论内容：':'主要内容：')+clip(detail,800));
  if(isPR)lines.push(...statsLines({additions:item.additions,deletions:item.deletions,linesExact:number(item.additions)&&number(item.deletions),basis:'当前 PR'}));
  if(warning)lines.push('统计说明：'+reason(warning)+'；未获取的数据不会按 0 统计。');
  const link=comment?.html_url||item.html_url;
  if(typeof link==='string'&&link.startsWith(repoUrl+'/'))url=link;
  else if(isPR&&num)url=repoUrl+'/pull/'+num;
 }
 lines.push(url);
 return {key:'event:'+event.id,content:lines.join('\n'),summaryPending};
}
