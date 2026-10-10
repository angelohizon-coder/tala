import { useEffect, useRef, useId, cloneElement, isValidElement, useState, useCallback, type ReactNode, type ReactElement } from 'react';
import { soundService } from './soundManager';
import { useReducedMotion } from '../hooks/useReducedMotion';

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
