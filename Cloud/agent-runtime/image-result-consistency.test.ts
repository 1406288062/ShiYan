import assert from 'node:assert/strict';
import {reconcileImageResultText, verifiedGeneratedImageCount} from './image-result-consistency.ts';
const image = {id:'generated',mimeType:'image/png',sha256:'abc'};
const uploads = {id:'uploaded',mimeType:'image/jpeg',sha256:'upload'};
const store = {generated:{file:'/tmp/valid-generated',sha256:'abc'},uploaded:{file:'/tmp/input',sha256:'upload'}};
const existing = p => p === '/tmp/valid-generated';
const scenarios=[
 ['portrait fallback with actual image','抱歉，图片生成没有成功返回图片。你可以再试一次。','图片已生成。',true],
 ['portrait failure with no image','抱歉，图片生成没有成功返回图片。','抱歉，图片生成没有成功返回图片。',false],
 ['actual image and contradictory fallback','图片生成没有返回可展示的结果。你可以再发一次生成请求，我会重新尝试。','图片已生成。',true],
 ['description plus fallback','插画采用了自然暖光。\n\n图片生成没有返回可展示的结果。','插画采用了自然暖光。\n\n图片已生成。',true],
 ['model success stays verbatim','这张图片已经生成。','这张图片已经生成。',true],
 ['regular answer stays verbatim','你好，天气很好。','你好，天气很好。',true],
 ['generation pending when image actually exists','图片正在生成中，完成后把结果发给你。','图片已生成。',true],
 ['failure with no generated image','图片生成没有返回可展示的结果。','图片生成没有返回可展示的结果。',false],
 ['timeout with no generated image','网络超时，生成失败。','网络超时，生成失败。',false],
 ['successful text only','这是一段文字。','这是一段文字。',false],
 ['unrelated tool error preserved','图片下载失败。','图片下载失败。',true],
 ['older image turn not counted','图片生成没有返回可展示的结果。','图片生成没有返回可展示的结果。',false],
 ['eventual artifact after failed text','图片生成没有返回可展示的结果。','图片已生成。',true],
 ['empty response with verified image','','',true],
];
for(const [name,original,expected,valid] of scenarios){
 assert.equal(reconcileImageResultText(original,valid),expected,name);
 console.log('PASS '+name);
}
const jobs=[
 [{assets:[image]},1],
 [{assets:[uploads]},0],
 [{assets:[{...image,sha256:'bad'}]},0],
 [{assets:[{...image,mimeType:'text/plain'}]},0],
 [{assets:[]},0],
];
for(const [job,expected] of jobs){
 assert.equal(verifiedGeneratedImageCount(job,store,existing),expected);
}
console.log('SERVER IMAGE CONSISTENCY TESTS PASSED '+(scenarios.length+jobs.length));
