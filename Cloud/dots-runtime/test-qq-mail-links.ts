import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {decodeMailBody,readMailBody,mailPresentationText,createMailPresenter,normalizeMailPresentationLinks} from './qq-mail-content.ts';

test('HTML keeps distinct same-host links after the fifth and their original text',()=>{
 const html=Array.from({length:8},(_,i)=>`<a href="https://www.example.com/go/news?item=${i}"><span>入口 ${i+1}</span></a>`).join(' ');
 const body=decodeMailBody({content:html,type:'text/html'});
 assert.equal(body.links.length,8);
 assert.equal(body.links[7].text,'入口 8');
 const shown=mailPresentationText({kind:'body',...body});
 assert.match(shown,/8\. \[入口 8\]/);
 assert.match(shown,/item=7/);
});

test('exact URL duplicates merge text, but different parameters stay distinct',()=>{
 const body=decodeMailBody({type:'text/html',content:'<a href="https://example.com/a"></a><a href="https://example.com/a">账户设置</a><a href="https://example.com/a?x=1">续费</a>'});
 assert.equal(body.links.length,2);
 assert.equal(body.links[0].text,'账户设置');
 assert.equal(body.links[1].text,'续费');
});

test('image-only links use alt text and named empty links use accessible labels',()=>{
 const body=decodeMailBody({type:'text/html',content:'<a href="https://example.com/renew"><img alt="立即续费" src="x"></a><a href="https://example.com/help" aria-label="帮助中心"></a>'});
 assert.deepEqual(body.links.map(x=>x.text),['立即续费','帮助中心']);
});

test('multipart plain and HTML retain all URLs and enrich plain links with HTML labels',async()=>{
 const plain=Array.from({length:7},(_,i)=>`https://example.com/${i}`).join('\n');
 const html=Array.from({length:7},(_,i)=>`<a href="https://example.com/${i}">操作 ${i}</a>`).join('');
 const client={download:async(uid: any,part: any)=>({content:Readable.from([part==='1'?plain:html])})};
 const body=await readMailBody(client,{uid:1,bodyStructure:{type:'multipart/alternative',childNodes:[{type:'text/plain',part:'1'},{type:'text/html',part:'2'}]}});
 assert.equal(body.text,plain);
 assert.equal(body.links.length,7);
 assert.equal(body.links[6].text,'操作 6');
});

test('unsafe URLs remain excluded and untrusted labels are Markdown escaped',()=>{
 const body=decodeMailBody({type:'text/html',content:'<a href="javascript:alert(1)">bad</a><a href="https://user:pass@example.com/">bad</a><a href="https://example.com/?a=1&amp;b=2">[操作](伪造链接) &amp; 帮助</a>'});
 assert.equal(body.links.length,1);
 assert.equal(body.links[0].url,'https://example.com/?a=1&b=2');
 const shown=mailPresentationText({kind:'body',...body});
 assert.ok(shown.includes('\\[操作\\]\\(伪造链接\\) & 帮助'));
});

test('plain URLs are not limited to five and keep a truthful fallback label',()=>{
 const body=decodeMailBody({content:Array.from({length:9},(_,i)=>`https://example.com/help/${i}`).join('\n')});
 assert.equal(body.links.length,9);
 assert.match(mailPresentationText({kind:'body',...body}),/9\. \[https:\/\/example\.com\/help\/8\]/);
});

test('long lists use a visible length notice rather than silently cutting or breaking Markdown',()=>{
 const links=Array.from({length:30},(_,i)=>({url:`https://example.com/?${i}=${'x'.repeat(1700)}`,text:`入口 ${i}`}));
 const shown=mailPresentationText({kind:'body',text:'正文内容',links});
 const count=[...shown.matchAll(/\]\(<https:/g)].length;
 assert.ok(count>5&&count<30);
 assert.ok(shown.length<=12000);
 assert.ok(shown.endsWith(`（另有 ${30-count} 个链接因单条消息长度限制未展开，请在原邮件中查看。）`));
});

