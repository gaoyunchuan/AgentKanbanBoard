import {isValidElement,memo,type ReactNode} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {MermaidDiagram} from './MermaidDiagram';
export function isFileLink(href:string){
 return Boolean(href)&&!href.startsWith('#')&&!href.startsWith('//')&&!href.startsWith('\\\\')&&!/[\u0000-\u001f]/.test(href)&&(!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href)||/^[A-Za-z]:[\\/]/.test(href));
}
function safeUrl(href:string){
 if(isFileLink(href)||href.startsWith('#'))return href;
 try{return ['http:','https:'].includes(new URL(href).protocol)?href:''}catch{return ''}
}
export const Markdown=memo(function Markdown({text,onOpenLink}:{text:string;onOpenLink?:(href:string)=>void}){
 const open=(href:string)=>{if(onOpenLink)onOpenLink(href);else window.dispatchEvent(new CustomEvent('akb:open-link',{detail:href}))};
 return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={safeUrl} components={{
  a:({href,children,title})=>href?<a href={href} title={title} rel="noreferrer noopener" onClick={e=>{if(!href.startsWith('#')){e.preventDefault();open(href)}}}>{children}</a>:<span>{children}</span>,
  pre:({children})=>{
   const child=Array.isArray(children)?children[0]:children;
   if(isValidElement<{className?:string;children?:ReactNode}>(child)&&child.props.className==='language-mermaid')return <MermaidDiagram source={String(child.props.children||'').replace(/\n$/,'')}/>;
   return <pre>{children}</pre>;
  },
  table:({children})=><div className="md-table"><table>{children}</table></div>,
 }}>{text}</ReactMarkdown></div>;
});
