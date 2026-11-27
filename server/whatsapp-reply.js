'use strict';

function normalizeWhatsAppPhone(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || /@(lid|g\.us|broadcast)$/i.test(raw)) return null;
  const userPart = raw.split('@')[0].split(':')[0];
  const digits = userPart.replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

function buildWhatsAppFallbackUrl(phone, message) {
  const normalized = normalizeWhatsAppPhone(phone);
  if (!normalized) return null;
  return `https://wa.me/${normalized}?text=${encodeURIComponent(message)}`;
}

function getEvolutionConfig(env = process.env) {
  const baseUrl = String(env.EVOLUTION_API_URL || '').trim().replace(/\/+$/, '');
  const apiKey = String(env.EVOLUTION_API_KEY || '').trim();
  const instance = String(env.EVOLUTION_INSTANCE || '').trim();
  if (!baseUrl || !apiKey || !instance) return null;
  let parsed;
  try { parsed = new URL(baseUrl); } catch { return null; }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) return null;
  return { baseUrl, apiKey, instance };
}

async function sendEvolutionText({ phone, message, env = process.env, fetchImpl = global.fetch }) {
  const normalizedPhone = normalizeWhatsAppPhone(phone);
  const fallbackUrl = buildWhatsAppFallbackUrl(normalizedPhone || phone, message);
  if (!normalizedPhone || !fallbackUrl) {
    return { sent: false, fallbackUrl: null, reason: 'A valid WhatsApp phone number is not available.' };
  }
  const config = getEvolutionConfig(env);
  if (!config) {
    return { sent: false, fallbackUrl, reason: 'Evolution outbound API is not fully configured.' };
  }
  if (typeof fetchImpl !== 'function') {
    return { sent: false, fallbackUrl, reason: 'Server HTTP client is unavailable.' };
  }

  try {
    const response = await fetchImpl(
      `${config.baseUrl}/message/sendText/${encodeURIComponent(config.instance)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: config.apiKey },
        body: JSON.stringify({ number: normalizedPhone, text: message, linkPreview: false }),
        signal: AbortSignal.timeout(15000)
      }
    );
    if (!response.ok) {
      return { sent: false, fallbackUrl, reason: `Evolution API returned HTTP ${response.status}.` };
    }
    return { sent: true, fallbackUrl: null };
  } catch (error) {
    return { sent: false, fallbackUrl, reason: error?.name === 'TimeoutError' ? 'Evolution API request timed out.' : 'Evolution API could not be reached.' };
  }
}

function installWhatsAppReply(app, db, requireRole, writeAudit, sendText = sendEvolutionText) {
  app.post(
    '/api/staff/enquiries/:id/reply',
    requireRole('developer', 'administrator', 'reception'),
    async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const id = Number(req.params.id);
      const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
      if (!Number.isSafeInteger(id) || id < 1) {
        return res.status(400).json({ success: false, error: 'Invalid enquiry ID.' });
      }
      if (!message || message.length > 4000) {
        return res.status(400).json({ success: false, error: 'Reply must contain 1 to 4000 characters.' });
      }

      try {
        const enquiry = db.prepare('SELECT id, source, sender_phone FROM enquiries WHERE id = ?').get(id);
        if (!enquiry) return res.status(404).json({ success: false, error: 'Enquiry not found.' });
        if (enquiry.source !== 'whatsapp_business') {
          return res.status(422).json({ success: false, error: 'Replies are available only for WhatsApp enquiries.' });
        }
        const phone = normalizeWhatsAppPhone(enquiry.sender_phone || '');
        if (!phone) {
          return res.status(422).json({ success: false, error: 'This enquiry has no valid WhatsApp phone number. The reply cannot be addressed.' });
        }

        const delivery = await sendText({ phone, message });
        if (delivery.sent) {
          try {
            writeAudit(req.session.staff.id, 'enquiry.whatsapp_reply_sent', 'enquiry', id, {
              channel: 'evolution_api', message_length: message.length
            });
          } catch (auditError) {
            console.error('[WhatsApp reply] Audit write failed:', auditError.message);
          }
          return res.json({ success: true, sent: true, delivery: 'evolution_api' });
        }

        if (!delivery.fallbackUrl) {
          return res.status(422).json({ success: false, error: delivery.reason || 'No valid WhatsApp contact is available.' });
        }
        try {
          writeAudit(req.session.staff.id, 'enquiry.whatsapp_reply_handoff', 'enquiry', id, {
            channel: 'whatsapp_app_fallback', message_length: message.length
          });
        } catch (auditError) {
          console.error('[WhatsApp reply] Audit write failed:', auditError.message);
        }
        return res.json({
          success: true,
          sent: false,
          delivery: 'whatsapp_app_fallback',
          fallback_url: delivery.fallbackUrl,
          message: 'Evolution delivery was unavailable. Continue in WhatsApp and tap Send.'
        });
      } catch (error) {
        console.error('[WhatsApp reply] Failed:', error.code || error.message);
        return res.status(500).json({ success: false, error: 'Unable to process this WhatsApp reply.' });
      }
    }
  );
}

module.exports = { normalizeWhatsAppPhone, buildWhatsAppFallbackUrl, getEvolutionConfig, sendEvolutionText, installWhatsAppReply };
