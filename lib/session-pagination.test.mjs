import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
const {buildSessionContextPage}=await createJiti(import.meta.url,{tsconfigPaths:true}).import('./session-reader.ts');
test('pages traverse selected branch once without sibling messages',()=>{
 const entries=[];
 for(let i=0;i<230;i++)entries.push({id:'e'+i,parentId:i?'e'+(i-1):null,type:'message',timestamp:new Date(i*1000).toISOString(),message:{role:i%2?'assistant':'user',content:[{type:'text',text:'message '+i}],model:'test',provider:'test'}});
 entries.push({id:'sibling',parentId:'e10',type:'message',message:{role:'user',content:'Other branch'}});
 let before;let collected=[];
 for(let n=0;n<20;n++){const p=buildSessionContextPage(entries,'e229',before,20,{deferThinking:true,deferToolResultImages:true});assert.equal(p.context.messages.length,p.context.entryIds.length);assert.ok(p.context.messages.length<=28);collected=[...p.context.entryIds,...collected];if(!p.pagination.hasMore)break;before=p.pagination.before;}
 assert.deepEqual(collected,entries.slice(0,230).map(e=>e.id));
 assert.throws(()=>buildSessionContextPage(entries,'e229','sibling',20),/cursor/);
});
