import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { cp, readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

export default defineConfig({
  base: process.env.VITE_BASE || './',
  plugins: [react(), {
    name: 'preserve-market-module',
    configureServer(server) {
      server.middlewares.use('/legacy-market', async (req,res,next) => {
        try {
          const root=resolve('site');
          let target=resolve(root,'.'+decodeURIComponent(new URL(req.url||'/', 'http://local').pathname));
          if(target!==root&&!target.startsWith(root+sep))return next();
          if((await stat(target)).isDirectory())target=resolve(target,'index.html');
          const body=await readFile(target);
          res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'} as Record<string,string>)[extname(target)]||'application/octet-stream');
          res.end(body);
        }catch{next();}
      });
    },
    async writeBundle(){await cp('site','dist/legacy-market',{recursive:true});},
  },VitePWA({
    registerType:'prompt', includeAssets:['icon.svg','icons/*.png'],
    manifest:{name:'Tala — Personal Finance & FIRE',short_name:'Tala',description:'A private, offline-first financial home.',theme_color:'#173c34',background_color:'#f5f6f8',display:'standalone',start_url:'.',scope:'.',icons:[{src:'icons/icon-192.png',sizes:'192x192',type:'image/png',purpose:'any maskable'},{src:'icons/icon-512.png',sizes:'512x512',type:'image/png',purpose:'any maskable'}]},
    workbox:{globPatterns:['**/*.{js,css,html,svg,png,json,woff2}'],maximumFileSizeToCacheInBytes:4000000,navigateFallback:'index.html',navigateFallbackDenylist:[/^\/api\//,/\/legacy-market(?:\/|$)/],cleanupOutdatedCaches:true},
  })],
  server:{host:'127.0.0.1',port:5173,strictPort:true,proxy:{'/api':'http://127.0.0.1:5180'}},
  preview:{host:'127.0.0.1',port:5174,strictPort:true,proxy:{'/api':'http://127.0.0.1:5180'}},
  build:{target:'es2022',sourcemap:false},
});
