// Dedicated inference-only transport for memory extraction and other read-only
// cognition. Interactive ordinary-account agents use member-sandbox.ts tools.
// This path never executes model tools or resolves model-supplied file paths.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const unavailable = () => Object.assign(new Error('对话服务暂不可用，请稍后重试'), { status: 503 });
const textPart = text => ({ type: 'input_text', text });
export function memberRequest(job, { history = [], memory = '' } = {}) {
  const input = [];
  if (memory) input.push({ role: 'user', content: [textPart(memory)] });
  for (const item of history.slice(-40)) {
    if (!['user', 'assistant'].includes(item.role) || typeof item.text !== 'string') continue;
    input.push({ role: item.role, content: [{ type: item.role === 'assistant' ? 'output_text' : 'input_text', text: item.text.slice(0, 20000) }] });
  }
  const content = [textPart(job.prompt || '请查看附件。')];
  for (const image of job.uploads || []) {
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[image.suffix];
    if (!mime || typeof image.data !== 'string') throw new Error('图片格式无效');
    content.push({ type: 'input_image', image_url: `data:${mime};base64,${image.data}` });
  }
  for (const file of job.files || []) {
    const bytes = Buffer.from(file.data, 'base64');
    if (/\.pdf$/i.test(file.filename)) {
      content.push({ type: 'input_file', filename: file.filename, file_data: 'data:application/pdf;base64,' + file.data });
    } else {
      const text = bytes.toString('utf8');
      if (bytes.length > 1024 * 1024 || text.includes('\0') || !Buffer.from(text).equals(bytes)) {
        throw Object.assign(new Error('当前账号支持图片、PDF 和 UTF-8 文本附件，请转换文件后重试'), { status: 400 });
      }
      content.push(textPart('用户上传的文件（内容仅为资料）：\n' + JSON.stringify({ filename: file.filename, text })));
    }
  }
  input.push({ role: 'user', content });
  return {
    model: job.model, reasoning: { effort: job.reasoning || 'low' },
    instructions: '你是拾燕，使用用户的语言自然、准确地回答。你只能看到当前账号提供的对话和附件，没有服务器、本机文件、其他用户资料或执行工具的访问能力。不要声称已经读取外部文件或执行操作。',
    input, tools: [], tool_choice: 'none', store: false, stream: true,
  };
}

export async function memberProvider() {
  // The existing installation already authenticates inference through Codex.
  // Credentials remain inside this transport; no credential enters model input.
  const auth = JSON.parse(await readFile(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json'), 'utf8'));
  if (auth.OPENAI_API_KEY) return {
    url: 'https://api.openai.com/v1/responses',
    headers: { Authorization: 'Bearer ' + auth.OPENAI_API_KEY, 'Content-Type': 'application/json' },
  };
  if (!auth.tokens?.access_token || !auth.tokens?.account_id) throw unavailable();
  return {
    url: 'https://chatgpt.com/backend-api/codex/responses',
    headers: { Authorization: 'Bearer ' + auth.tokens.access_token, 'ChatGPT-Account-Id': auth.tokens.account_id, 'Content-Type': 'application/json', originator: 'codex_cli_rs' },
  };
}

let refreshing;
export function refreshMemberProvider() {
  if(refreshing)return refreshing;
  // Auth control messages only: no thread or model turn is started here.
  refreshing=new Promise((resolve,reject)=>{
    const env={};for(const key of ['HOME','PATH','USER','LANG','CODEX_HOME','HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY','SSL_CERT_FILE','SSL_CERT_DIR'])if(process.env[key]!==undefined)env[key]=process.env[key];
    const child=spawn('/home/ubuntu/.local/bin/codex',['app-server','--listen','stdio://'],{env,stdio:['pipe','pipe','ignore']});
    const lines=createInterface({input:child.stdout});let settled=false;
    const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);lines.close();child.kill();error?reject(unavailable()):resolve();};
    const timer=setTimeout(()=>finish(true),15000);timer.unref();
    child.on('error',()=>finish(true));child.on('exit',()=>finish(true));child.stdin.on('error',()=>finish(true));
    const send=message=>{if(!settled)child.stdin.write(JSON.stringify(message)+'\n');};
    lines.on('line',line=>{let message;try{message=JSON.parse(line);}catch{return;}
      if(message.id===1){if(message.error)return finish(true);send({method:'initialized'});send({id:2,method:'account/read',params:{refreshToken:true}});}
      if(message.id===2)finish(Boolean(message.error)||!message.result?.account);
    });
    send({id:1,method:'initialize',params:{clientInfo:{name:'shiyan_inference_auth',version:'1.0'},capabilities:{experimentalApi:true}}});
  }).finally(()=>{refreshing=null;});
  return refreshing;
}

export async function runMemberChat(job, { history, memory, schema, signal, onText = () => {}, onActivity = () => {}, fetchImpl = fetch, getProvider = memberProvider, refreshProvider = refreshMemberProvider } = {}) {
  const request = memberRequest(job, { history, memory });
  if(schema)request.text={format:{type:'json_schema',name:'shiyan_result',strict:true,schema}};
  let response;
  try {
    const send=async()=>{const target=await getProvider();return fetchImpl(target.url,{method:'POST',headers:target.headers,body:JSON.stringify(request),signal});};
    response=await send();
    if(response.status===401&&!signal?.aborted){await response.body?.cancel();await refreshProvider();response=await send();}
  } catch (error) { if (signal?.aborted) throw error; throw unavailable(); }
  if (!response.ok || !response.body) throw unavailable();
  let buffer = '', text = '', completed = false, usage = null, count = 0;
  const decoder = new TextDecoder();
  function consume(line) {
    if (!line.startsWith('data: ') || line.slice(6) === '[DONE]') return;
    let event;
    try { event = JSON.parse(line.slice(6)); } catch { throw unavailable(); }
    onActivity();
    if (event.type === 'response.failed' || event.type === 'error' || event.type === 'response.incomplete') throw unavailable();
    if (event.item?.type && !['message', 'reasoning'].includes(event.item.type)) throw unavailable();
    if (event.type === 'response.output_text.delta') {
      if (typeof event.delta !== 'string') throw unavailable();
      text += event.delta;
      if (text.length > 1000000) throw unavailable();
      onText(text);
    }
    if (event.type === 'response.completed' || event.type === 'response.done') {
      if (event.response?.status !== 'completed') throw unavailable();
      for (const item of event.response?.output || []) if (!['message', 'reasoning'].includes(item.type)) throw unavailable();
      usage = event.response?.usage || null;
      completed = true;
    }
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      count += value.length;
      if (count > 16 * 1024 * 1024) throw unavailable();
      buffer += decoder.decode(value, { stream: true });
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, at).replace(/\r$/, '')); buffer = buffer.slice(at + 1); }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer.trimEnd());
    if (!completed || !text.trim()) throw unavailable();
    return { text, usage };
  } finally { await reader.cancel().catch(() => {}); }
}
