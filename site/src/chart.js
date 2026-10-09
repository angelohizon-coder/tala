import { number, date, direction } from './format.js';
const NS = 'http://www.w3.org/2000/svg';
function el(tag, attrs = {}, text) { const node=document.createElementNS(NS,tag); for(const [key,value] of Object.entries(attrs))node.setAttribute(key,String(value)); if(text!==undefined)node.textContent=text; return node; }
export function sparkline(points, change) {
  const svg=el('svg',{viewBox:'0 0 94 30',class:`sparkline ${direction(change)}`,'aria-hidden':'true'});
  if(!points?.length) return svg;
  const values=points.slice(-22).map(p=>p.close).filter(Number.isFinite);
  if(values.length<2)return svg;
  const min=Math.min(...values),max=Math.max(...values),span=max-min||1;
  svg.append(el('path',{d:values.map((v,i)=>`${i?'L':'M'}${(i/(values.length-1)*90+2).toFixed(2)},${(26-(v-min)/span*22).toFixed(2)}`).join(' '),fill:'none','stroke-width':1.7,'stroke-linejoin':'round','stroke-linecap':'round'}));return svg;
}
export function drawChart(svg, points, {label, digits=2}={}) {
  svg.replaceChildren(el('title',{id:'chart-title'},`${label} historical values`),el('desc',{id:'chart-desc'},`${points.length} daily values. An accessible history table is available below this chart.`));
  const tooltip=document.querySelector('#chart-tooltip');tooltip.hidden=true;
  svg.onpointermove=null;svg.onpointerleave=null;
  if(!points.length)return;
  const w=Math.max(310,Math.round(svg.getBoundingClientRect().width)),h=w<500?180:230,left=12,right=78,top=18,bottom=32,plotW=w-left-right,plotH=h-top-bottom;
  svg.setAttribute('viewBox',`0 0 ${w} ${h}`);
  const values=points.map(p=>p.close),lo=Math.min(...values),hi=Math.max(...values),padding=(hi-lo||hi*.01||1)*.24,min=lo-padding,max=hi+padding;
  const x=i=>left+i/Math.max(1,points.length-1)*plotW,y=v=>top+(max-v)/(max-min)*plotH;
  const defs=el('defs'),gradient=el('linearGradient',{id:'chart-fill',x1:0,y1:0,x2:0,y2:1});
  gradient.append(el('stop',{offset:'0%','stop-color':'#5eaf8c','stop-opacity':'.22'}),el('stop',{offset:'100%','stop-color':'#5eaf8c','stop-opacity':'0'}));defs.append(gradient);svg.append(defs);
  for(let i=0;i<4;i++) {const gy=top+i*plotH/3,value=max-i*(max-min)/3;svg.append(el('line',{x1:left,y1:gy,x2:w-right+8,y2:gy,stroke:'#e9ede9','stroke-dasharray':'4 5'}),el('text',{x:w-right+18,y:gy+4,fill:'#657570','font-size':10},number(value,digits)));}
  const d=points.map((p,i)=>`${i?'L':'M'}${x(i).toFixed(2)} ${y(p.close).toFixed(2)}`).join(' ');
  svg.append(el('path',{d:`${d} L${x(points.length-1)} ${top+plotH} L${left} ${top+plotH} Z`,fill:'url(#chart-fill)'}),el('path',{d,stroke:'#2b8863','stroke-width':2.5,fill:'none','stroke-linejoin':'round','stroke-linecap':'round'}));
  const labelCount=w<500?3:5;
  for(let i=0;i<labelCount;i++){const idx=Math.round(i*(points.length-1)/(labelCount-1));svg.append(el('text',{x:x(idx),y:h-8,fill:'#657570','font-size':10,'text-anchor':i===0?'start':i===labelCount-1?'end':'middle'},date(points[idx].date)));}
  const last=points.at(-1);svg.append(el('circle',{cx:x(points.length-1),cy:y(last.close),r:5,fill:'#2b8863',stroke:'#fff','stroke-width':3}));
  const crosshair=el('g',{visibility:'hidden'}),line=el('line',{y1:top,y2:top+plotH,stroke:'#91aea0','stroke-dasharray':'4 4'}),dot=el('circle',{r:5,fill:'#2b8863',stroke:'#fff','stroke-width':2});crosshair.append(line,dot);svg.append(crosshair);
  svg.onpointermove=event=>{const rect=svg.getBoundingClientRect(),px=(event.clientX-rect.left)/rect.width*w,index=Math.max(0,Math.min(points.length-1,Math.round((px-left)/plotW*(points.length-1)))),point=points[index];line.setAttribute('x1',x(index));line.setAttribute('x2',x(index));dot.setAttribute('cx',x(index));dot.setAttribute('cy',y(point.close));crosshair.setAttribute('visibility','visible');tooltip.textContent=`${date(point.date,{year:'numeric'})} · ${number(point.close,digits)}`;tooltip.hidden=false;tooltip.style.left=`${Math.min(rect.width-175,Math.max(5,x(index)/w*rect.width-75))}px`;};
  svg.onpointerleave=()=>{crosshair.setAttribute('visibility','hidden');tooltip.hidden=true;};
}
