// Fixed, private Make bridge. Never expose its address or secret to a browser.
import {AccessError,emailKey,verifiedGrant} from './guide-access.mjs';
const F={reference:'fld8XHWevZMlDzhxH',userId:'fldIZfQhYodHeLPaj',email:'fldGVAcyGOz4InVUc',status:'fldJwx2pWemb4LDhD',source:'fldy36VZLVjF4OgID',confirmedAt:'fldk4iTDpcF7yA4zB',version:'fldnU45i6d6NbctM9',expiresAt:'fldepeUJcZMiuS5xN'};
export function canonicalGrant(row){
 if(!row||typeof row!=='object'||!row.fields||typeof row.fields!=='object')return null;
 const out={id:row.id};for(const [name,id]of Object.entries(F))out[name]=row.fields[id];
 return verifiedGrant(out);
}
export function makeAdapters({url,serviceKey,fetchImpl=fetch}){
 const endpoint=new URL(url);
 if(endpoint.protocol!=='https:'||endpoint.hostname!=='hook.eu1.make.com'||endpoint.search||endpoint.hash||endpoint.username||endpoint.password||!/^\/[a-z0-9]{32}$/.test(endpoint.pathname)||!/^[A-Za-z0-9_-]{43}$/.test(serviceKey))throw Error('Invalid private Make bridge configuration');
 async function invoke(operation,values,timeout=18000){
  const r=await fetchImpl(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...values,operation,serviceKey}),redirect:'error',signal:AbortSignal.timeout(timeout)});
  if(r.status===404&&operation==='get')return null;
  if(!r.ok||!(r.headers.get('Content-Type')||'').includes('application/json'))throw new AccessError(503,'temporarily_unavailable');
  const text=await r.text();if(text.length>65536)throw new AccessError(503,'temporarily_unavailable');
  try{return JSON.parse(text);}catch{throw new AccessError(503,'temporarily_unavailable');}
 }
 const provider={
  async get(id){if(!/^rec[A-Za-z0-9]{14}$/.test(id||''))return null;const row=await invoke('get',{id});const g=canonicalGrant(row);return g?.id===id?g:null;},
  async findByEmail(value){
   const email=emailKey(value);if(email.length>254||!email.includes('@'))return null;
   // Airtable double-quoted literals use backslash escaping. JSON encoding also
   // covers backslashes, quotes and controls, so input cannot change the formula.
   const literal=JSON.stringify(email),formula=`AND(LOWER({email})=${literal},{access_status}="active")`;
   const data=await invoke('find',{formula});
   if(!Array.isArray(data?.records))throw new AccessError(503,'temporarily_unavailable');
   if(data.records.length!==1||data.offset)return null;
   const g=canonicalGrant(data.records[0]);return g?.email===email?g:null;
  }
 };
 const mailer=async data=>{
  if(!/^rec[A-Za-z0-9]{14}$/.test(data.grantId||'')||!/^\d{6}$/.test(data.code||'')||!Number.isSafeInteger(data.grantVersion)||data.grantVersion<1||!Number.isFinite(data.expiresAt)||data.expiresAt<=Date.now())throw new AccessError(403,'access_denied');
  const result=await invoke('mail',{id:data.grantId,grantVersion:data.grantVersion,recipient:emailKey(data.recipient),code:data.code,expiresAt:data.expiresAt,requestId:data.requestId},60000);
  if(result?.sent!==true)throw new AccessError(503,'temporarily_unavailable');
 };
 return {provider,mailer};
}
