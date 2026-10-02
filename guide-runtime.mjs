import {existsSync,readFileSync,mkdirSync,chmodSync,renameSync,unlinkSync,createWriteStream} from 'node:fs';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {GuideAccess,loadPrivateKey} from './guide-access.mjs';
import {createGuideRouter,verifyGuideFile,clientIP} from './guide-http.mjs';
import {makeAdapters} from './guide-make.mjs';
import {GuideKnowledge} from './guide-knowledge.mjs';
import {GuideReader} from './guide-reader.mjs';
import {guideForChat,NO_GUIDE} from './guide-chat.mjs';

const CONFIG='/etc/secrets/nw-guide-config.json',PAGES='/etc/secrets/nw-guide-pages.json',DIR='/var/data/nw-guide-access';
const SOURCE='https://nutritionworks.online/Nutrition_Works_Startgids.pdf';

export async function installPrivatePDF({file,source,hash,fetchImpl=fetch}){
 if(existsSync(file))return verifyGuideFile(file,hash);
 if(source!==SOURCE)throw Error('Approved bootstrap source required');
 const tmp=file+'.installing';
 // A prior interrupted download is never accepted as the actual document.
 if(existsSync(tmp))unlinkSync(tmp);
 const r=await fetchImpl(source,{redirect:'error',signal:AbortSignal.timeout(90000)});
 if(r.status!==200||!r.body||!(r.headers.get('content-type')||'').includes('application/pdf'))throw Error('Guide download unavailable');
 let bytes=0;
 const limit=new Transform({transform(chunk,encoding,cb){bytes+=chunk.length;if(bytes>50_000_000)cb(Error('Guide too large'));else cb(null,chunk);}});
 try{
  await pipeline(Readable.fromWeb(r.body),limit,createWriteStream(tmp,{flags:'wx',mode:0o600}));
  const size=await verifyGuideFile(tmp,hash);renameSync(tmp,file);return size;
 }catch(e){if(existsSync(tmp))unlinkSync(tmp);throw e;}
}

// Synchronous mounting, asynchronous isolated initialization: a guide setup
// failure never takes down the existing Emma conversation or payment routes.
export function initGuideRuntime({express,configFile=CONFIG,pagesFile=PAGES,directory=DIR,fetchImpl=fetch,log=event=>console.log(JSON.stringify({event}))}={}){
 const router=express.Router();let handler=null,access=null,knowledge=null,reader=null,provider=null,knowledgeEnabled=false,timer=null,stopped=false,state='disabled';
 router.use((req,res,next)=>{
  if(handler)return handler(req,res,next);
  res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.status(state==='disabled'?404:503).json({error:state==='disabled'?'not_found':'temporarily_unavailable'});
 });
 const ready=(async()=>{
  if(!existsSync(configFile))return false;
  state='starting';
  try{
   const cfg=JSON.parse(readFileSync(configFile,'utf8'));
   if(cfg.version!==1||cfg.enabled!==true||typeof cfg.knowledgeEnabled!=='boolean')throw Error('Invalid activation configuration');
   if(directory===DIR&&!process.env.RENDER_SERVICE_ID)throw Error('Production private disk requires Render');
   mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);
   const file=directory+'/startgids.pdf',pdfSize=await installPrivatePDF({file,source:cfg.bootstrapSource,hash:cfg.pdfSHA256,fetchImpl});
   knowledge=new GuideKnowledge({file:pagesFile,expectedHash:cfg.pagesSHA256,pdfHash:cfg.pdfSHA256});
   const adapters=makeAdapters({url:cfg.url,serviceKey:cfg.serviceKey,fetchImpl});
   provider=adapters.provider;knowledgeEnabled=cfg.knowledgeEnabled;
   access=new GuideAccess({database:directory+'/access.sqlite',key:loadPrivateKey(directory),...adapters});
   if(stopped){access.close();knowledge.close();access=null;knowledge=null;return false;}
   reader=new GuideReader({file,pagesFile});
   handler=createGuideRouter({express,access,pdfPath:file,pdfSize,reader,ipResolver:clientIP,onFault:log});
   state='ready';
   const drain=()=>access.drain().catch(()=>log('guide_queue_failure'));
   timer=setInterval(drain,1500);timer.unref();await drain();
   log('guide_access_ready');return true;
  }catch{
   state='unavailable';if(access)access.close();if(knowledge)knowledge.close();if(reader)await reader.close();access=null;knowledge=null;reader=null;
   log('guide_access_setup_failed');return false;
  }
 })();
 return {router,ready,status:()=>state,forChat:options=>state==='ready'&&knowledgeEnabled?guideForChat({...options,provider,knowledge}):Promise.resolve(NO_GUIDE),stop:async()=>{
  stopped=true;if(timer)clearInterval(timer);await ready;
  // Existing queued work is encrypted on disk and resumes after the restart.
  for(let i=0;access?.running&&i<65;i++)await new Promise(r=>setTimeout(r,1000));
  if(access&&!access.running){access.close();access=null;}if(knowledge){knowledge.close();knowledge=null;}if(reader){await reader.close();reader=null;}
 }};
}