test('presentation also deduplicates legacy inputs without grouping by hostname',()=>{
 const links=[{url:'https://example.com/a'},{url:'https://example.com/a',text:'账户'},{url:'https://example.com/b',text:'帮助'}];
 const shown=mailPresentationText({kind:'body',text:'内容',links});
 assert.match(shown,/1\. \[账户\]/);
 assert.match(shown,/2\. \[帮助\]/);
 assert.equal([...shown.matchAll(/\]\(<https:/g)].length,2);
});

test('long mail summary keeps every link and substitutes URLs without repeated full-body scans',async(t)=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 const links=Array.from({length:9},(_,i)=>({url:`https://example.com/action/${i}`,text:`操作 ${i}`}));
 let input;
 const present=createMailPresenter({store:{db,managerId:'test',transaction:(fn: any)=>fn()},assess:async (value: any)=>{
  input=JSON.parse(value);return {summary:'邮件摘要',evidence_quotes:['邮件正文']};
 }});
 const result=await present({text:'邮件正文'.repeat(260)+'\n'+links.map(l=>l.url).join('\n'),links});
 assert.equal(result.kind,'summary');assert.equal(result.links.length,9);
 for(let i=0;i<9;i++)assert.ok(input!.body.includes(`〔原文链接${i+1}〕`));
 assert.ok(!input!.body.includes('https://example.com/'));
});


test('Chinese prose after a plain mail URL is never part of its DNS hostname',()=>{
 const body=decodeMailBody({content:'登录 https://sz.duoyi.com（电脑端登录），使用手机号12345678901'});
 assert.deepEqual(body.links.map(l=>l.url),['https://sz.duoyi.com']);
});
test('link explanation stays outside the clickable caption and legacy mail is repaired on delivery',()=>{
 const raw='https://sz.duoyi.com（电脑端登录），使用手机号12345678901';
 const shown=mailPresentationText({kind:'body',text:'邮件',links:[{url:raw,text:raw}]});
 assert(shown.includes('1. [https://sz.duoyi.com](<https://sz.duoyi.com>)（电脑端登录），使用手机号12345678901'));
 const legacy='邮件中的链接：\n[1. '+raw+'](<'+raw+'>)';
 const fixed=normalizeMailPresentationLinks(legacy);
 assert(fixed.includes('1. [https://sz.duoyi.com](<https://sz.duoyi.com>)（电脑端登录），使用手机号12345678901'));
 assert.equal(normalizeMailPresentationLinks(fixed),fixed);
 const target='https://example.com/login?token=abc&next=%2Fhome';
 assert(normalizeMailPresentationLinks('邮件中的链接：\n[1. 登录](<'+target+'>)').includes('(<'+target+'>)'));
 assert.equal(normalizeMailPresentationLinks('普通正文 https://example.com'), '普通正文 https://example.com');
});


test('mail link numbering stays outside anchors for new and historical messages',()=>{
 const links=[{url:'https://example.com/?token=a&next=%2Fhome'},{url:'https://example.com/help',text:'帮助'}];
 const fresh=mailPresentationText({text:'正文',links});
 assert(fresh.includes('1. [https://example.com/?token=a&next=%2Fhome](<https://example.com/?token=a&next=%2Fhome>)'));
 assert(fresh.includes('2. [帮助](<https://example.com/help>)'));
 assert.equal(normalizeMailPresentationLinks(fresh),fresh);
 const legacy='邮件中的链接：\n[1. https://example.com](<https://example.com>)';
 assert.equal(normalizeMailPresentationLinks(legacy),'邮件中的链接：\n1. [https://example.com](<https://example.com>)');
 const numberedLabel=mailPresentationText({text:'正文',links:[{url:'https://example.com',text:'1. 产品'}]});
 assert.equal(normalizeMailPresentationLinks(numberedLabel),numberedLabel);
});
