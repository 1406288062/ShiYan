import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {normalizeFiles,writeFileInputs} from './file-input.ts';
const encode=text=>Buffer.from(text).toString('base64');
const files=normalizeFiles([{filename:'../../notes.txt',data:encode('完整内容\n第二行')},{filename:'notes.txt',data:encode('second')}]);
assert.equal(files[0].filename,'notes.txt');
assert.throws(()=>normalizeFiles([{filename:'a',data:'not base64!'}]),/格式/);
assert.throws(()=>normalizeFiles([{filename:'..',data:''}]),/文件名/);
assert.throws(()=>normalizeFiles(Array.from({length:9},()=>({filename:'a',data:''}))),/过多/);
assert.throws(()=>normalizeFiles([{filename:'a',data:Buffer.alloc(10*1024*1024+1).toString('base64')}]),/大小|10 MB/);
assert.throws(()=>normalizeFiles(Array.from({length:3},()=>({filename:'a',data:Buffer.alloc(9*1024*1024).toString('base64')}))),/24 MB/);
assert.equal(normalizeFiles(undefined).length,0);
const dir=await mkdtemp(path.join(os.tmpdir(),'shiyan-files-'));
try {
 const reference=await writeFileInputs(files,dir);
 const records=JSON.parse(reference.slice(reference.indexOf('\n')+1));
 assert.notEqual(records[0].path,records[1].path);
 assert(records.every(x=>path.dirname(x.path)===dir));
 assert.equal(await readFile(records[0].path,'utf8'),'完整内容\n第二行');
 assert.equal(await readFile(records[1].path,'utf8'),'second');
 console.log('PASS: files preserved, attachment paths supplied, duplicate names isolated, traversal and size limits checked');
}finally{await rm(dir,{recursive:true,force:true});}
