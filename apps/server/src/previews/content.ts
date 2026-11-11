import type { FastifyInstance } from 'fastify';
import { inlineScript, previewCss, previewTheme, scriptJson, type PreviewTheme } from './document.js';

const runtime = `(async()=>{
 const params=new URLSearchParams(location.hash.slice(1));
 const embedded=document.getElementById('riffet-content-data');
 const input=embedded?JSON.parse(embedded.textContent):Object.fromEntries(params);
 const source=input.source||'';
 const target=document.getElementById('diagram');
 const dark=input.scheme==='dark';
 const safe=(key,fallback)=>/^#[0-9a-f]{6}$/i.test(input[key]||'')?input[key]:fallback;
 document.documentElement.style.colorScheme=dark?'dark':'light';
 document.documentElement.style.setProperty('--fg',safe('color',dark?'#eceef1':'#121417'));
 document.documentElement.style.setProperty('--bg',safe('background',dark?'#1d1d20':'#ffffff'));
 document.documentElement.style.setProperty('--line',safe('line',dark?'#55555c':'#dedee3'));
 document.documentElement.style.setProperty('--accent',safe('accent',dark?'#739aff':'#3867f0'));
 const report=(status,svg)=>{
  document.documentElement.dataset.riffetMermaid=status;
  const rect=target.getBoundingClientRect();
  if(parent!==window)parent.postMessage({type:'riffet-mermaid',id:input.id,status,svg,width:rect.width,height:rect.height},'*');
 };
 try {
  if(!source.trim()||source.length>2*1024*1024)throw Error('预览内容过大');
  if(input.language==='svg'){
   const doc=new DOMParser().parseFromString(source,'image/svg+xml');
   const svg=doc.documentElement;
   if(svg.localName!=='svg'||doc.querySelector('parsererror'))throw Error('SVG 格式无效');
   const serialized=new XMLSerializer().serializeToString(svg);
   const image=new Image(); image.alt=''; image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(serialized); target.append(image);
   await image.decode();
   report('ready',serialized);return;
  }
  target.innerHTML=source;
  // The entire document is an opaque sandbox: these scripts have no workbench bridge,
  // credentials or network access. External scripts remain blocked by its policy.
  for(const old of [...target.querySelectorAll('script')]){
   if(old.src){old.remove();continue;}
   const script=document.createElement('script');
   if(old.type)script.type=old.type;
   script.textContent=old.textContent;old.replaceWith(script);
  }
  await Promise.race([document.fonts.ready,new Promise(r=>setTimeout(r,1500))]);
  await Promise.race([Promise.all([...target.querySelectorAll('img')].map(i=>i.decode().catch(()=>{}))),new Promise(r=>setTimeout(r,1500))]);
  await Promise.race([new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))),new Promise(r=>setTimeout(r,200))]);
  report('ready');
 }catch(error){target.textContent=error.message||'预览失败';report('error');}
})();`;

export const CONTENT_PREVIEW_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' blob:; worker-src blob:; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

export function contentPreviewPage(source?: string, language = 'html', theme: PreviewTheme = previewTheme()): { html: string; csp: string } {
  const input = source === undefined ? '' : `<script id="riffet-content-data" type="application/json">${scriptJson({ source, language, scheme: theme.dark ? 'dark' : 'light', color: theme.foreground, background: theme.background, line: theme.line, accent: theme.accent })}</script>`;
  return { csp: CONTENT_PREVIEW_CSP, html: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${previewCss(theme)}body{padding:12px}#diagram{width:100%;min-height:1px}#diagram>img{display:block;max-width:100%;height:auto}</style></head><body><div id="diagram"></div>${input}<script>${inlineScript(runtime)}</script></body></html>` };
}

export function registerContentPreview(app: FastifyInstance): void {
  app.get('/content-preview', async (_request, reply) => {
    const page = contentPreviewPage();
    return reply.type('text/html; charset=utf-8').header('Content-Security-Policy', page.csp)
      .header('Cache-Control', 'public, no-cache').header('Referrer-Policy', 'no-referrer')
      .header('X-Content-Type-Options', 'nosniff').send(page.html);
  });
}
