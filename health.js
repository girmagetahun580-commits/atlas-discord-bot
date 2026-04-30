// Simple HTTP health endpoint for uptime monitoring
// Point UptimeRobot (free) or similar at http://your-railway-url/health
import { createServer } from 'http';

const PORT = process.env.PORT || 3000;
let botOnline = false;
let lastActivity = Date.now();

export function markOnline() {
  botOnline = true;
  lastActivity = Date.now();
}

export function markActivity() {
  lastActivity = Date.now();
}

export function startHealthServer() {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      const uptimeMinutes = Math.floor((Date.now() - lastActivity) / 60000);
      res.writeHead(botOnline ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: botOnline ? 'ok' : 'offline',
        lastActivity: new Date(lastActivity).toISOString(),
        idleMinutes: uptimeMinutes,
      }));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.listen(PORT, () => {
    console.log(`   Health endpoint: http://localhost:${PORT}/health`);
  });
}
