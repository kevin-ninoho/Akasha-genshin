import fs from 'node:fs';import crypto from 'node:crypto';
// Windows scanners can hold the old file briefly. Never delete it to replace it.
export function atomicJson(file,value){
 const temp=file+'.'+process.pid+'.'+crypto.randomUUID()+'.tmp';
 try{
  const fd=fs.openSync(temp,'wx');try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
  for(let i=0;;i++)try{fs.renameSync(temp,file);break}catch(e){if(i>=8||!['EPERM','EACCES','EBUSY'].includes(e.code))throw e;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Math.min(250,10*2**i));}
 }finally{try{fs.rmSync(temp,{force:true})}catch{}}
}
