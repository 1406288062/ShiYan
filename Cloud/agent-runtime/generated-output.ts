// Generated deliverables are documents and images, not executor transports.
const documentExtensions = new Set(['doc','docx','docm','dot','dotx','dotm','rtf','odt','pdf','xls','xlsx','xlsm','xlsb','xlt','xltx','xltm','csv','ods','ppt','pptx','pptm','pot','potx','potm','pps','ppsx','ppsm','odp','pages','numbers']);
const imageExtensions = new Set(['png','jpg','jpeg','webp','gif','heic','heif','tif','tiff','bmp','avif','svg']);
const internalDirectories = new Set(['.shiyan','.git','.codex','.venv','node_modules','__pycache__','inputs']);
export function internalGeneratedPath(value: any) {
  const parts=String(value||'').replace(/\\/g,'/').split('/').filter(Boolean);
  return parts.some(part=>internalDirectories.has(part.toLowerCase())||part.startsWith('.'));
}
export function generatedOutputVisible(asset: any) {
  if(!asset||typeof asset.filename!=='string'||internalGeneratedPath(asset.filename))return false;
  const extension=asset.filename.split('.').at(-1).toLowerCase();
  return documentExtensions.has(extension)||imageExtensions.has(extension);
}
export function generatedPathVisible(value: any) {
  return !internalGeneratedPath(value)&&generatedOutputVisible({filename:String(value).replace(/\\/g,'/').split('/').at(-1)});
}
export function generatedOutputs(assets: any) {
  return (Array.isArray(assets)?assets:[]).filter(generatedOutputVisible);
}
