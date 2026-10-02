// Private guide access. No customer identifiers, codes or secrets are logged.
// This module must remain disabled until its Airtable/Make adapters are verified.
import {DatabaseSync} from 'node:sqlite';
import {randomBytes, randomInt, createHmac, timingSafeEqual, createCipheriv, createDecipheriv} from 'node:crypto';
import {mkdirSync, chmodSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const MINUTE=60_000, HOUR=60*MINUTE, DAY=24*HOUR;
const TOKEN=/^[A-Za-z0-9_-]{43}$/;
const GRANT_ID=/^rec[A-Za-z0-9]{14}$/;
const SOURCES=new Set(['stripe_confirmed','programme_confirmed','owner_grant']);
const token=()=>randomBytes(32).toString('base64url');
export const emailKey=value=>typeof value==='string'?value.trim().toLowerCase():'';
const emailOK=value=>typeof value==='string'&&value.length<=254&&/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
const equal=(a,b)=>{if(typeof a!=='string'||typeof b!=='string')return false;const aa=Buffer.from(a),bb=Buffer.from(b);return aa.length===bb.length&&timingSafeEqual(aa,bb);};
export class AccessError extends Error {
 constructor(status,code){super(code);this.status=status;this.code=code;}
}

export function verifiedGrant(row,now=Date.now()){
 if(!row||!GRANT_ID.test(row.id||'')||row.status!=='active'||!SOURCES.has(row.source))return null;
 if(!emailOK(row.email)||!/^\d{8,15}$/.test(row.userId||''))return null;
 if(typeof row.reference!=='string'||!row.reference.trim()||row.reference.length>200)return null;
 if(!Number.isSafeInteger(row.version)||row.version<1)return null;
 const confirmed=Date.parse(row.confirmedAt),until=row.expiresAt?Date.parse(row.expiresAt):null;
 if(!Number.isFinite(confirmed)||confirmed>now||!(!row.expiresAt||(Number.isFinite(until)&&until>now)))return null;
 return {...row,email:emailKey(row.email)};
}

export function loadPrivateKey(directory){
 mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);
 const file=path.join(directory,'access.key');
 try{writeFileSync(file,randomBytes(32),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
 const key=readFileSync(file);if(key.length!==32)throw Error('Invalid private access key');
 chmodSync(file,0o600);return key;
}

export class GuideAccess {
 constructor({database,key,provider,mailer,now=Date.now,codeGenerator=()=>String(randomInt(0,1_000_000)).padStart(6,'0')}){
  if(!Buffer.isBuffer(key)||key.length!==32)throw Error('32-byte private key required');
  if(!provider?.get||!provider?.findByEmail||!mailer)throw Error('Verified entitlement provider and mailer required');
  this.key=key;this.provider=provider;this.mailer=mailer;this.now=now;this.codeGenerator=codeGenerator;
  this.db=new DatabaseSync(database,{timeout:5000});
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
   CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY, proof TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL,
    created INTEGER NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    grant_id TEXT, grant_version INTEGER, recipient_hash TEXT, code_mac TEXT
   ) STRICT;
   CREATE INDEX IF NOT EXISTS request_queue ON requests(state,created);
   CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, grant_version INTEGER NOT NULL,
    recipient_hash TEXT NOT NULL, expires INTEGER NOT NULL
   ) STRICT;
   CREATE TABLE IF NOT EXISTS limits (
    bucket TEXT PRIMARY KEY, used INTEGER NOT NULL, expires INTEGER NOT NULL
   ) STRICT;
   CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY, event TEXT NOT NULL, occurred INTEGER NOT NULL, subject_hash TEXT
   ) STRICT;`);
  if(database!==':memory:')chmodSync(database,0o600);
  // After a process crash, never resend an uncertain email or revive a consumed code.
  this.db.prepare("UPDATE requests SET state='failed',payload='',code_mac=NULL WHERE state='processing'").run();
  this.running=false;
 }
 close(){this.db.close();}
 mac(purpose,value){return createHmac('sha256',this.key).update(purpose+'\0'+value).digest('base64url');}
 encrypt(value){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.key,iv),data=Buffer.concat([c.update(JSON.stringify(value),'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),data]).toString('base64url');}
 decrypt(value){const b=Buffer.from(value,'base64url'),d=createDecipheriv('aes-256-gcm',this.key,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8'));}
 transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 audit(event,subject=''){this.db.prepare('INSERT INTO audit(event,occurred,subject_hash) VALUES(?,?,?)').run(event,this.now(),subject?this.mac('audit',subject):null);}
 cleanup(){const now=this.now();this.db.prepare('DELETE FROM requests WHERE expires<?').run(now-HOUR);this.db.prepare('DELETE FROM sessions WHERE expires<?').run(now);this.db.prepare('DELETE FROM limits WHERE expires<?').run(now);this.db.prepare('DELETE FROM audit WHERE occurred<?').run(now-30*DAY);}
 budget(scope,value,maximum,period){
  const now=this.now(),start=Math.floor(now/period)*period,bucket=this.mac('limit',scope+'|'+start+'|'+value);
  const row=this.db.prepare('SELECT used FROM limits WHERE bucket=?').get(bucket);
  if((row?.used||0)>=maximum)return false;
  this.db.prepare('INSERT INTO limits(bucket,used,expires) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET used=used+1').run(bucket,start+period);
  return true;
 }
 deliveryKey(grant){const g=verifiedGrant(grant,this.now());if(!g)throw new AccessError(403,'access_denied');const payload=Buffer.from(JSON.stringify({id:g.id,v:g.version})).toString('base64url');return payload+'.'+this.mac('delivery',payload);}
 parseDeliveryKey(key){if(typeof key!=='string'||key.length>256)return null;const [payload,signature,...extra]=key.split('.');if(extra.length||!equal(this.mac('delivery',payload),signature))return null;try{const d=JSON.parse(Buffer.from(payload,'base64url'));return GRANT_ID.test(d.id)&&Number.isSafeInteger(d.v)&&d.v>0?d:null;}catch{return null;}}
 // Constant-shape response, before any Airtable lookup or email operation.
 request({deliveryKey,email},ip){
  this.cleanup();
  if(typeof ip!=='string'||!ip)throw new AccessError(503,'temporarily_unavailable');
  const input=typeof deliveryKey==='string'?{deliveryKey:deliveryKey.slice(0,257)}:{email:emailKey(email).slice(0,255)};
  const allowed=this.transaction(()=>this.budget('request-ip',ip,10,HOUR)&&this.budget('request-global','all',120,HOUR));
  if(!allowed)throw new AccessError(429,'try_later');
  if(this.db.prepare("SELECT count(*) n FROM requests WHERE state='queued'").get().n>=100)throw new AccessError(503,'temporarily_unavailable');
  const id=token(),proof=token(),now=this.now();
  this.db.prepare("INSERT INTO requests(id,proof,payload,state,created,expires) VALUES(?,?,?,'queued',?,?)").run(this.mac('request',id),this.mac('proof',proof),this.encrypt(input),now,now+10*MINUTE);
  this.audit('code_requested',id);
  return {requestId:id,requestProof:proof,expiresIn:600,message:'Als er een geldig toegangsrecht is, ontvang je een code op het bij ons geregistreerde e-mailadres.'};
 }
 async drain(){
  if(this.running)return;this.running=true;
  try{for(let n=0;n<20;n++){
   const row=this.transaction(()=>{const r=this.db.prepare("SELECT * FROM requests WHERE state='queued' ORDER BY created LIMIT 1").get();if(r)this.db.prepare("UPDATE requests SET state='processing' WHERE id=? AND state='queued'").run(r.id);return r;});
   if(!row)break;
   try{
    if(row.expires<=this.now())throw new AccessError(403,'expired');
    const input=this.decrypt(row.payload);let raw,link;
    if(input.deliveryKey){link=this.parseDeliveryKey(input.deliveryKey);if(!link)throw new AccessError(403,'invalid');raw=await this.provider.get(link.id);}
    else if(emailOK(input.email))raw=await this.provider.findByEmail(input.email);
    const grant=verifiedGrant(raw,this.now());
    if(!grant||(link&&(grant.id!==link.id||grant.version!==link.v))||(!link&&emailKey(grant.email)!==input.email))throw new AccessError(403,'invalid');
    const allowed=this.transaction(()=>this.budget('recipient-minute',grant.email,1,MINUTE)&&this.budget('recipient-hour',grant.email,5,HOUR)&&this.budget('recipient-day',grant.email,12,DAY));
    if(!allowed)throw new AccessError(429,'try_later');
    const code=this.codeGenerator();if(!/^\d{6}$/.test(code))throw Error('Invalid code generator');
    const recipient=this.mac('recipient',grant.email),codeMac=this.mac('code',row.id+'|'+row.proof+'|'+code);
    this.transaction(()=>{
     // Resend invalidates every earlier code for this email, not just this grant.
     this.db.prepare("UPDATE requests SET state='failed',code_mac=NULL,payload='' WHERE recipient_hash=? AND id!=? AND state='ready'").run(recipient,row.id);
     this.db.prepare('UPDATE requests SET grant_id=?,grant_version=?,recipient_hash=?,code_mac=?,payload=\'\' WHERE id=?').run(grant.id,grant.version,recipient,codeMac,row.id);
    });
    // Address comes only from the verified record. requestId is an idempotency key.
    await this.mailer({grantId:grant.id,grantVersion:grant.version,recipient:grant.email,code,requestId:row.id,expiresAt:row.expires});
    this.db.prepare("UPDATE requests SET state='ready' WHERE id=? AND state='processing' AND expires>?").run(row.id,this.now());
    this.audit('code_dispatched',grant.id);
   }catch{
    this.db.prepare("UPDATE requests SET state='failed',code_mac=NULL,payload='' WHERE id=?").run(row.id);
    this.audit('code_not_dispatched',row.id);
   }
  }}finally{this.running=false;}
 }
 async verify({requestId,requestProof,code},ip){
  const allowed=this.transaction(()=>this.budget('verify-ip',ip||'unknown',30,10*MINUTE)&&this.budget('verify-global','all',600,10*MINUTE));
  if(!allowed)throw new AccessError(429,'try_later');
  if(!TOKEN.test(requestId||'')||!TOKEN.test(requestProof||'')||!/^\d{6}$/.test(code||''))throw new AccessError(401,'invalid_code');
  const id=this.mac('request',requestId),proof=this.mac('proof',requestProof);
  const matched=this.transaction(()=>{
   const r=this.db.prepare('SELECT * FROM requests WHERE id=?').get(id);
   if(!r||!equal(r.proof,proof)||r.state!=='ready'||r.expires<=this.now()||r.attempts>=5)return null;
   this.db.prepare('UPDATE requests SET attempts=attempts+1 WHERE id=?').run(id);
   const match=equal(this.mac('code',id+'|'+proof+'|'+code),r.code_mac);
   if(match||r.attempts+1>=5)this.db.prepare("UPDATE requests SET state='consumed',code_mac=NULL,payload='' WHERE id=?").run(id);
   return match?r:null;
  });
  if(!matched)throw new AccessError(401,'invalid_code');
  // Fresh lookup after consuming the code: revoked/changed grants cannot log in.
  let current;try{current=verifiedGrant(await this.provider.get(matched.grant_id),this.now());}catch{throw new AccessError(503,'temporarily_unavailable');}
  if(!current||current.id!==matched.grant_id||current.version!==matched.grant_version||!equal(this.mac('recipient',current.email),matched.recipient_hash))throw new AccessError(403,'access_denied');
  const session=token(),expires=this.now()+12*HOUR;
  this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(this.mac('session',session),current.id,current.version,matched.recipient_hash,expires);
  this.audit('access_verified',current.id);
  return {sessionToken:session,expiresAt:expires};
 }
 async authorize(sessionToken){
  if(!TOKEN.test(sessionToken||''))throw new AccessError(401,'login_required');
  const digest=this.mac('session',sessionToken),s=this.db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(digest);
  if(!s||s.expires<=this.now())throw new AccessError(401,'login_required');
  let g;try{g=verifiedGrant(await this.provider.get(s.grant_id),this.now());}catch{throw new AccessError(503,'temporarily_unavailable');}
  if(!g||g.id!==s.grant_id||g.version!==s.grant_version||!equal(this.mac('recipient',g.email),s.recipient_hash)){
   this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest);throw new AccessError(403,'access_denied');
  }
  return g;
 }
 logout(sessionToken){if(TOKEN.test(sessionToken||''))this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(this.mac('session',sessionToken));}
}
