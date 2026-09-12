import DOMPurify from 'dompurify';
import { parse, generate, walk } from 'css-tree';
const tags=['div','span','p','strong','em','b','i','h1','h2','h3','h4','ul','ol','li','table','thead','tbody','tr','td','th','caption','pre','code','br','hr','svg','g','path','rect','circle','ellipse','line','polyline','polygon','text','tspan','defs','marker','linearGradient','radialGradient','stop'];
const attrs=['class','id','viewBox','width','height','x','y','x1','y1','x2','y2','cx','cy','r','rx','ry','d','points','fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','opacity','fill-opacity','stroke-opacity','transform','text-anchor','dominant-baseline','font-size','font-weight','marker-end','marker-start','markerWidth','markerHeight','refX','refY','orient','offset','stop-color','stop-opacity','gradientUnits','gradientTransform'];
const properties=new Set(['display','grid-template-columns','grid-template-rows','grid-column','grid-row','gap','row-gap','column-gap','flex','flex-direction','flex-wrap','align-items','justify-content','align-self','order','padding','padding-top','padding-bottom','padding-left','padding-right','margin','margin-top','margin-bottom','margin-left','margin-right','width','height','min-width','max-width','min-height','max-height','box-sizing','border','border-width','border-style','border-color','border-radius','background-color','color','color-scheme','font-size','font-weight','font-style','font-family','line-height','letter-spacing','text-align','white-space','overflow-wrap','word-break','list-style-type','border-collapse','vertical-align','opacity','fill','stroke','stroke-width']);
const functions=new Set(['rgb','rgba','hsl','hsla','min','max','minmax','repeat','light-dark']);
const COLOR_SCHEME_VALUES=new Set(['normal','light','dark','light dark','dark light','only light','only dark']);
export function sanitizeVisual(html:string,css:string):{html:string;css:string}{
 if(html.length>40000||css.length>12000)throw new Error('Visual exceeds size limit');
 const fragment=DOMPurify.sanitize(html,{ALLOWED_TAGS:tags,ALLOWED_ATTR:attrs,ALLOW_DATA_ATTR:false,ALLOW_ARIA_ATTR:false,RETURN_DOM_FRAGMENT:true});
 const nodes=fragment.querySelectorAll('*');if(nodes.length>500)throw new Error('Visual has too many elements');
 for(const node of nodes){for(const attr of Array.from(node.attributes)){
   if(['fill','stroke','marker-end','marker-start'].includes(attr.name)) {
     let safe=true;
     try {walk(parse(attr.value,{context:'value'}),part=>{if(part.type==='Url'&&!/^#[A-Za-z0-9_-]+$/.test(part.value))safe=false;if(part.type==='Raw')safe=false;});}catch{safe=false;}
     if(!safe)node.removeAttribute(attr.name);
   }
   if(['width','height','r','rx','ry','font-size','stroke-width'].includes(attr.name)&&(!/^\d+(\.\d+)?$/.test(attr.value)||Number(attr.value)>2000))node.removeAttribute(attr.name);
   if(attr.value.length>6000)node.removeAttribute(attr.name);
 }}
 const tree=parse(css,{positions:false});if(tree.type!=="StyleSheet")throw new Error("Invalid stylesheet");let count=0;
 tree.children.forEach((node,item,list)=>{if(node.type!=="Rule"||++count>100){list.remove(item);return;}
   let safe=true;walk(node.prelude,n=>{if(n.type==='PseudoClassSelector'||n.type==='PseudoElementSelector'||n.type==='AttributeSelector'||n.type==='Raw')safe=false});
   if(!safe){list.remove(item);return;}
   node.block.children.forEach((decl,di,dl)=>{
     if(decl.type!=="Declaration"||!properties.has(decl.property.toLowerCase())){dl.remove(di);return;}
     const property=decl.property.toLowerCase();
     const generated=generate(decl.value).trim().replace(/\s+/g," ");
     if(property==="color-scheme"&&!COLOR_SCHEME_VALUES.has(generated.toLowerCase())){dl.remove(di);return;}
     let valid=true;walk(decl.value,n=>{
       if(n.type==='Url'||n.type==='Raw'||(n.type==='Function'&&!functions.has(n.name.toLowerCase())))valid=false;
       if(n.type==='Function'&&n.name.toLowerCase()==='light-dark'){
         const commas=n.children.toArray().filter((child)=>child.type==='Operator'&&child.value===',').length;
         if(commas!==1)valid=false;
       }
       if(n.type==='Dimension'&&(Number(n.value)<0||Number(n.value)>2000||!['px','em','rem','ch','fr','%'].includes(n.unit.toLowerCase())))valid=false;
       if(n.type==='Number'&&(Number(n.value)<0||Number(n.value)>2000))valid=false;
     });
     if(!valid)dl.remove(di);
   });
 });
 const container=document.createElement('div');container.append(fragment);return {html:container.innerHTML,css:generate(tree)};
}
