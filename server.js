'use strict';
const express = require('express');
const path    = require('path');
const crypto  = require('crypto');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

/* ─── STATUS ───────────────────────────────────────────────── */
app.get('/api/status', (_req, res) => {
  res.json({
    mode:      'server',
    openai:    !!process.env.OPENAI_API_KEY,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    grok:      !!process.env.GROK_API_KEY,
    kraken:    !!(process.env.KRAKEN_API_KEY && process.env.KRAKEN_SECRET),
    binance:   !!(process.env.BINANCE_API_KEY && process.env.BINANCE_SECRET),
    oanda:     !!process.env.OANDA_API_KEY
  });
});

/* ─── AI PROXY ─────────────────────────────────────────────── */
app.post('/api/ai', async (req, res) => {
  try {
    const { provider, model, messages, maxTokens, temperature } = req.body;
    if (!Array.isArray(messages)) return res.status(400).json({ error: 'Mangler messages-array' });

    let result;
    if (provider === 'anthropic') {
      result = await callAnthropic(model, messages, maxTokens);
    } else if (provider === 'grok') {
      const key = process.env.GROK_API_KEY;
      if (!key) throw new Error('GROK_API_KEY er ikke satt som Railway-miljøvariabel');
      result = await callOpenAICompat('https://api.x.ai/v1', key, model, messages, maxTokens, temperature);
    } else {
      result = await callOpenAI(model, messages, maxTokens, temperature);
    }
    res.json(result);
  } catch (e) {
    console.error('[AI]', e.message);
    res.status(500).json({ error: e.message });
  }
});

function isOSeries(m) { return /^o\d/.test(m || ''); }
function isGPT5(m)    { return /^gpt-5/.test(m || ''); }

async function callOpenAI(model, messages, maxTokens, temperature) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY er ikke satt som Railway-miljøvariabel');

  let msgs = messages;
  if (isOSeries(model)) {
    msgs = messages.map(m => m.role === 'system' ? { ...m, role: 'developer' } : m);
  }

  const useCompletion = isOSeries(model) || isGPT5(model);
  const body = { model, messages: msgs };
  if (useCompletion) {
    body.max_completion_tokens = maxTokens || 2000;
  } else {
    body.max_tokens  = maxTokens || 2000;
    body.temperature = temperature ?? 0.7;
  }

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body)
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`OpenAI ${r.status}: ${t.slice(0,300)}`); }
  const d = await r.json();
  return { text: d.choices[0].message.content, usage: d.usage };
}

async function callAnthropic(model, messages, maxTokens) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY er ikke satt som Railway-miljøvariabel');

  const sysMsg  = messages.find(m => m.role === 'system');
  const chatMsg = messages.filter(m => m.role !== 'system');
  const body = {
    model: model || 'claude-sonnet-4-5-20250929',
    max_tokens: maxTokens || 2000,
    messages: chatMsg,
    ...(sysMsg ? { system: sysMsg.content } : {})
  };

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`Anthropic ${r.status}: ${t.slice(0,300)}`); }
  const d = await r.json();
  return {
    text: d.content[0].text,
    usage: {
      prompt_tokens:     d.usage.input_tokens,
      completion_tokens: d.usage.output_tokens,
      total_tokens:      d.usage.input_tokens + d.usage.output_tokens
    }
  };
}

async function callOpenAICompat(baseUrl, key, model, messages, maxTokens, temperature) {
  const body = { model, messages, max_tokens: maxTokens || 2000, temperature: temperature ?? 0.7 };
  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body)
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`API ${r.status}: ${t.slice(0,300)}`); }
  const d = await r.json();
  return { text: d.choices[0].message.content, usage: d.usage };
}

/* ─── KRAKEN SIGNING ───────────────────────────────────────── */
async function krakenSign(urlPath, postData, secret) {
  const nonce    = (postData.match(/nonce=(\d+)/) || [])[1] || '';
  const sha256   = crypto.createHash('sha256').update(Buffer.from(nonce + postData)).digest();
  const msg      = Buffer.concat([Buffer.from(urlPath), sha256]);
  const key      = Buffer.from(secret, 'base64');
  return crypto.createHmac('sha512', key).update(msg).digest('base64');
}

async function krakenRequest(urlPath, extraParams = '') {
  const apiKey = process.env.KRAKEN_API_KEY;
  const secret = process.env.KRAKEN_SECRET;
  if (!apiKey || !secret) throw new Error('KRAKEN_API_KEY og KRAKEN_SECRET er ikke satt som Railway-miljøvariabler');

  const nonce    = Date.now().toString();
  const postData = `nonce=${nonce}${extraParams ? '&' + extraParams : ''}`;
  const sig      = await krakenSign(urlPath, postData, secret);

  const r = await fetch('https://api.kraken.com' + urlPath, {
    method: 'POST',
    headers: {
      'API-Key':     apiKey,
      'API-Sign':    sig,
      'Content-Type':'application/x-www-form-urlencoded'
    },
    body: postData
  });
  if (!r.ok) throw new Error(`Kraken HTTP ${r.status}`);
  return r.json();
}

app.post('/api/kraken/balance', async (_req, res) => {
  try {
    const d = await krakenRequest('/0/private/Balance');
    res.json(d);
  } catch (e) {
    console.error('[Kraken balance]', e.message);
    res.status(500).json({ error: [e.message] });
  }
});

app.post('/api/kraken/order', async (req, res) => {
  try {
    const { pair, type, ordertype, volume } = req.body;
    if (!pair || !type || !volume) throw new Error('Mangler ordre-parametere');
    const extra = `pair=${encodeURIComponent(pair)}&type=${type}&ordertype=${ordertype || 'market'}&volume=${volume}`;
    const d = await krakenRequest('/0/private/AddOrder', extra);
    res.json(d);
  } catch (e) {
    console.error('[Kraken order]', e.message);
    res.status(500).json({ error: [e.message] });
  }
});

/* ─── START ────────────────────────────────────────────────── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🤖 Norbot server kjører på port ${PORT}`);
  console.log('─'.repeat(40));
  console.log('  OpenAI:    ', process.env.OPENAI_API_KEY     ? '✅ Konfigurert' : '❌ Mangler OPENAI_API_KEY');
  console.log('  Anthropic: ', process.env.ANTHROPIC_API_KEY ? '✅ Konfigurert' : '❌ Mangler ANTHROPIC_API_KEY');
  console.log('  Grok:      ', process.env.GROK_API_KEY      ? '✅ Konfigurert' : '❌ Mangler GROK_API_KEY');
  console.log('  Kraken:    ', (process.env.KRAKEN_API_KEY && process.env.KRAKEN_SECRET) ? '✅ Konfigurert' : '❌ Mangler KRAKEN_API_KEY / KRAKEN_SECRET');
  console.log('╯'.repeat(40));
});
