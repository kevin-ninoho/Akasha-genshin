import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';import{DatabaseSync}from'node:sqlite';
const KB=process.env.KB_DIR||path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine');
const {createRetriever,assembleContext,decomposeQuestion}=await import(pathToFileURL(path.join(KB,'chat/retrieve.mjs')));
const {openV1}=await import(pathToFileURL(path.join(KB,'lib/v1-data.mjs')));
const db=new DatabaseSync(path.join(process.env.KB_DATA_DIR || (process.env.KB_DATA_DIR || path.join(KB,'data')),'kb.sqlite'),{readOnly:true}),ws=new DatabaseSync(path.join(process.env.KB_DATA_DIR || (process.env.KB_DATA_DIR || path.join(KB,'data')),'kb-workspace.sqlite'),{readOnly:true});
const r=createRetriever(db,ws);let failures=0,passed=0;
function test(name,fn){try{fn();passed++;console.log('PASS '+name)}catch(e){failures++;console.log('FAIL '+name+': '+e.message)}}
const q=fs.readFileSync(new URL('./questions/lore.txt',import.meta.url),'utf8').trim();
test('long question decomposes into multiple retrieval clauses',()=>assert.ok(decomposeQuestion(q).length>=3));
test('R4 retains official dialogue inside actual context budget',()=>{const ret=r.retrieve(q),ctx=assembleContext(ret.sources,6500);assert.ok(ret.scopes.includes('dialogue'));assert.ok(ctx.kept.some(s=>s.type==='dialogue'));assert.ok(ctx.text.includes('神座')&&ctx.text.includes('权能'));assert.ok(ctx.text.includes('扮演')&&ctx.text.includes('天理'));});
test('Focalors is distinct from Furina and is namespaced',()=>{const names=r.detectEntities(q);assert.ok(names.some(e=>e.name==='芙卡洛斯'&&typeof e.id==='string'));assert.ok(names.some(e=>e.name==='芙宁娜'&&typeof e.id==='number'));});
for(const [alias,canon]of Object.entries({雷神:'雷电将军',影:'雷电将军',雷电影:'雷电将军',帝君:'钟离',摩拉克斯:'钟离'}))test(alias+' maps to '+canon,()=>assert.ok(r.detectEntities(alias+'是谁').some(e=>e.name===canon)));
test('single character nickname does not match ordinary words',()=>assert.ok(!r.detectEntities('影子与电影摄影有什么关系').some(e=>e.name==='雷电将军')));
test('inherited playable entity still retrieves in a followup',()=>{const e=r.detectEntities('胡桃是谁');assert.ok(r.retrieve('她的语音呢',{inherited:e}).sources.some(s=>s.type==='voice'));});
const v1=openV1((process.env.KB_DATA_DIR || path.join(KB,'data')),{writable:false});test('nickname anchors use the same canonical names',()=>assert.ok(v1.findAnchors('帝君是谁').some(e=>e.name==='钟离')));v1.close();db.close();ws.close();
console.log(`Result: ${passed}/${passed+failures} passed`);process.exitCode=failures?1:0;
