import path from 'node:path';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const colors = new Set(['#bdc4d5','#00b4ef','#ffd139','#d469da','#bada10','#ed729c','#f79557','#7293f1']);
const invalid = message => Object.assign(new Error(message), {status:400,code:'invalid_profile'});
const hiddenPets = new Set(["pet_6ac34fca9ed8819191d26a7488e27b61", "pet_6abd0eab12a48191b7fbf8d7f68d393d"]);
export function createDotsProfile(adapter, root) {
  const directory=path.join(root,'data','dots-pets');
  const catalogue=()=>JSON.parse(readFileSync(path.join(directory,'manifest.json'),'utf8'));
  const stored=owner=>{const row=adapter.store.db.prepare('SELECT value FROM dots_settings WHERE key=?').get('profile:'+owner);return row?JSON.parse(row.value):{};};
  const response=value=>{
    const profile={...value};
    if(hiddenPets.has(profile.petId))delete profile.petId;
    return {ok:true,profile};
  };
  return {
    get(owner){adapter.authorize(owner);return response(stored(owner));},
    save(owner,input){
      adapter.authorize(owner);
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['name','accent','petId'].includes(k)))throw invalid('个人设置格式无效');
      const value=stored(owner);
      if('name' in input){if(typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>40)throw invalid('名称需要 1 到 40 个字');value.name=input.name.trim();}
      if('accent' in input){if(!colors.has(input.accent))throw invalid('请选择可用颜色');value.accent=input.accent;}
      if('petId' in input){if(hiddenPets.has(input.petId)||!catalogue().pets.some(p=>p.id===input.petId))throw invalid('桌宠不存在');value.petId=input.petId;}
      if(hiddenPets.has(value.petId))delete value.petId;
      const result=response(value);let event;
      adapter.store.transaction(()=>{
        adapter.store.db.prepare('INSERT INTO dots_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('profile:'+owner,JSON.stringify(value));
        event=adapter.store.append(owner,0,'profile',{profile:value},'profile:'+randomUUID());
      });
      adapter.publish(event,owner);return result;
    }
  };
}
