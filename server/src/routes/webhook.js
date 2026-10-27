import express from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { verifyWebhookSignature } from '../whatsapp/metaCloud.js';
import { handleWebhook } from '../services/deliveryService.js';

/** Meta WhatsApp webhook: GET = subscription handshake, POST = signed events. Not behind user auth. */
const router = express.Router();

router.get('/', (req, res) => {
  const token = String(req.query['hub.verify_token'] || '');
  const expected = config.whatsapp.webhookVerifyToken;
  const ok = expected && token.length === expected.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  if (req.query['hub.mode'] === 'subscribe' && ok) return res.status(200).send(String(req.query['hub.challenge'] || ''));
  res.sendStatus(403);
});

router.post('/', express.raw({ type: 'application/json', limit: '2mb' }), async (req, res) => {
  if (!verifyWebhookSignature(req.body, req.headers['x-hub-signature-256'])) return res.sendStatus(401);
  res.sendStatus(200); // acknowledge fast; Meta retries on non-2xx
  try {
    await handleWebhook(JSON.parse(req.body.toString('utf8')));
  } catch (e) {
    console.error('[webhook]', e);
  }
});

export default router;
