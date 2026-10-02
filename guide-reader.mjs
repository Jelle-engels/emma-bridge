import {Worker} from 'node:worker_threads';
import {readFileSync} from 'node:fs';
import {AccessError} from './guide-access.mjs';

export class GuideReader {
 constructor({file,pagesFile}){
  this.file=file;this.pages=JSON.parse(readFileSync(pagesFile,'utf8')).pages;
  if(this.pages?.length!==205)throw Error('Incomplete reader metadata');
  this.worker=null;this.pending=null;this.queue=[];this.counter=0;this.closed=false;this.initializing=null;this.retiring=null;this.rendered=0;this.idleTimer=null;
 }
 index(){return {pages:this.pages.map(p=>({page:p.page,title:p.page===1?'Afvallen met een plan':p.text.split('\n')[1]||`Pagina ${p.page}`})),worksheetPages:18};}
 async start(){
  if(this.retiring)await this.retiring;
  if(this.closed)throw new AccessError(503,'temporarily_unavailable');
  if(this.initializing)return this.initializing;
  if(this.worker)return;
  this.initializing=new Promise((resolve,reject)=>{
   const worker=new Worker(new URL('./guide-reader-worker.mjs',import.meta.url),{workerData:{file:this.file},resourceLimits:{maxOldGenerationSizeMb:192}});
   this.worker=worker;
   const timer=setTimeout(()=>{reject(new AccessError(503,'temporarily_unavailable'));worker.terminate();},25000);timer.unref();
   worker.on('message',message=>{
    if(this.worker!==worker)return;
    if(message.ready){clearTimeout(timer);resolve();return;}
    if(message.id!==this.pending?.id)return;
    const current=this.pending;this.pending=null;clearTimeout(current.timer);
    if(message.ok)current.resolve(message.value);else current.reject(new AccessError(503,'temporarily_unavailable'));
    this.rendered++;
    if(this.rendered>=16)this.retire();else this.next();
   });
   const failed=()=>{
    if(this.worker!==worker)return;
    clearTimeout(timer);this.initializing=null;this.worker=null;
    const error=new AccessError(503,'temporarily_unavailable');reject(error);
    if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(error);this.pending=null;}
    for(const item of this.queue.splice(0))item.reject(error);
   };
   worker.on('error',failed);worker.on('exit',failed);
  });
  return this.initializing;
 }
 async render(kind,values={}){
  if(this.closed)throw new AccessError(503,'temporarily_unavailable');
  if(this.queue.length>=6)throw new AccessError(429,'try_later');
  await this.start();
  if(this.queue.length>=6)throw new AccessError(429,'try_later');
  return new Promise((resolve,reject)=>{this.queue.push({id:++this.counter,kind,...values,resolve,reject});this.next();});
 }
 next(){
  clearTimeout(this.idleTimer);
  if(this.closed||this.pending)return;
  if(!this.queue.length){if(this.worker){this.idleTimer=setTimeout(()=>this.retire(),120000);this.idleTimer.unref();}return;}
  if(!this.worker){this.start().then(()=>this.next()).catch(()=>{for(const item of this.queue.splice(0))item.reject(new AccessError(503,'temporarily_unavailable'));});return;}
  const item=this.queue.shift();this.pending=item;
  item.timer=setTimeout(()=>this.worker?.terminate(),25000);item.timer.unref();
  const {resolve,reject,timer,...request}=item;this.worker.postMessage(request);
 }
 page(page,email){return this.render('page',{page,email});}
 async worksheets(){return Buffer.from(await this.render('worksheets'));}
 retire(){
  if(this.pending||!this.worker)return;
  clearTimeout(this.idleTimer);const worker=this.worker;this.worker=null;this.initializing=null;this.rendered=0;
  this.retiring=worker.terminate().finally(()=>{this.retiring=null;if(!this.closed)this.next();});
 }
 async close(){
  this.closed=true;clearTimeout(this.idleTimer);
  if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(new AccessError(503,'temporarily_unavailable'));this.pending=null;}
  for(const item of this.queue.splice(0))item.reject(new AccessError(503,'temporarily_unavailable'));
  if(this.worker){const worker=this.worker;this.worker=null;await worker.terminate();}if(this.retiring)await this.retiring;
 }
}
