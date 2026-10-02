// Private rendering worker. The original PDF never leaves the server.
// Separating rendering from the HTTP thread keeps existing chat handling responsive.
import {parentPort,workerData} from 'node:worker_threads';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {PDFDocument,PDFName,PDFString,StandardFonts} from 'pdf-lib';

const bytes=readFileSync(workerData.file);
const resource=folder=>fileURLToPath(new URL(`./${folder}/`,import.meta.resolve('pdfjs-dist/package.json')));
const loading=getDocument({data:new Uint8Array(bytes),isEvalSupported:false,useSystemFonts:false,disableFontFace:true,standardFontDataUrl:resource('standard_fonts'),cMapUrl:resource('cmaps'),cMapPacked:true,wasmUrl:resource('wasm')});
const pdf=await loading.promise;
if(pdf.numPages!==205)throw Error('Unexpected approved guide page count');
const worksheetNumbers=Array.from({length:18},(_,i)=>181+i);
let worksheets=null;

async function worksheetPDF(){
 if(worksheets)return worksheets;
 const source=await PDFDocument.load(bytes),target=await PDFDocument.create();
 // Remove navigation links BEFORE copying, so references cannot pull unrelated
 // paid chapters into the worksheet file's otherwise-unreachable PDF objects.
 for(const page of source.getPages()){
  const annotations=page.node.Annots();if(!annotations)continue;
  const widgets=annotations.asArray().filter(ref=>source.context.lookup(ref).get(PDFName.of('Subtype'))===PDFName.of('Widget'));
  page.node.set(PDFName.of('Annots'),source.context.obj(widgets));
 }
 const pages=await target.copyPages(source,worksheetNumbers.map(n=>n-1));
 const form=target.getForm(),font=await target.embedFont(StandardFonts.Helvetica);
 form.acroForm.dict.set(PDFName.of('DR'),target.context.obj({Font:{Helv:font.ref}}));
 form.acroForm.dict.set(PDFName.of('DA'),PDFString.of('/Helv 10 Tf 0.188235 0.133333 0.219608 rg'));
 let fields=0;
 for(const page of pages){
  target.addPage(page);
  const annotations=page.node.Annots();
  for(const ref of annotations?.asArray()||[]){
   const widget=target.context.lookup(ref);
   if(widget.get(PDFName.of('Subtype'))!==PDFName.of('Widget'))continue;
   // The approved source uses merged, parentless text-field/widget dictionaries.
   // Refuse a changed source instead of silently losing interactive fields.
   if(widget.has(PDFName.of('Parent'))||widget.get(PDFName.of('FT'))!==PDFName.of('Tx'))throw Error('Unsupported worksheet field structure');
   widget.set(PDFName.of('P'),page.ref);
   form.acroForm.addField(ref);fields++;
  }
 }
 if(fields!==100||form.getFields().length!==100)throw Error('Worksheet fields were not preserved');
 target.setTitle('Nutrition Works - Persoonlijke invulbladen');
 target.setAuthor('Nutrition Works');
 target.setSubject('De 18 afzonderlijke invulbladen uit de startgids, voor persoonlijk gebruik.');
 worksheets=Buffer.from(await target.save({updateFieldAppearances:false}));
 return worksheets;
}

async function internalPage(destination){
 const dest=typeof destination==='string'?await pdf.getDestination(destination):destination;
 if(!Array.isArray(dest)||!dest.length)return null;
 try{const n=(typeof dest[0]==='number'?dest[0]:await pdf.getPageIndex(dest[0]))+1;return n>=1&&n<=205?n:null;}catch{return null;}
}
async function pageImage(number,email){
 if(!Number.isInteger(number)||number<1||number>205)throw Error('Invalid page');
 if(typeof email!=='string'||email.length>254||!/^\S+@\S+\.\S+$/.test(email))throw Error('Verified email required');
 const page=await pdf.getPage(number),viewport=page.getViewport({scale:2});
 const width=Math.ceil(viewport.width),height=Math.ceil(viewport.height);
 const factory=pdf.canvasFactory,{canvas,context}=factory.create(width,height+72);
 context.font='26px sans-serif';
 const lines=[];let line='';
 for(const character of 'Persoonlijke gids voor '+email){
  if(context.measureText(line+character).width>width-60){lines.push(line);line='';}line+=character;
 }
 if(line)lines.push(line);
 const band=Math.max(72,lines.length*32+24);canvas.height=height+band;
 try{
  context.fillStyle='#faf7f1';context.fillRect(0,0,width,height+band);
  context.save();
  await page.render({canvasContext:context,viewport}).promise;
  context.restore();context.resetTransform();context.globalAlpha=1;
  // A quiet band outside the original page never covers text or exercises.
  context.fillStyle='#f3eeed';context.fillRect(0,height,width,band);
  context.fillStyle='#786d78';context.textAlign='center';context.textBaseline='middle';
  context.font='26px sans-serif';
  lines.forEach((text,i)=>context.fillText(text,width/2,height+(band-lines.length*32)/2+16+i*32));
  const links=[];
  for(const annotation of await page.getAnnotations({intent:'display'})){
   if(annotation.subtype!=='Link'||!annotation.rect)continue;
   const [x1,y1]=viewport.convertToViewportPoint(annotation.rect[0],annotation.rect[1]);
   const [x2,y2]=viewport.convertToViewportPoint(annotation.rect[2],annotation.rect[3]);
   const rect={x:Math.max(0,Math.min(x1,x2)/width),y:Math.max(0,Math.min(y1,y2)/(height+band)),w:Math.abs(x2-x1)/width,h:Math.abs(y2-y1)/(height+band)};
   if(annotation.dest){const target=await internalPage(annotation.dest);if(target)links.push({...rect,page:target});}
   else if(annotation.url){try{const u=new URL(annotation.url);if(u.protocol==='https:'&&u.hostname==='nutritionworks.online'&&!/\.pdf$/i.test(u.pathname))links.push({...rect,url:u.href});}catch{}}
  }
  return {page:number,width,height:height+band,image:canvas.toBuffer('image/jpeg',92).toString('base64'),links};
 }finally{factory.destroy({canvas,context});page.cleanup();await pdf.cleanup();}
}

// The parent submits only one task at a time; never render concurrently.
parentPort.on('message',async task=>{
 try{
  const value=task.kind==='page'?await pageImage(task.page,task.email):task.kind==='worksheets'?await worksheetPDF():null;
  if(value===null)throw Error('Unknown reader operation');
  parentPort.postMessage({id:task.id,ok:true,value});
 }catch(error){if(process.env.NODE_ENV==='test')console.error(error);parentPort.postMessage({id:task.id,ok:false});}
});
parentPort.postMessage({ready:true,pages:pdf.numPages});
