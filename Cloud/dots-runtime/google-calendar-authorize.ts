import http from 'node:http';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import path from 'node:path';
const dataDir=process.env.DOTS_DATA_DIR||'/home/ubuntu/dots-runtime/data';
const file=process.argv[2]||path.join(dataDir,'google-oauth-client.json');
let raw;try{raw=JSON.parse(await readFile(file,'utf8'));}catch{console.error('请先提供 Google Cloud 创建的桌面应用 OAuth 客户端 JSON 文件路径。');process.exit(1);}
const client=raw.installed;if(!client?.client_id||!client?.client_secret){console.error('需要桌面应用类型的 OAuth 客户端 JSON。');process.exit(1);}
const state=randomBytes(32).toString('hex'),verifier=randomBytes(48).toString('base64url'),redirect='http://127.0.0.1:8877/callback';let busy=false;
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url || '/','http://127.0.0.1:8877');if(url.pathname!=='/callback'){res.writeHead(404).end();return;}
 const received=Buffer.from(url.searchParams.get('state')||''),expected=Buffer.from(state);
 if(received.length!==expected.length||!timingSafeEqual(received,expected)||!url.searchParams.get('code')||busy){res.writeHead(400).end('Authorization rejected');return;}
 busy=true;
 try{
  const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code:url.searchParams.get('code')!,client_id:client.client_id,client_secret:client.client_secret,redirect_uri:redirect,grant_type:'authorization_code',code_verifier:verifier})});
  const token: any=await response.json();if(!response.ok||!token.refresh_token)throw Error('authorization_failed');
  const target=path.join(dataDir,'google-calendar.json'),temp=target+'.'+randomBytes(8).toString('hex');
  await writeFile(temp,JSON.stringify({enabled:true,clientId:client.client_id,clientSecret:client.client_secret,refreshToken:token.refresh_token,calendarId:'primary'}),{mode:0o600,flag:'wx'});await rename(temp,target);
  res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'}).end('谷歌日历授权成功。Dots 将在下一轮检查时开始同步。');console.log('授权已保存，未输出任何令牌。');server.close();clearTimeout(expiry);
 }catch{busy=false;res.writeHead(502).end('Authorization failed. Retry the authorization link.');}
});
server.listen(8877,'127.0.0.1',()=>{
 const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');url.search=new URLSearchParams({client_id:client.client_id,redirect_uri:redirect,response_type:'code',scope:'https://www.googleapis.com/auth/calendar.events.readonly',access_type:'offline',prompt:'consent',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
 console.log('如果在自己电脑的浏览器授权，先建立到服务器 8877 端口的 SSH 本地转发。\n然后在浏览器打开：\n'+url.href);
});
server.on('error',()=>{console.error('本地授权端口不可用。');process.exitCode=1;});
const expiry=setTimeout(()=>{console.log('授权等待已结束，可重新运行命令。');server.close();},30*60*1000);expiry.unref();
