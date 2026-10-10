import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { cp, readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

export default defineConfig({
  base: process.env.VITE_BASE || './',
  plugins: [react(), VitePWA({
    registerType:'prompt', includeAssets:['icon.svg','icons/*.png'],
    manifest:{name:'Tala — Personal Finance & FIRE',short_name:'Tala',description:'A private, offline-first financial home.',theme_color:'#173c34',background_color:'#f5f6f8',display:'standalone',start_url:'.',scope:'.',icons:[{src:'icons/icon-192.png',sizes:'192x192',type:'image/png',purpose:'any maskable'},{src:'icons/icon-512.png',sizes:'512x512',type:'image/png',purpose:'any maskable'}]},
    workbox:{globPatterns:['**/*.{js,css,html,svg,png,json,woff2}'],maximumFileSizeToCacheInBytes:4000000,navigateFallback:'index.html',navigateFallbackDenylist:[/^\/api\//],cleanupOutdatedCaches:true},
  })],
  server:{host:'127.0.0.1',port:5173,strictPort:true,proxy:{'/api':'http://127.0.0.1:5001/kotoba-41ab0/us-central1'}},
  preview:{host:'127.0.0.1',port:5174,strictPort:true,proxy:{'/api':'http://127.0.0.1:5001/kotoba-41ab0/us-central1'}},
  build:{target:'es2022',sourcemap:false},
});
