import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountStore } from './accounts.ts';
import { RegistrationEmail, mailConfigured, registrationMailEnvironment } from './registration-email.ts';
const password = 'test-only-password-42';
function fixture(t, options={}) {
  const root=mkdtempSync(path.join(os.tmpdir(),'shiyan-otp-'));
  let now=1000000; const messages: any[]=[];
  const store=new AccountStore(root,{now:()=>now});
  const mail=new RegistrationEmail(store,{configured:()=>true,send:async m=>{messages.push(m);},...options});
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  return {root,store,mail,messages,advance:ms=>now+=ms,code:()=>messages.at(-1).text.match(/\d{6}/)[0]};
}
test('six-digit email code is bound to normalized email, consumed atomically, and grants only ordinary role',async t=>{
  const f=fixture(t); const result=await f.mail.request({email:'  Member@Example.Test '},'ip');
  assert.deepEqual(result,{ok:true,expiresIn:600,resendAfter:60});assert.match(f.code(),/^\d{6}$/);
  assert.throws(()=>f.mail.check({email:'other@example.test',verificationCode:f.code()}));
  const input={email:'member@example.test',password,verificationCode:f.code(),role:'admin'};
  const consume=f.mail.check(input),other=f.mail.check(input);
  assert(!readFileSync(path.join(f.root,'accounts.sqlite3')).includes(Buffer.from(f.code())));
  const account=await f.store.register(input,{verifyEmail:consume});assert.equal(account.user.role,'user');
  assert.equal(account.user.serverAccess,false);
  assert.throws(()=>f.store.transaction(other));assert.throws(()=>f.mail.check(input));
});
test('wrong guesses stay counted, five guesses lock, and expired codes never create accounts',async t=>{
  const f=fixture(t);await f.mail.request({email:'a@example.test'},'ip');
  const wrong=f.code()==='000000'?'111111':'000000';
  for(let i=0;i<5;i++)assert.throws(()=>f.mail.check({email:'a@example.test',verificationCode:wrong}));
  assert.throws(()=>f.mail.check({email:'a@example.test',verificationCode:f.code()}),{status:429});
  f.advance(60001);await f.mail.request({email:'a@example.test'},'ip');
  const consume=f.mail.check({email:'a@example.test',verificationCode:f.code()});f.advance(600000);
  await assert.rejects(f.store.register({email:'a@example.test',password},{verifyEmail:consume}));
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM account_users').get()!.n,0);
});
test('resend cooldown and replacement invalidate the previous registration claim',async t=>{
  const f=fixture(t);await f.mail.request({email:'a@example.test'},'ip');
  const consume=f.mail.check({email:'a@example.test',verificationCode:f.code()});
  await assert.rejects(f.mail.request({email:'a@example.test'},'ip'),{status:429});
  f.advance(60001);await f.mail.request({email:'a@example.test'},'ip');
  assert.throws(()=>f.store.transaction(consume));
});
test('failed delivery and missing SMTP configuration fail closed',async t=>{
  const f=fixture(t,{send:async()=>{throw Object.assign(new Error('delivery'),{status:503});}});
  await assert.rejects(f.mail.request({email:'a@example.test'},'ip'),{status:503});
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM registration_email_codes').get()!.n,0);
  const offline=fixture(t,{configured:()=>false});
  await assert.rejects(offline.mail.request({email:'a@example.test'},'ip'),{status:503});
  assert.equal(mailConfigured({}),false);
  assert.equal(mailConfigured({SHIYAN_MAIL_FROM:'sender@example.test',SHIYAN_SMTP_HOST:'smtp.example.test',SHIYAN_SMTP_USER:'sender',SHIYAN_SMTP_PASSWORD:'test'}),true);
});
test('delivery must finish before a code can be used',async t=>{
  let release;const f=fixture(t,{send:()=>new Promise(r=>release=r)});
  const sending=f.mail.request({email:'a@example.test'},'ip');
  assert.throws(()=>f.mail.check({email:'a@example.test',verificationCode:'000000'}));
  release();await sending;
});

test('existing QQ configuration is resolved without copying credentials and honours disablement', t => {
  const f = fixture(t), filename = path.join(f.root, 'qq-mail.json');
  const env: any = { SHIYAN_SMTP_CONFIG: filename };
  assert.equal(mailConfigured(env), false);
  writeFileSync(filename, JSON.stringify({enabled:true,address:'sender@example.test',authorizationCode:'fixture-code'}), {mode:0o600});
  const resolved = registrationMailEnvironment(env);
  assert.equal(mailConfigured(env), true);
  assert.equal(resolved.SHIYAN_SMTP_HOST, 'smtp.qq.com');
  assert.equal(resolved.SHIYAN_SMTP_PORT, '465');
  assert.equal(resolved.SHIYAN_MAIL_FROM, 'sender@example.test');
  assert.equal(resolved.SHIYAN_SMTP_PASSWORD, 'fixture-code');
  assert.equal(env.SHIYAN_SMTP_PASSWORD, undefined);
  assert.equal(registrationMailEnvironment({...env,SHIYAN_MAIL_FROM:'custom@example.test'}).SHIYAN_MAIL_FROM, 'custom@example.test');
  writeFileSync(filename, JSON.stringify({enabled:false,address:'sender@example.test',authorizationCode:'fixture-code'}));
  assert.equal(mailConfigured(env), false);
  writeFileSync(filename, '{invalid'); assert.equal(mailConfigured(env), false);
});
