import {useEffect,useId,useRef,useState} from 'react';
type Diagram={image:string;ratio:number};
const cache=new Map<string,Diagram>();
let engine:Promise<typeof import('mermaid')['default']>|undefined;
let inFlight=0;
function mermaidEngine(){
 return engine??=import('mermaid').then(({default:mermaid})=>{
  mermaid.initialize({startOnLoad:false,securityLevel:'strict',suppressErrorRendering:true,maxTextSize:32768,maxEdges:300,theme:'neutral',flowchart:{htmlLabels:false}});
  return mermaid;
 });
}
async function draw(source:string,id:string){
 const saved=cache.get(source);if(saved)return saved;
 if(source.length>32768)throw new Error('流程图过长，请查看源码');
 if(inFlight>=4)throw new Error('正在绘制其他流程图，请稍后重试');
 inFlight++;
 try{
  const mermaid=await mermaidEngine(),{svg}=await mermaid.render(id,source);
  if(svg.length>1_000_000)throw new Error('流程图过大，请查看源码');
  // SVG作为图片文档加载，不将图中的HTML、样式或脚本注入会话DOM。
  const bytes=new TextEncoder().encode(svg);let binary='';
  for(let n=0;n<bytes.length;n+=8192)binary+=String.fromCharCode(...bytes.subarray(n,n+8192));
  const image=`data:image/svg+xml;base64,${btoa(binary)}`;
  const box=/viewBox=["']([^"']+)["']/.exec(svg)?.[1].trim().split(/\s+/).map(Number);
  const ratio=box&&box[2]>0&&box[3]>0?box[2]/box[3]:1.5;
  const diagram={image,ratio};
  cache.delete(source);cache.set(source,diagram);if(cache.size>16)cache.delete(cache.keys().next().value!);
  return diagram;
 }finally{inFlight--}
}
export function MermaidDiagram({source}:{source:string}){
 const id=useId().replace(/[^A-Za-z0-9]/g,''),ref=useRef<HTMLElement>(null);
 const [visible,setVisible]=useState(typeof IntersectionObserver==='undefined'),[image,setImage]=useState<string>(),[error,setError]=useState(''),[retry,setRetry]=useState(0),[ratio,setRatio]=useState<number>();
 useEffect(()=>{if(typeof IntersectionObserver==='undefined')return;const observer=new IntersectionObserver(entries=>setVisible(entries.some(e=>e.isIntersecting)),{rootMargin:'300px'});if(ref.current)observer.observe(ref.current);return()=>observer.disconnect()},[]);
 useEffect(()=>{
  let cancelled=false;setError('');setImage(undefined);
  if(!visible)return;
  const timer=setTimeout(()=>{void draw(source,`mermaid-${id}-${retry}`).then(value=>{if(!cancelled){setImage(value.image);setRatio(value.ratio)}}).catch(cause=>{if(!cancelled)setError(String(cause))})},180);
  return()=>{cancelled=true;clearTimeout(timer)};
 },[source,id,retry,visible]);
 return <figure className="mermaid-figure" ref={ref}>{image?<img className="mermaid-image" src={image} alt="Mermaid 流程图"/>:<div className="mermaid-status" style={ratio?{aspectRatio:String(ratio)}:undefined}>{error?'流程图暂时无法显示':'正在绘制流程图…'}</div>}{error&&<button className="mermaid-retry" onClick={()=>setRetry(n=>n+1)}>重新绘制</button>}<details className="mermaid-source"><summary>查看图表源码</summary><pre><code>{source}</code></pre></details></figure>;
}
