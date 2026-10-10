import { useEffect, useRef, useId, cloneElement, isValidElement, useState, useCallback, type ReactNode, type ReactElement } from 'react';
import { soundService } from './soundManager';
import { useReducedMotion } from '../hooks/useReducedMotion';

export function precision(currency='PHP'){try{return new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits??2;}catch{return 2;}}
export function majorToMinor(value:number,currency='PHP'){return Math.round(value*10**precision(currency));}
export function minorToMajor(value:number,currency='PHP'){return value/10**precision(currency);}
export function formatMoney(amount:number|null|undefined,currency='PHP'){return typeof amount==='number'&&Number.isFinite(amount)?new Intl.NumberFormat('en-PH',{style:'currency',currency,currencyDisplay:currency==='PHP'?'symbol':'code',maximumFractionDigits:precision(currency)}).format(minorToMajor(amount,currency)):'—';}
export function Money({amount,currency='PHP'}:{amount:number|null|undefined,currency?:string}){return <span className="money">{formatMoney(amount,currency)}</span>;}
export function Field({label,children}:{label:string,children:ReactNode}){const id=useId();return <label className="field" htmlFor={id+'-control'}><span id={id}>{label}</span>{isValidElement(children)?cloneElement(children as ReactElement<{id?:string;'aria-labelledby'?:string}>,{id:id+'-control','aria-labelledby':id}):children}</label>;}
export function Empty({title,description,action}:{title:string,description?:string,action?:ReactNode}){return <div className="empty-state"><span className="empty-symbol">✳</span><h3>{title}</h3>{description&&<p>{description}</p>}{action}</div>;}
export function Dialog({title,children,onClose}:{title:string,children:ReactNode,onClose:()=>void}){
  const ref=useRef<HTMLDialogElement>(null);
  const [isClosing,setIsClosing]=useState(false);
  const closingRef=useRef(false);
  const closeTimerRef=useRef<ReturnType<typeof setTimeout>|null>(null);
  const prefersReducedMotion=useReducedMotion();

  const handleClose=useCallback(()=>{
    if(closingRef.current)return;
    closingRef.current=true;
    soundService.play('dialog_close');
    if(prefersReducedMotion){
      onClose();
      return;
    }
    setIsClosing(true);
    closeTimerRef.current=setTimeout(()=>{
      closeTimerRef.current=null;
      onClose();
    },150);
  },[onClose,prefersReducedMotion]);

  useEffect(()=>{
    const element=ref.current;
    element?.showModal();
    soundService.play('dialog_open');
    return()=>{
      if(closeTimerRef.current!==null){
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current=null;
      }
      element?.close();
    };
  },[]);

  return <dialog
    ref={ref}
    aria-label={title}
    className={`dialog ${isClosing?'dialog-closing':''} ${prefersReducedMotion?'motion-reduce:animate-none':''}`}
    onCancel={e=>{e.preventDefault();handleClose();}}
    onClickCapture={e=>{
      const btn=(e.target as HTMLElement).closest('button');
      if(btn&&btn.type==='button'){
        const text=btn.textContent?.trim().toLowerCase();
        if(text==='cancel'||btn.getAttribute('aria-label')==='Close dialog'||btn.hasAttribute('data-dialog-close')){
          e.preventDefault();
          e.stopPropagation();
          handleClose();
        }
      }
    }}
    onClick={e=>{
      if(e.target===e.currentTarget){
        const r=e.currentTarget.getBoundingClientRect();
        if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)handleClose();
      }
    }}
  >
    <div className="dialog-heading">
      <h2>{title}</h2>
      <button type="button" className="icon-button" aria-label="Close dialog" onClick={handleClose}>×</button>
    </div>
    {children}
  </dialog>;
}
export function PageHeading({eyebrow,title,description,action}:{eyebrow?:string,title:string,description?:string,action?:ReactNode}){return <div className="page-heading"><div>{eyebrow&&<div className="eyebrow">{eyebrow}</div>}<h1>{title}<span>.</span></h1>{description&&<p>{description}</p>}</div>{action}</div>;}
export function ErrorMessage({message}:{message?:string}){return message?<p className="form-error" role="alert">{message}</p>:null;}
export const today=()=>new Date().toLocaleDateString('en-CA');
export const month=()=>today().slice(0,7);
export function download(text:string,name:string,type='application/json'){const url=URL.createObjectURL(new Blob([text],{type}));const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
export function csvValue(v:unknown){let s=String(v??'');if(typeof v==='string'&&(/^[\t\r\n]/.test(s)||/^\s*[=+@-]/.test(s)))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}
