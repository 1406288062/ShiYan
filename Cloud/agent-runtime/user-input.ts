// A per-job, durable question mailbox shared by the executor and HTTP sidecar.
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(value);
const hash=value=>createHash('sha256').update(value).digest('hex');
const text=(value,max)=>typeof value==='string'&&value.trim()&&value.length<=max&&!value.includes('\0');
export function normalizeQuestions(input){
  if(!Array.isArray(input)||input.length<1||input.length>3)throw fail('请选择一至三个问题');
  const ids=new Set();
  return input.map((question,index)=>{
    if(!question||typeof question!=='object'||!text(question.question,2000))throw fail('问题内容无效');
    const id=question.id||'question_'+(index+1);
    if(!identifier(id)||ids.has(id))throw fail('问题标识无效');ids.add(id);
    const options=question.options;
    if(!Array.isArray(options)||options.length<2||options.length>5)throw fail('每个问题需要二至五个选项');
    const labels=new Set();
    return {id,header:text(question.header,40)?question.header.trim():'请选择',question:question.question.trim(),options:options.map(option=>{
      if(!option||!text(option.label,300)||labels.has(option.label.trim())||option.description!==undefined&&(typeof option.description!=='string'||option.description.length>1000))throw fail('问题选项无效');
      labels.add(option.label.trim());return {label:option.label.trim(),description:option.description||''};
    })};
  });
}
export function normalizeAnswers(questions,input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==questions.length)throw fail('请回答所有问题');
  return Object.fromEntries(questions.map(question=>{
    const answers=input[question.id]?.answers;
    if(!Array.isArray(answers)||answers.length!==1||!text(answers[0],4000))throw fail('请选择一个选项或填写回答');
    return [question.id,{answers:[answers[0].trim()]}];
  }));
}
export class UserInputStore {
  constructor(root){
    mkdirSync(root,{recursive:true,mode:0o700});const file=path.join(root,'user-input.sqlite3');
    this.db=new DatabaseSync(file);chmodSync(file,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS input_jobs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,token_hash TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS input_requests(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,request_key TEXT NOT NULL,status TEXT NOT NULL,questions TEXT NOT NULL,answers TEXT,created_at INTEGER NOT NULL,answered_at INTEGER,UNIQUE(job_id,request_key));
      CREATE INDEX IF NOT EXISTS input_pending ON input_requests(job_id,status);`);
  }
  close(){this.db.close();}
  registerJob(job){
    if(!identifier(job.id)||!text(job.owner,200))throw fail('任务标识无效');
    const existing=this.db.prepare('SELECT * FROM input_jobs WHERE id=?').get(job.id);
    if(existing)throw fail('任务问答已注册',409);
    const token=randomBytes(32).toString('hex');
    this.db.prepare('INSERT INTO input_jobs VALUES(?,?,?,?,?)').run(job.id,job.owner,hash(token),'running',Date.now());return token;
  }
  job(id){return this.db.prepare('SELECT * FROM input_jobs WHERE id=?').get(id);}
  authorizeToken(id,token){
    const job=this.job(id);if(!job||typeof token!=='string'||token.length!==64||!timingSafeEqual(Buffer.from(job.token_hash),Buffer.from(hash(token))))throw fail('任务问答未获授权',401);
    return job;
  }
  public(row){return {id:row.id,jobId:row.job_id,status:row.status,questions:JSON.parse(row.questions),createdAt:row.created_at,...(row.answers?{answers:JSON.parse(row.answers),answeredAt:row.answered_at}:{})};}
  create(id,token,input){
    const job=this.authorizeToken(id,token);if(job.status!=='running')throw fail('任务已结束',409);
    if(!identifier(input.requestId))throw fail('问答请求标识无效');
    const questions=JSON.stringify(normalizeQuestions(input.questions));
    const existing=this.db.prepare('SELECT * FROM input_requests WHERE job_id=? AND request_key=?').get(id,input.requestId);
    if(existing){if(existing.questions!==questions)throw fail('问答请求内容冲突',409);return this.public(existing);}
    const count=this.db.prepare('SELECT COUNT(*) AS count FROM input_requests WHERE job_id=?').get(id).count;
    if(count>=32)throw fail('本次任务的问题过多',429);
    const requestID=randomUUID();this.db.prepare('INSERT INTO input_requests VALUES(?,?,?,?,?,?,?,?)').run(requestID,id,input.requestId,'pending',questions,null,Date.now(),null);
    return this.public(this.db.prepare('SELECT * FROM input_requests WHERE id=?').get(requestID));
  }
  get(id,requestID,token){this.authorizeToken(id,token);const row=this.db.prepare('SELECT * FROM input_requests WHERE id=? AND job_id=?').get(requestID,id);if(!row)throw fail('问题不存在',404);return this.public(row);}
  list(owner,id){const job=this.job(id);if(!job||job.owner!==owner)throw fail('任务不存在',404);return this.db.prepare('SELECT * FROM input_requests WHERE job_id=? ORDER BY created_at DESC,id DESC LIMIT 10').all(id).reverse().map(row=>this.public(row));}
  hasPending(id){return Boolean(this.db.prepare("SELECT 1 FROM input_requests WHERE job_id=? AND status='pending' LIMIT 1").get(id));}
  answer(owner,id,requestID,input){
    const job=this.job(id);if(!job||job.owner!==owner)throw fail('任务不存在',404);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const row=this.db.prepare('SELECT * FROM input_requests WHERE id=? AND job_id=?').get(requestID,id);if(!row)throw fail('问题不存在',404);
      const answers=JSON.stringify(normalizeAnswers(JSON.parse(row.questions),input.answers));
      if(row.status==='answered'){if(row.answers!==answers)throw fail('该问题已提交了其他回答',409);this.db.exec('COMMIT');return this.public(row);}
      if(job.status!=='running'||row.status!=='pending')throw fail('问题已结束，请重新发送消息',409);
      this.db.prepare("UPDATE input_requests SET status='answered',answers=?,answered_at=? WHERE id=?").run(answers,Date.now(),row.id);
      const result=this.public(this.db.prepare('SELECT * FROM input_requests WHERE id=?').get(row.id));this.db.exec('COMMIT');return result;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  finish(id,status='completed'){
    this.db.exec('BEGIN IMMEDIATE');try{
      this.db.prepare('UPDATE input_jobs SET status=? WHERE id=?').run(status,id);
      this.db.prepare("UPDATE input_requests SET status='cancelled' WHERE job_id=? AND status='pending'").run(id);this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
}
