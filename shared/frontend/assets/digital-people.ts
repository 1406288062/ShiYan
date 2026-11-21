(() => {
  'use strict';
  // 影子人：在本机解析微信聊天记录并脱敏。界面在 workbench-dots-panels.js 的 openShadow 里。
  if (window.ShiYanShadowParser) return;
  // 与服务器端规则一致：证件号要在卡号之前匹配。
  const REDACTIONS: [RegExp, string][] = [
    [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱已隐藏]'],
    [/(?:支付密码|登录密码|密码|口令|password|passwd|pwd)\s*(?:是|为|:|：|=)?\s*(?=[^\s,，。;；]*[A-Za-z0-9])[^\s,，。;；]{3,}/gi, '[凭据已隐藏]'],
    [/(?:验证码|校验码|动态码|取件码)\s*(?:是|为|:|：)?\s*[A-Za-z0-9]{4,8}/g, '[验证码已隐藏]'],
    [/https?:\/\/[^\s]*[?&](?:token|access_token|key|code|ticket|sig|sign|auth|session|sid)=[^\s]*/gi, '[链接已隐藏]'],
    [/(?<![\dA-Za-z])\d{6}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![\dA-Za-z])/g, '[证件号已隐藏]'],
    [/(?:护照|通行证|passport)\s*号?\s*(?:是|为|:|：)?\s*[A-Za-z]{1,2}\d{7,8}/gi, '[证件号已隐藏]'],
    [/(?<!\d)(?:\d[ -]?){15,18}\d(?!\d)/g, '[卡号已隐藏]'],
    [/(?:卡号|账号|帐号|银行卡|账户|户号)\s*(?:是|为|:|：)?\s*\d[\d -]{7,}\d/g, '[账号已隐藏]'],
    [/(?<!\d)(?:\+?86[ -]?)?1[3-9]\d(?:[ -]?\d{4}){2}(?!\d)/g, '[手机号已隐藏]'],
    [/(?<!\d)0\d{2,3}-\d{7,8}(?!\d)/g, '[电话已隐藏]'],
    [/(?:微信号|wxid_?|QQ号?|支付宝账?号?)\s*(?:是|为|:|：)?\s*[A-Za-z0-9_@.-]{5,}/gi, '[账号已隐藏]']
  ];
  const redact = value => REDACTIONS.reduce((text, [pattern, mark]) => text.replace(pattern, mark), String(value || ''));
  function parseCSV(text){
    const rows: any[] = [];let row: any[] = [],field='',quoted=false;
    for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'&&quoted&&text[i+1]==='"'){field+='"';i++;}else if(c==='"')quoted=!quoted;else if(c===','&&!quoted){row.push(field);field='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);if(row.some(v=>v.trim()))rows.push(row);row=[];field='';}else field+=c;}
    row.push(field);if(row.some(v=>v.trim()))rows.push(row);return rows;
  }
  function stamp(value){
    if(typeof value==='number')return value<1e12?value*1000:value;
    if(/^\d{10,13}$/.test(String(value||'').trim()))return stamp(Number(value));
    const normalized=String(value||'').replace(/年/g,'-').replace(/月/g,'-').replace(/日/g,' ');const parsed=Date.parse(normalized);return Number.isFinite(parsed)?parsed:0;
  }
  const cleanName=value=>String(value||'未知').replace(/[\r\n]/g,' ').trim().slice(0,80)||'未知';
  function normalizeRecord(raw){
    const name=cleanName(raw.speakerName??raw.speakername??raw.senderName??raw.sendername??raw.talker??raw.speaker??raw.sender??raw.from??raw.nickname??raw.name??raw.username??'未知');
    const content=redact(String(raw.content??raw.text??raw.message??raw.msg??raw.body??raw.strcontent??'').trim());
    if(!content)return null;
    return {speakerName:name,content,timestamp:stamp(raw.timestamp??raw.time??raw.createTime??raw.createtime??raw.datetime??raw.date??raw.strtime)};
  }
  function parseText(text){
    const rows: any[] = [];let current: any = null;
    const pattern=/^\s*\[?(\d{4}(?:[./-]\d{1,2}[./-]\d{1,2}|年\d{1,2}月\d{1,2}日)[ T]\d{1,2}:\d{2}(?::\d{2})?)\]?\s+([^:：]{1,80})[:：]\s*(.*)$/;
    // 微信常见导出：“昵称 2024-01-02 12:34:56”一行，下一行是内容。
    const header=/^\s*([^\d\s:：][^:：]{0,60}?)\s+(\d{4}[./-]\d{1,2}[./-]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)\s*$/;
    // 改动：冒号后的 \s+ 改成 \s*，空格可有可无。
    const simple=/^\s*([^:：]{1,50})[:：]\s*(.+)$/;
    // 文档型文件：分隔线（10 个以上 =）之前是说明/总览，跳过；「第X回」是章节标题，断句后跳过。
    const separator=/^={10,}\s*$/m;
    const chapter=/^第[一二三四五六七八九十百零\d]+回/;
    let started=!separator.test(text);
    const flush=()=>{if(current&&current.content.trim())rows.push(current);current=null;};
    for(const line of String(text).replace(/\r/g,'').split('\n')){
      if(!started){if(/^={10,}\s*$/.test(line))started=true;continue;}
      if(!line.trim())continue;
      if(chapter.test(line)){flush();continue;}
      const match=line.match(pattern),head=!match&&line.match(header);
      let plain: any = !match&&!head&&!current?.fresh&&line.match(simple);
      if(plain&&/^\d+$/.test(plain[1].trim()))plain=null;
      if(match||head||plain){flush();current=match?{time:match[1],sender:match[2].trim(),content:match[3]}:head?{time:head[2],sender:head[1].trim(),content:'',fresh:true}:{sender:plain[1].trim(),content:plain[2]};}
      else if(current&&line.trim()){current.content+=(current.content?'\n':'')+line;current.fresh=false;}
    }
    flush();
    return rows.map(normalizeRecord).filter(Boolean);
  }
  function parseFile(text,extension){
    let rows: any[] = [];
    if(extension==='json'){
      const value=JSON.parse(text),items=Array.isArray(value)?value:(value.messages||value.chatRecords||value.records||value.data||[]);
      if(!Array.isArray(items))throw Error('JSON 里没有识别到消息列表');
      rows=items.map(normalizeRecord).filter(Boolean);
    }else if(extension==='csv'){
      const data=parseCSV(text);if(data.length<2)throw Error('CSV 文件里没有可读取的消息');
      const headers=(data.shift() || []).map(v=>v.trim().toLowerCase());
      rows=data.map(cells=>normalizeRecord(Object.fromEntries(headers.map((h,i)=>[h,cells[i]||''])))).filter(Boolean);
    }else if(extension==='html'||extension==='htm'||extension==='xml'){
      const doc=new DOMParser().parseFromString(text,'text/html');
      const table=[...doc.querySelectorAll('tr')];
      if(table.length)rows=table.map(tr=>{const c=[...tr.querySelectorAll('td,th')].map(x=>x.textContent.trim());return normalizeRecord({time:c[0],sender:c[1],content:c.slice(2).join(' ')||c[1]});}).filter(Boolean);
      if(!rows.length)rows=parseText(doc.body?.innerText||doc.documentElement?.textContent||'');
    }else rows=parseText(text);
    if(!rows.length)throw Error('没有识别到聊天消息。请使用带发送人和消息内容的 TXT、CSV、JSON 或 HTML 导出文件。');
    return rows.slice(0,200000).map((row,index)=>({...row,sourceId:String(index)}));
  }
  // 读取并解析文件；按发言数排序发送人，并给出默认的身份对应（名字匹配的是 Ta，否则发言最多的是 Ta，其次是“我”）。
  async function read(file,personName=''){
    if(!file||file.size>100*1024*1024)throw Error('文件不能为空且不能超过 100MB');
    const format=(file.name.split('.').pop()||'txt').toLowerCase();
    const bytes=await file.arrayBuffer();let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{text=new TextDecoder('gb18030').decode(bytes);}
    const messages=parseFile(text,format);
    const counts={};for(const m of messages)counts[m.speakerName]=(counts[m.speakerName]||0)+1;
    const speakers=Object.keys(counts).sort((a,b)=>counts[b]-counts[a]);
    const name=String(personName||'').toLowerCase();
    const person=speakers.find(s=>name&&s.toLowerCase().includes(name))||speakers[0];
    const owner=speakers.find(s=>s!==person);
    const mapping={};for(const s of speakers)mapping[s]=s===person?'person':s===owner?'owner':'other';
    return {messages,speakers,counts,mapping,format};
  }
  window.ShiYanShadowParser={read,redact};
  // 兼容旧入口。
  window.ShiYanDigitalPeople={open:()=>window.ShiYanDotsPanels?.openShadow?.(),close(){}};
})();
