import { financeRepository } from '../db/repository';
import type { createFirebaseSyncProvider } from '../sync/firebase';
import { createSyncEngine } from '../sync/engine';
let provider:ReturnType<typeof createFirebaseSyncProvider>|undefined;
let engine:ReturnType<typeof createSyncEngine>|undefined;
export function stopSync(){engine?.stop();engine=undefined;provider=undefined;}
export async function cloudProvider(){if(!provider){const {createFirebaseSyncProvider}=await import('../sync/firebase');provider=createFirebaseSyncProvider();}return provider;}
export async function initializeSync(){if(await financeRepository.getSetting('privacyMode','LOCAL_ONLY')==='CLOUD_SYNC'){const p=await cloudProvider();engine=createSyncEngine({provider:p});engine.start();}return stopSync;}
export async function restartSync(){stopSync();return initializeSync();}
export async function syncNow(){if(await financeRepository.getSetting('privacyMode','LOCAL_ONLY')!=='CLOUD_SYNC')throw new Error('Cloud sync is disabled.');if(!engine){const p=await cloudProvider();engine=createSyncEngine({provider:p});engine.start();}return engine.syncNow();}
