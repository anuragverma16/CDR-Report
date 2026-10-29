import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name} (set it in server/.env)`);
  return v;
}

const isTest = process.env.NODE_ENV === 'test';

// On a hosted server, a local MongoDB address is always a mistake: the server cannot see this computer's database.
function mongoUriFor() {
  const uri = isTest ? process.env.MONGODB_URI || '' : required('MONGODB_URI');
  if (process.env.NODE_ENV === 'production' && /127\.0\.0\.1|localhost/.test(uri)) {
    console.error('[config] MONGODB_URI points to this computer (127.0.0.1 / localhost). On Render, set it to your MongoDB Atlas connection string in the Environment tab, then redeploy.');
  }
  return uri;
}

// Only "meta_cloud" switches away from the Nexsahay gateway; anything else (e.g. a session name typed here) means nexsahay.
const rawProvider = (process.env.WHATSAPP_PROVIDER || 'nexsahay').trim().toLowerCase();
const provider = rawProvider === 'meta_cloud' ? 'meta_cloud' : 'nexsahay';
if (!['nexsahay', 'meta_cloud'].includes(rawProvider)) {
  console.warn(`[config] WHATSAPP_PROVIDER="${process.env.WHATSAPP_PROVIDER}" is not "nexsahay" or "meta_cloud"; using nexsahay. Pick the session with NEXSAHAY_SESSION_ID.`);
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 4000),
  mongoUri: mongoUriFor(),
  jwtSecret: isTest ? 'test-secret' : required('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  // lax for one domain (localhost, or a reverse proxy); none when the client is on another domain (e.g. Render static site)
  cookieSameSite: (process.env.COOKIE_SAMESITE || 'lax').toLowerCase(),
  storageDir: path.resolve(process.env.STORAGE_DIR || path.join(__dirname, '..', 'storage')),
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 25),
  cloudinary: { cloudName: process.env.CLOUDINARY_CLOUD_NAME || '', apiKey: process.env.CLOUDINARY_API_KEY || '', apiSecret: process.env.CLOUDINARY_API_SECRET || '' },
  maxFilesPerUpload: Number(process.env.MAX_FILES_PER_UPLOAD || 10),
  timezone: process.env.APP_TIMEZONE || 'Asia/Kolkata',
  chromiumPath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
  whatsapp: {
    provider,
    nexsahay: {
      baseUrl: process.env.NEXSAHAY_API_BASE || 'https://whatsappbackend.sengarinfotech.com/api',
      sessionId: process.env.NEXSAHAY_SESSION_ID || '',
      apiKey: process.env.NEXSAHAY_API_KEY || '',
    },
    apiVersion: process.env.WHATSAPP_API_VERSION || 'v25.0',
    graphBaseUrl: process.env.WHATSAPP_GRAPH_BASE_URL || 'https://graph.facebook.com',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
    appSecret: process.env.WHATSAPP_APP_SECRET || '',
    webhookVerifyToken: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || '',
    businessNumberDisplay: process.env.WHATSAPP_BUSINESS_NUMBER_DISPLAY || '',
    messageMode: process.env.WHATSAPP_MESSAGE_MODE || 'template',
    templateLanguage: process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en',
    templateImage: process.env.WHATSAPP_TEMPLATE_IMAGE || '',
    templateDocument: process.env.WHATSAPP_TEMPLATE_DOCUMENT || '',
    groupsEnabled: provider === 'nexsahay' || process.env.WHATSAPP_GROUPS_ENABLED === 'true',
  },
  mysql: {
    host: process.env.MYSQL_HOST || '',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || '',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || '',
    answeredTable: process.env.MYSQL_ANSWERED_TABLE || 'answered_calls',
    missedTable: process.env.MYSQL_MISSED_TABLE || 'missed_calls',
    dispositionsTable: process.env.MYSQL_DISPOSITIONS_TABLE || 'call_dispositions',
    // Only needed when the column names are not recognized automatically
    agentColumn: process.env.MYSQL_AGENT_COLUMN || '',
    timeColumn: process.env.MYSQL_TIME_COLUMN || '',
  },
  retry: {
    maxAttempts: Number(process.env.DELIVERY_MAX_ATTEMPTS || 3),
    delayMinutes: Number(process.env.DELIVERY_RETRY_DELAY_MINUTES || 10),
  },
};

export function mysqlConfigured() {
  const m = config.mysql;
  return Boolean(m.host && m.user && m.database);
}

export function whatsappConfigured() {
  const w = config.whatsapp;
  if (w.provider === 'nexsahay') {
    // Keys are per session and come from the gateway; whether a session is CONNECTED is checked at send time.
    return Boolean(w.nexsahay?.baseUrl);
  }
  return Boolean(w.phoneNumberId && w.accessToken);
}
