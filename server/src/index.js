import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import mongoose from 'mongoose';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { ensureStorage } from './services/storage.js';
import { startScheduler } from './services/scheduler.js';
import { closeBrowser, warmBrowser } from './services/image.js';
import { closeMysql } from './services/mysqlSource.js';
import { errorHandler, originCheck } from './middleware/index.js';
import api from './routes/api.js';
import webhook from './routes/webhook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({
    // Report images are loaded by the client from the API's domain when the two are deployed separately
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: {
      directives: {
        'img-src': ["'self'", 'data:', 'blob:'],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
      },
    },
  }));
  app.use(cors({ origin: config.corsOrigin.split(',').map((s) => s.trim()), credentials: true }));
  app.use('/api/whatsapp/webhook', webhook); // raw body, signature-checked
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(originCheck);
  app.get('/api/health', (req, res) => res.json({ ok: true, db: mongoose.connection.readyState === 1 }));
  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // Serve the built frontend in production (client/dist)
  const dist = path.resolve(__dirname, '../../client/dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }
  app.use(errorHandler);
  return app;
}

async function main() {
  await ensureStorage();
  await mongoose.connect(config.mongoUri);
  console.log('[db] connected');
  const app = createApp();
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(config.port, () => resolve(listener));
    listener.once('error', reject);
  }).catch((error) => {
    if (error.code === 'EADDRINUSE') throw new Error(`Port ${config.port} is already in use. Set PORT to a free port in server/.env and update API_PROXY_TARGET in client/vite.config.ts.`);
    throw error;
  });
  console.log(`[api] listening on :${config.port}`);
  await startScheduler();
  warmBrowser();
  const shutdown = async () => {
    server.close();
    await closeBrowser();
    await closeMysql();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
