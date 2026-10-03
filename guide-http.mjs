// Public endpoints contain no static guide, raw email lookup or entitlement flags.
import {createReadStream,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {isIP} from 'node:net';
import {AccessError} from './guide-access.mjs';

const MESSAGES={invalid_code:'Deze code klopt niet of is verlopen. Controleer de code of vraag een nieuwe aan.',access_denied:'Je toegang kon niet worden bevestigd. Stuur gerust een berichtje naar Emma via nutritionworks.online/#emma; zij helpt je graag.',login_required:'Vul je e-mailadres in om opnieuw toegang te krijgen.',try_later:'Je hebt het te vaak geprobeerd. Probeer het later opnieuw.',temporarily_unavailable:'Dit lukt op dit moment niet. Probeer het straks opnieuw.'};
export async function verifyGuideFile(file,expectedHash){
 if(!/^[a-f0-9]{64}$/.test(expectedHash||''))throw Error('Guide fingerprint is required');
 const s=statSync(file);if(!s.isFile()||s.size<1000||s.size>50_000_000)throw Error('Invalid guide source');
 const h=createHash('sha256');for await(const b of createReadStream(file))h.update(b);
 if(h.digest('hex')!==expectedHash)throw Error('Private guide source differs from the approved version');
 return s.size;
}
// Do not trust arbitrary X-Forwarded-For. A platform-specific resolver may only
// be supplied after its proxy path has been verified. The socket IP is fail-safe:
// a shared proxy may hit a limit, but cannot be spoofed by the requesting browser.
export function clientIP(req){return isIP(req.socket?.remoteAddress||'')?req.socket.remoteAddress:null;}
export function createGuideRouter({express,access,pdfPath,pdfSize,reader=null,origins=['https://nutritionworks.online'],ipResolver=clientIP,onFault=()=>{}}){
 const router=express.Router(),allowed=new Set(origins);
 router.use((req,res,next)=>{
  res.set({'Cache-Control':'no-store, private, max-age=0','Pragma':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow','Vary':'Origin'});
  const origin=req.get('origin');
  if(!origin||!allowed.has(origin))return res.status(403).json({error:'origin_not_allowed'});
  res.set({'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'POST, GET, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Max-Age':'300'});
  if(req.method==='OPTIONS')return res.sendStatus(204);
  // URL credentials leak through access logs and browser history; never accept them.
  if(Object.keys(req.query||{}).length)return res.status(400).json({error:'invalid_request'});
  next();
 });
 router.use((req,res,next)=>{const worksheetForm=req.path==='/worksheets/file'&&req.is('application/x-www-form-urlencoded');if(req.method==='POST'&&!req.is('application/json')&&!worksheetForm)return res.status(415).json({error:'json_required'});next();});
 router.use(express.json({limit:'4kb',strict:true}));
 const wrap=fn=>(req,res,next)=>Promise.resolve().then(()=>fn(req,res)).catch(next);
 const bearer=req=>{const match=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get('authorization')||'');return match?.[1]||'';};
 const cleanBody=(req,keys)=>{
  if(!req.body||Array.isArray(req.body)||typeof req.body!=='object'||Object.keys(req.body).some(k=>!keys.includes(k)))throw new AccessError(400,'invalid_request');
  return req.body;
 };
 router.post('/request',wrap(async(req,res)=>{
  const body=cleanBody(req,['deliveryKey','email']);
  if(typeof body.deliveryKey!=='string'&&typeof body.email!=='string')throw new AccessError(400,'invalid_request');
  if((body.deliveryKey?.length||0)>256||(body.email?.length||0)>254)throw new AccessError(400,'invalid_request');
  res.status(202).json(access.request(body,ipResolver(req)));
 }));
 router.post('/verify',wrap(async(req,res)=>res.json(await access.verify(cleanBody(req,['requestId','requestProof','code']),ipResolver(req)))));
 router.get('/session',wrap(async(req,res)=>{
  await access.authorize(bearer(req));res.json({authorized:true});
 }));
 router.post('/logout',wrap(async(req,res)=>{cleanBody(req,[]);access.logout(bearer(req));res.sendStatus(204);}));
 router.get('/reader',wrap(async(req,res)=>{
  const grant=await access.authorize(bearer(req));
  if(!reader)throw new AccessError(503,'temporarily_unavailable');
  res.json({...reader.index(),personalEmail:grant.email});
 }));
 router.post('/reader/page',wrap(async(req,res)=>{
  const body=cleanBody(req,['page']);
  if(!Number.isInteger(body.page)||body.page<1||body.page>205)throw new AccessError(400,'invalid_request');
  const grant=await access.authorize(bearer(req));
  if(!reader)throw new AccessError(503,'temporarily_unavailable');
  // Neither the customer nor the page URL can choose a watermark identity.
  res.json(await reader.page(body.page,grant.email));
 }));
 router.get('/worksheets',wrap(async(req,res)=>{
  await access.authorize(bearer(req));
  if(!reader)throw new AccessError(503,'temporarily_unavailable');
  const pdf=await reader.worksheets();
  res.set({'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="Nutrition_Works_Invulbladen.pdf"','Content-Security-Policy':"sandbox; default-src 'none'"});
  res.send(pdf);
 }));
 router.post('/worksheets/ticket',wrap(async(req,res)=>{
  const body=cleanBody(req,['disposition']);
  res.json(await access.worksheetTicket(bearer(req),body.disposition));
 }));
 router.post('/worksheets/file',express.urlencoded({extended:false,limit:'1kb'}),wrap(async(req,res)=>{
  if(!req.is('application/x-www-form-urlencoded'))throw new AccessError(415,'invalid_request');
  const body=cleanBody(req,['ticket']),disposition=await access.consumeWorksheetTicket(body.ticket);
  if(!reader)throw new AccessError(503,'temporarily_unavailable');
  const pdf=await reader.worksheets();
  // Ordinary HTTPS response: no blob navigation, popup or reusable public link.
  res.set({'Content-Type':'application/pdf','Content-Disposition':disposition+'; filename="Nutrition_Works_Invulbladen.pdf"','Content-Security-Policy':"sandbox allow-downloads; default-src 'none'; frame-ancestors 'none'"});
  res.send(pdf);
 }));
 router.get('/download',wrap(async(req,res)=>{
  await access.authorize(bearer(req));
  res.status(410).json({error:'online_reader',message:'De gids lees je nu online. Vernieuw de toegangspagina om je gids te openen.'});
 }));
 router.use((req,res)=>res.status(404).json({error:'not_found'}));
 router.use((err,req,res,next)=>{
  if(res.headersSent){res.destroy();return;}
  let status=err instanceof AccessError?err.status:err.type==='entity.too.large'?413:err.type==='entity.parse.failed'?400:503;
  const code=err instanceof AccessError?err.code:status===413?'body_too_large':status===400?'invalid_request':'temporarily_unavailable';
  if(status===503)onFault('guide_service_unavailable');
  if(status===429)res.set('Retry-After','600');
  res.status(status).json({error:code,message:MESSAGES[code]||'Controleer je invoer en probeer het opnieuw.'});
 });
 return router;
}
