import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';import{buildBlocks,summarizeBlocks,blockHintForPrompt,BLOCK_KINDS}from'../engine/lib/blocks.mjs';import{openV1}from'../engine/lib/v1-data.mjs';
const v1=openV1(process.env.KB_DATA_DIR || path.resolve('engine/data'),{writable:false});let pass=0;
for(const [q,kind]of [['有哪些关于蒙德历史的考据文章','lore'],['有哪些角色PV','char-video'],['有哪些成就','achievement'],['有哪些食物','food'],['有哪些材料道具','item']]){
 const b=buildBlocks({v1,question:q});const list=b.find(x=>x.kind==='list');assert.ok(list, q);assert.equal(list.domain,'obc',q);assert.ok(!b.some(x=>x.domain==='character'),q);assert.ok(blockHintForPrompt(b).includes(list.title));console.log('PASS relevant list '+kind);pass++;
}
for(const kind of BLOCK_KINDS){const summary=summarizeBlocks([{kind,title:'fixture',total:5,rows:[['a'],['b']],truncated:true}])[0];assert.equal(summary.count,5);assert.equal(summary.shown,2);assert.equal(summary.truncated,true);console.log('PASS summary '+kind);pass++;}
v1.close();console.log('Result: '+pass+'/'+pass+' passed');
