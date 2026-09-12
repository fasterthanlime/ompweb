"use client";
import {useEffect,useSyncExternalStore} from 'react';
import {Monitor} from 'lucide-react';
export type ThreadHost='local'|'remote';
export function hostLabel(platform?:string){const p=platform?.toLowerCase()??'';return p.includes('darwin')||p.includes('mac')?'Mac':p.includes('win')?'Windows':'Linux'}
export function HostMark({platform,host='remote'}:{platform?:string;host?:ThreadHost}){
  const label=hostLabel(platform);
  const icon=label==='Mac'?'apple':label==='Linux'?'linux':null;
  return <span role="img" title={`${host==='local'?'Local ':''}${label} host`} aria-label={`${label} host`} style={{display:'inline-flex',alignItems:'center',justifyContent:'center',width:20,height:20,color:'var(--text-muted)',flexShrink:0}}>
    {icon?<span aria-hidden="true" style={{display:'block',width:16,height:16,backgroundColor:'currentColor',maskImage:`url(/host-icons/${icon}.svg)`,WebkitMaskImage:`url(/host-icons/${icon}.svg)`,maskSize:'contain',WebkitMaskSize:'contain',maskRepeat:'no-repeat',WebkitMaskRepeat:'no-repeat',maskPosition:'center',WebkitMaskPosition:'center'}}/>:<Monitor size={16} aria-hidden="true"/>}
  </span>;
}
type Summary={expression:string;caption:string};
let summaries:Record<string,Summary>={};const listeners=new Set<()=>void>();let timer:ReturnType<typeof setInterval>|undefined;let controller:AbortController|undefined;let pending=false;
const load=async()=>{if(pending)return;pending=true;controller=new AbortController();try{const r=await fetch('/api/thread-expression',{signal:controller.signal});if(r.ok){summaries=await r.json();for(const l of listeners)l()}}catch{}finally{pending=false}};
function subscribe(listener:()=>void){listeners.add(listener);if(!timer){void load();timer=setInterval(()=>void load(),10000)}return()=>{listeners.delete(listener);if(!listeners.size){clearInterval(timer);timer=undefined;controller?.abort()}}}
const empty:Record<string,Summary>={};
export function ThreadExpressionMeta({id}:{id:string;enabled?:boolean}){const state=useSyncExternalStore(subscribe,()=>summaries,()=>empty)[id];useEffect(()=>{const refresh=()=>void load();window.addEventListener('focus',refresh);return()=>window.removeEventListener('focus',refresh)},[]);if(!state?.expression&&!state?.caption)return null;return <span style={{display:'flex',gap:6,minWidth:0,maxWidth:'100%',fontSize:11,color:'var(--text-muted)'}} title={state.caption}><span style={{flexShrink:0,fontSize:13}}>{state.expression}</span><span style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{state.caption}</span></span>}
