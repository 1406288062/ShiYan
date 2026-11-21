import test from 'node:test';
import assert from 'node:assert/strict';
import {groupIssueTasks,DotsAdapter} from './dots-adapter.mjs';
const members=[{goal_id:1,issue_key:'dots',issue_title:'Dots 更新与执行环境'},{goal_id:2,issue_key:'dots',issue_title:'Dots 更新与执行环境'},{goal_id:3,issue_key:'mail',issue_title:'邮箱接入与通知'},{goal_id:4,issue_key:'mail',issue_title:'邮箱接入与通知'}];
test('issue groups preserve history and select the outstanding phase',()=>{
 const tasks=[{id:1,title:'更新',status:'cancelled',updatedAt:20,createdAt:1},{id:2,title:'修复',status:'blocked',updatedAt:10,createdAt:2},{id:3,title:'评估',status:'done',acceptanceStatus:'accepted',updatedAt:11,createdAt:3},{id:4,title:'接入',status:'cancelled',updatedAt:12,createdAt:4}];
 const groups=groupIssueTasks(tasks,members);assert.equal(groups.length,2);assert.equal(groups[0].task.id,2);assert.equal(groups[0].tasks.length,2);assert.equal(groups[0].updatedAt,20);assert.equal(groups[1].task.id,4);assert.equal(tasks[0].status,'cancelled');
 tasks[1].status='done';tasks[1].acceptanceStatus='accepted';tasks[1].updatedAt=30;const after=groupIssueTasks(tasks,members);assert.equal(after[0].key,groups[0].key);assert.equal(after[0].task.id,2);
});
test('unrelated work stays independent and invisible memberships add no rows',()=>{
 const groups=groupIssueTasks([{id:8,title:'图片预览',status:'active',updatedAt:1,createdAt:1}],members);assert.equal(groups.length,1);assert.equal(groups[0].key,'conversation:8');assert.equal(groups[0].title,'图片预览');
});
