import { financeRepository } from '../db/repository';
import type { createSupabaseSyncProvider } from '../sync/supabase';
import { createSyncEngine } from '../sync/engine';
export interface CloudConfiguration { url:string; publishableKey:string }
let provider:ReturnType<typeof createSupabaseSyncProvider>|undefined;
let engine:ReturnType<typeof createSyncEngine>|undefined;
let identity='';
export function stopSync(){engine?.stop();engine=undefined;provider?.client.auth.stopAutoRefresh();provider=undefined;identity='';}
export async function cloudProvider(){const config=await financeRepository.getSetting<CloudConfiguration>('supabase');if(!config)throw new Error('Save a Supabase URL and public key first.');const key=config.url+'|'+config.publishableKey;if(identity!==key){stopSync();const {createSupabaseSyncProvider}=await import('../sync/supabase');provider=createSupabaseSyncProvider(config);identity=key;}return provider!;}
export async function initializeSync(){if(await financeRepository.getSetting('privacyMode','LOCAL_ONLY')==='CLOUD_SYNC'){const p=await cloudProvider();engine=createSyncEngine({provider:p});engine.start();}return stopSync;}
export async function restartSync(){stopSync();return initializeSync();}
export async function syncNow(){if(await financeRepository.getSetting('privacyMode','LOCAL_ONLY')!=='CLOUD_SYNC')throw new Error('Cloud sync is disabled.');if(!engine){const p=await cloudProvider();engine=createSyncEngine({provider:p});engine.start();}return engine.syncNow();}
