// The paid source is loaded exclusively from a private Render secret file.
// No HTTP endpoint exposes this index. Authorization must precede every search.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const STOP=new Set('de het een en of ik jij je u we wij zij ze die dat dit deze deze er is zijn was word wordt worden van voor met naar op in aan uit om te als bij tot dan ook maar over wil willen graag hoe wat waar welke kan kunnen heb hebt hebben mijn jouw ons onze me mij nog al wel niet geen gids startgids pagina hoofdstuk'.split(' '));
export class GuideKnowledge {
 constructor({file,expectedHash,pdfHash,pageCount=205}){
  const raw=readFileSync(file);if(raw.length>900000||createHash('sha256').update(raw).digest('hex')!==expectedHash)throw Error('Private knowledge fingerprint mismatch');
  const data=JSON.parse(raw);if(data.sha256!==pdfHash||data.pageCount!==pageCount||data.pages?.length!==pageCount)throw Error('Incomplete private guide');
  this.db=new DatabaseSync(':memory:');
  this.db.exec("CREATE VIRTUAL TABLE passages USING fts5(text, page UNINDEXED, tokenize='unicode61 remove_diacritics 2');");
  const insert=this.db.prepare('INSERT INTO passages(text,page) VALUES(?,?)');
  for(let i=0;i<pageCount;i++){
   const p=data.pages[i];if(p.page!==i+1||typeof p.text!=='string')throw Error('Invalid guide page');
   // Keep each physical page intact, so table labels and page provenance survive.
   insert.run(p.text,p.page);
  }
  this.pageCount=pageCount;
 }
 close(){this.db.close();}
 search(query){
  if(typeof query!=='string'||query.length>2000)return [];
  const terms=[...new Set(query.toLowerCase().normalize('NFKD').replace(/\p{M}/gu,'').match(/[\p{L}\p{N}]{3,}/gu)||[])].filter(x=>!STOP.has(x)).slice(0,16);
  if(!terms.length)return [];
  // Only generated quoted tokens enter the FTS expression. No user FTS/SQL syntax.
  const expression=terms.map(t=>'"'+t+'"*').join(' OR ');
  const rows=this.db.prepare('SELECT text,page,bm25(passages) rank FROM passages WHERE passages MATCH ? ORDER BY rank LIMIT 4').all(expression);
  let remaining=14000;
  return rows.map(r=>{const text=r.text.slice(0,Math.min(5000,remaining));remaining-=text.length;return {source:'Nutrition Works — Startgids (afgeschermd)',page:r.page,text};}).filter(x=>x.text);
 }
 async forVerifiedSession(access,sessionToken,query){
  // Do not accept has_fit_guide, claimed phone numbers or caller-supplied grants.
  await access.authorize(sessionToken);
  return this.search(query);
 }
}
