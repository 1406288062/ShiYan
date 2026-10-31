import { existsSync } from 'node:fs';
// The server knows which generated files it received. Model prose is not proof
// that an image was (or was not) delivered.
export function reconcileImageResultText(raw, hasVerifiedGeneratedImage) {
  const text = typeof raw === 'string' ? raw : '';
  if (!hasVerifiedGeneratedImage) return text;
  let changed = false;
  const kept = text.split(/\n\s*\n/).map(x => x.trim()).filter(Boolean).filter(paragraph => {
    const falseNegative = /(?:图片|图像|生成结果|生成的图).{0,70}(?:没有返回|未返回|没有成功返回|未成功返回|没有生成|未能生成|生成失败|没有可展示|没有得到|无法展示|无法显示|没能交付|无法交付)/u.test(paragraph)
      || /(?:生成成功|生成完成|已经生成).{0,70}(?:没有|没能|无法).{0,70}(?:展示|显示|交付)/u.test(paragraph)
      || /(?:没有返回可展示的结果|未返回可展示的结果|没有生成任何图片|生成的图片未能展示)/u.test(paragraph);
    const staleProgress = /(?:图像|图片).{0,12}(?:正在生成中|还在生成|生成过程中).{0,90}(?:完成后|稍后|发给你)/u.test(paragraph);
    if (falseNegative || staleProgress) { changed = true; return false; }
    return true;
  });
  if (!changed) return text;
  kept.push('图片已生成。');
  return kept.join('\n\n');
}

export function verifiedGeneratedImageCount(job, storedAssets, exists) {
  return (job.assets ?? []).filter(a => {
    if (!a.id || !a.mimeType?.startsWith('image/')) return false;
    const stored = storedAssets[a.id];
    return Boolean(stored?.file && stored.sha256 === a.sha256 && exists(stored.file));
  }).length;
}

export function reconcileSyncImageResult(change,owner,store){
 if(change.kind!=='messages'||change.deleted||change.data?.role!=='assistant'||change.data.state!=='completed')return change;
 const verified=(change.data.assets||[]).some(asset=>{
  if(!asset.mimeType?.startsWith('image/')||!asset.sha256)return false;
  const row=store.db.prepare('SELECT data,file FROM sync_generated_assets WHERE owner=? AND id=?').get(owner,asset.syncAssetId||asset.id);
  if(!row)return false;const metadata=JSON.parse(row.data);
  return metadata.sha256===asset.sha256&&existsSync(row.file);
 });
 const text=reconcileImageResultText(change.data.text,verified);
 return text===change.data.text?change:{...change,data:{...change.data,text}};
}
