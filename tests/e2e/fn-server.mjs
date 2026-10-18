// Runs the bundled Neon Function (functions/dist/index.mjs) on a local port,
// the way the Neon runtime calls `export default { fetch }`.
import http from 'node:http';
import { Readable } from 'node:stream';
import fn from '../../functions/dist/index.mjs';

const PORT = Number(process.env.FN_PORT ?? 8000);
http.createServer(async (req, res) => {
  const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  const request = new Request(`http://127.0.0.1:${PORT}${req.url}`, {
    method: req.method, headers: req.headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: 'half',
  });
  const response = await fn.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) for await (const chunk of response.body) res.write(chunk);
  res.end();
}).listen(PORT, () => console.log(`function on ${PORT}`));
