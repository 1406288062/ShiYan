import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
const root=mkdtempSync(path.join(os.tmpdir(),'shiyan-reset-'));
process.env.SHIYAN_ROOT=root;
const {AccountStore}=await import('./accounts.ts');
const {RegistrationEmail}=await import('./registration-email.ts');
const {createAccountHandler}=await import('./account-http.ts');
const password='initial-test-password',nextPassword='new-test-password-2026';
test.after(()=>rmSync(root,{recursive:true,force:true}));
async function fixture(t){
 let now=1000000;const messages: any[]=[];
 const store=new AccountStore(path.join(root,randomUUID()),{now:()=>now,registrationSocketPath:false});t.after(()=>store.close());
 const member=await store.register({email:'member@example.test',password});
 const other=await store.register({email:'other@example.test',password});
 const mail=new RegistrationEmail(store,{purpose:'password-reset',configured:()=>true,secret:Buffer.alloc(32,7),send:async m=>{messages.push(m);}});
 const input=()=>({email:member.user.email,password:nextPassword,confirmPassword:nextPassword,verificationCode:messages.at(-1).text.match(/：([0-9]{6})/)[1]});
 return {store,mail,member,other,messages,input,advance:ms=>now+=ms};
}
test('verified reset rotates password, revokes only the matching account sessions and cannot be reused',async t=>{
 const f=await fixture(t);await f.mail.request({email:f.member.user.email},'ip');
 assert.match(f.messages[0].subject,/密码重置/);
 const input=f.input(),claim=f.mail.check(input);
 assert.deepEqual(await f.store.resetPassword(input,{verifyEmail:claim}),{ok:true});
 assert.equal(f.store.authenticate(f.member.token),null);assert(f.store.authenticate(f.other.token));
 await assert.rejects(f.store.login({email:input.email,password}),{status:401});
 const session=await f.store.login({email:input.email,password:nextPassword});assert.equal(session.user.id,f.member.user.id);assert.equal(session.user.role,'user');
 assert.throws(()=>f.mail.check(input));
 await assert.rejects(f.store.resetPassword(input,{verifyEmail:claim}));
 assert.equal(f.store.authenticate(session.token)!.userId,f.member.user.id);
});
test('expired and replaced claims cannot change password',async t=>{
 const f=await fixture(t);await f.mail.request({email:f.member.user.email},'ip');
 const input=f.input(),claim=f.mail.check(input);f.advance(600001);
 await assert.rejects(f.store.resetPassword(input,{verifyEmail:claim}));assert(f.store.authenticate(f.member.token));
 await f.mail.request({email:f.member.user.email},'ip');const second=f.input(),oldClaim=f.mail.check(second);
 f.advance(60001);await f.mail.request({email:f.member.user.email},'ip');
 await assert.rejects(f.store.resetPassword(second,{verifyEmail:oldClaim}));
});
test('five wrong guesses lock the reset code; registration codes cannot consume reset challenges',async t=>{
 const f=await fixture(t);await f.mail.request({email:f.member.user.email},'ip');const input=f.input();
 const registration=new RegistrationEmail(f.store,{configured:()=>true,secret:Buffer.alloc(32,7),send:async()=>{}});
 assert.throws(()=>registration.check(input));
 const wrong=input.verificationCode==='000000'?'111111':'000000';
 for(let i=0;i<5;i++)assert.throws(()=>f.mail.check({...input,verificationCode:wrong}));
 assert.throws(()=>f.mail.check(input),{status:429});assert(f.store.authenticate(f.member.token));
});
test('unknown addresses get the same response and cooldown without revealing a user or sending mail',async t=>{
 const f=await fixture(t);const known=await f.mail.request({email:f.member.user.email},'ip');
 const unknown=await f.mail.request({email:'unknown@example.test'},'ip');assert.deepEqual(unknown,known);assert.equal(f.messages.length,1);
 await assert.rejects(f.mail.request({email:'unknown@example.test'},'ip'),{status:429});
});
test('reset requires email proof and matching strong password; disabled accounts stay disabled',async t=>{
 const f=await fixture(t);await f.mail.request({email:f.member.user.email},'ip');const input=f.input();
 await assert.rejects(f.store.resetPassword(input));
 await assert.rejects(f.store.resetPassword({...input,password:'short',confirmPassword:'short'},{verifyEmail:f.mail.check(input)}));
 await assert.rejects(f.store.resetPassword({...input,confirmPassword:'different'},{verifyEmail:f.mail.check(input)}));
 f.store.db.prepare("UPDATE account_users SET status='disabled' WHERE id=?").run(f.member.user.id);
 await assert.rejects(f.store.resetPassword(input,{verifyEmail:f.mail.check(input)}));
});
test('two simultaneous uses of the same verified code allow only one password update',async t=>{
 const f=await fixture(t);await f.mail.request({email:f.member.user.email},'ip');const input=f.input();
 const a=f.mail.check(input),b=f.mail.check(input);
 const results=await Promise.allSettled([f.store.resetPassword(input,{verifyEmail:a}),f.store.resetPassword(input,{verifyEmail:b})]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(results.filter(x=>x.status==='rejected').length,1);
});
test('password-reset HTTP endpoints work without logging in and never issue a session',async t=>{
 const f=await fixture(t),handler=createAccountHandler({store:f.store,passwordResetEmail:f.mail});
 const server=http.createServer((req,res)=>handler(req,res));await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',()=>resolve()));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const post=(route,body)=>fetch('http://127.0.0.1:'+(server.address() as any).port+'/v1/auth/'+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 let response=await post('password-reset-code',{email:f.member.user.email});assert.equal(response.status,200);
 response=await post('password-reset',f.input());assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true});assert.equal(response.headers.get('set-cookie'),null);
 response=await post('login',{email:f.member.user.email,password:nextPassword});assert.equal(response.status,200);
});
