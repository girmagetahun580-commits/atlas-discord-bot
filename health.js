import { createServer } from 'http';
import { handleAPIRequest } from './api.js';

const PORT = process.env.PORT || 3000;
let botOnline = false;
let lastActivity = Date.now();

export function markOnline() { botOnline = true; lastActivity = Date.now(); }
export function markActivity() { lastActivity = Date.now(); }

export function startHealthServer() {
  const server = createServer(async (req, res) => {
    if (req.url === '/health') {
      res.writeHead(botOnline ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: botOnline ? 'ok' : 'offline',
        lastActivity: new Date(lastActivity).toISOString(),
        idleMinutes: Math.floor((Date.now() - lastActivity) / 60000),
      }));
      return;
    }
    const handled = await handleAPIRequest(req, res);
    if (handled) return;
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(PORT, () => {
    console.log(`   Health: http://localhost:${PORT}/health`);
    console.log(`   API: http://localhost:${PORT}/api/*`);
  });
}
