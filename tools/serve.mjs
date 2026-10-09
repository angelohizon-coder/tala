import { createServer } from 'node:http';
import { setDefaultResultOrder } from 'node:dns';
import { Readable } from 'node:stream';
import { readFile, stat, realpath } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLocalGateway, DEFAULT_CONFIG_PATH } from './local-gateway.mjs';

const DEFAULT_SITE_ROOT = fileURLToPath(new URL('../site/', import.meta.url));
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml' };
const contained = (path, root) => path === root || path.startsWith(root + sep);

/** Bind only IPv4 loopback; provider credentials are never served as static files. */
export async function startServer({ port = 5180, siteRoot = DEFAULT_SITE_ROOT, configPath = DEFAULT_CONFIG_PATH, env = {}, fetchFn } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid server port.');
  const root = await realpath(resolve(siteRoot));
  if (contained(resolve(configPath), root)) throw new Error('Private configuration must be outside the public site directory.');
  let gateway;
  const server = createServer(async (req, res) => {
    try {
      const activePort = server.address()?.port;
      const expectedHosts = [`127.0.0.1:${activePort}`, `localhost:${activePort}`];
      const hostCount = req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'host').length;
      if (hostCount !== 1 || !expectedHosts.includes(req.headers.host) || !req.url?.startsWith('/') || req.url.startsWith('//')) {
        res.writeHead(403, { 'Content-Type':'text/plain', 'Cache-Control':'no-store' }).end('Local host required'); return;
      }
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname.startsWith('/api/')) {
        const method = req.method || 'GET';
        const options = { method, headers: req.headers };
        if (!['GET', 'HEAD'].includes(method)) { options.body = Readable.toWeb(req); options.duplex = 'half'; }
        const response = await gateway.handle(new Request(url, options));
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer())); return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow:'GET, HEAD' }).end(); return; }
      const decoded = decodeURIComponent(url.pathname);
      if (decoded.split(/[\\/]/u).some(segment => segment.startsWith('.'))) { res.writeHead(403).end(); return; }
      const path = resolve(root, '.' + decoded);
      if (!contained(path, root)) { res.writeHead(403).end(); return; }
      const info = await stat(path);
      const target = await realpath(info.isDirectory() ? resolve(path, 'index.html') : path);
      if (!contained(target, root)) { res.writeHead(403).end(); return; }
      const body = await readFile(target);
      res.writeHead(200, { 'Content-Type': types[extname(target)] || 'application/octet-stream', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(404, { 'Content-Type':'text/plain', 'Cache-Control':'no-store' }).end('Page not found'); }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 100;
  await new Promise((resolveStart, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', async () => {
      try {
        gateway = await createLocalGateway({ port: server.address().port, configPath, env, ...(fetchFn ? { fetchFn } : {}) });
        server.removeListener('error', reject);
        resolveStart();
      } catch (error) { server.close(); reject(error); }
    });
  });
  return server;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  setDefaultResultOrder('ipv4first');
  startServer({ port: Number(process.env.PORT || 5180), env: process.env })
    .then(server => console.log(`Tala dashboard: http://127.0.0.1:${server.address().port}`))
    .catch(error => { console.error('The local dashboard server could not start. Check its port and site directory.', error?.code || 'Startup error'); process.exitCode = 1; });
}
