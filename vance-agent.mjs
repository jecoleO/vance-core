import fs from 'fs';
import path from 'path';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const STATE_PATH = './vance.state.json';

if (!STRIPE_SECRET_KEY) {
  console.error('[VANCE] Missing STRIPE_SECRET_KEY in environment.');
  process.exit(1);
}

const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));

state.deployed_assets = Array.isArray(state.deployed_assets) ? state.deployed_assets : [];
state.catalog_manifest = Array.isArray(state.catalog_manifest) ? state.catalog_manifest : [];
state.autonomous_lab_assets = Array.isArray(state.autonomous_lab_assets) ? state.autonomous_lab_assets : [];
state.execution_log = Array.isArray(state.execution_log) ? state.execution_log : [];

function toFormUrlEncoded(obj, prefix = '') {
  const str = [];
  for (const p in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, p) && obj[p] !== undefined) {
      const k = prefix ? `${prefix}[${p}]` : p;
      const v = obj[p];
      str.push(
        v !== null && typeof v === 'object'
          ? toFormUrlEncoded(v, k)
          : `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
      );
    }
  }
  return str.join('&');
}

async function stripeRequest(endpoint, method = 'GET', bodyObj = null) {
  const headers = {
    Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
    'Content-Type': 'application/x-www-form-urlencoded'
  };
  const options = { method, headers, signal: AbortSignal.timeout(20000) };
  if (bodyObj && method === 'POST') {
    options.body = toFormUrlEncoded(bodyObj);
  }
  const res = await fetch(`https://api.stripe.com/v1/${endpoint}`, options);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Stripe API Error (${endpoint}): ${data.error?.message || JSON.stringify(data)}`);
  }
  return data;
}

async function syncStripeTelemetry() {
  console.log('[VANCE] Syncing Stripe financial telemetry...');
  try {
    const balance = await stripeRequest('balance');
    const available = balance.available?.reduce((acc, b) => acc + b.amount, 0) || 0;
    const pending = balance.pending?.reduce((acc, b) => acc + b.amount, 0) || 0;

    const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
    const charges = await stripeRequest(`charges?created[gte]=${thirtyDaysAgo}&limit=100`);
    const monthlyGrossCents = charges.data
      ?.filter(c => c.paid && !c.refunded)
      .reduce((acc, c) => acc + c.amount, 0) || 0;

    state.financial_telemetry.stripe_available_balance = +(available / 100).toFixed(2);
    state.financial_telemetry.stripe_pending_balance = +(pending / 100).toFixed(2);
    state.financial_telemetry.monthly_revenue_current = +(monthlyGrossCents / 100).toFixed(2);
    state.financial_telemetry.last_synced = new Date().toISOString().slice(0, 10);
    console.log(`[VANCE] Current 30-Day Gross: $${state.financial_telemetry.monthly_revenue_current} USD`);
  } catch (err) {
    console.warn('[VANCE] Telemetry warning:', err.message);
  }
}

async function getOrCreateStripeLink(item, targetRedirectUrl) {
  console.log(`[VANCE] Provisioning/checking Stripe asset: ${item.name} ($${(item.price_cents / 100).toFixed(2)})`);

  let product = null;
  try {
    const existing = await stripeRequest('products?active=true&limit=50');
    product = Array.isArray(existing.data) ? existing.data.find(p => p.name === item.name) : null;
  } catch (e) {}

  if (!product) {
    product = await stripeRequest('products', 'POST', {
      name: item.name,
      description: item.tagline
    });
  }

  let price = null;
  try {
    const existingPrices = await stripeRequest(`prices?product=${product.id}&active=true&limit=10`);
    price = Array.isArray(existingPrices.data) ? existingPrices.data.find(pr => pr.unit_amount === item.price_cents) : null;
  } catch (e) {}

  if (!price) {
    price = await stripeRequest('prices', 'POST', {
      product: product.id,
      unit_amount: item.price_cents,
      currency: 'usd'
    });
  }

  try {
    const existingLinks = await stripeRequest('payment_links?active=true&limit=50');
    const match = Array.isArray(existingLinks.data)
      ? existingLinks.data.find(pl => pl.after_completion?.redirect?.url === targetRedirectUrl)
      : null;
    if (match) return { product_id: product.id, price_id: price.id, checkout_url: match.url };
  } catch (e) {}

  const paymentLink = await stripeRequest('payment_links', 'POST', {
    line_items: [{ price: price.id, quantity: 1 }],
    after_completion: {
      type: 'redirect',
      redirect: { url: targetRedirectUrl }
    }
  });

  return { product_id: product.id, price_id: price.id, checkout_url: paymentLink.url };
}

function packageHtml(rawHtml, item, checkoutUrl, hubUrl = '../../index.html', hubName = 'The Arcade') {
  const isArcade = item.type === 'arcade_cartridge';
  const unlockKey = `vance_unlocked_${item.slug}`;

  const injectedSnippet = `
<!-- [VANCE-MERCHANT-HARNESS: START] -->
<div id="vance-header" style="background:#090d16;color:#e2e8f0;padding:10px 18px;font-family:system-ui,-apple-system,sans-serif;font-size:13px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #1e293b;position:sticky;top:0;z-index:999999;">
  <div style="display:flex;align-items:center;gap:14px;">
    <a href="${hubUrl}" style="color:#38bdf8;text-decoration:none;font-weight:700;">&larr; ${hubName}</a>
    <span style="color:#64748b;">|</span>
    <span style="font-weight:600;">${item.name}</span>
  </div>
  <div style="display:flex;align-items:center;gap:10px;">
    <span id="vance-pro-badge" style="display:none;background:#10b98122;color:#10b981;padding:3px 8px;border-radius:4px;font-size:11px;font-weight:700;border:1px solid #10b98144;">OFFLINE EDITION UNLOCKED</span>
    <button id="vance-dl-btn" style="display:none;background:#10b981;color:#041f14;border:none;padding:5px 12px;border-radius:6px;font-weight:700;cursor:pointer;font-size:12px;">Download Offline .html</button>
    <a id="vance-buy-btn" href="${checkoutUrl}" target="_blank" style="background:#38bdf8;color:#081726;padding:5px 12px;border-radius:6px;font-weight:700;text-decoration:none;font-size:12px;">
      ${isArcade ? `Buy Standalone Cartridge ($${(item.price_cents / 100).toFixed(0)})` : `Unlock Pro Edition ($${(item.price_cents / 100).toFixed(0)})`}
    </a>
  </div>
</div>
<script>
(function() {
  const isUnlocked = window.location.search.includes('unlocked') || localStorage.getItem('${unlockKey}') === 'true' || localStorage.getItem('vance_arcade_vault') === 'true';
  if (isUnlocked) {
    localStorage.setItem('${unlockKey}', 'true');
    const buyBtn = document.getElementById('vance-buy-btn');
    const badge = document.getElementById('vance-pro-badge');
    const dlBtn = document.getElementById('vance-dl-btn');
    if (buyBtn) buyBtn.style.display = 'none';
    if (badge) badge.style.display = 'inline-block';
    if (dlBtn) {
      dlBtn.style.display = 'inline-block';
      dlBtn.onclick = function() {
        const blob = new Blob([document.documentElement.outerHTML], { type: 'text/html' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = '${item.slug}.offline.html';
        a.click();
      };
    }
  }
})();
</script>
<!-- [VANCE-MERCHANT-HARNESS: END] -->
`;

  if (rawHtml.includes('<body')) {
    return rawHtml.replace(/<body[^>]*>/i, match => `${match}\n${injectedSnippet}`);
  }
  return `${injectedSnippet}\n${rawHtml}`;
}

async function callGemini(prompt, isJson = false, timeoutMs = 60000) {
  const model = 'gemini-3.8-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: isJson ? 0.3 : 0.2,
      thinkingConfig: {
        thinkingBudget: 0 // Bypasses internal reasoning tokens for instant output
      }
    }
  };

  if (isJson) {
    body.generationConfig.response_mime_type = 'application/json';
  }

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      console.log(`[VANCE-AI] Querying ${model} (attempt ${attempt}/${maxAttempts}, timeout: ${Math.round(timeoutMs / 1000)}s)...`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      const raw = await res.text();
      clearTimeout(timer);

      if (res.status === 503 || res.status === 429) {
        const waitMs = attempt * 5000;
        console.warn(`[VANCE-AI] ${model} capacity dip (HTTP ${res.status}). Waiting ${waitMs / 1000}s...`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }

      if (!res.ok) {
        throw new Error(`Gemini API HTTP ${res.status}: ${raw.slice(0, 150)}`);
      }

      const data = JSON.parse(raw);
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
      if (!text) throw new Error('Gemini returned empty candidate content');
      return text;
    } catch (err) {
      clearTimeout(timer);
      const isAbort = err.name === 'AbortError' || controller.signal.aborted;
      const msg = isAbort ? `Socket timed out after ${Math.round(timeoutMs / 1000)}s` : err.message;
      if (attempt === maxAttempts) throw new Error(msg);
      console.warn(`[VANCE-AI] Attempt ${attempt} failed (${msg}). Retrying in 4s...`);
      await new Promise(r => setTimeout(r, 4000));
    }
  }

  throw new Error(`Exhausted all retry attempts on ${model}.`);
}

async function generateMarketingDispatch(toolSpec, webUrl, checkoutUrl) {
  if (!GEMINI_API_KEY) return;
  console.log(`[VANCE-MARKETING] Generating launch dispatch for ${toolSpec.name}...`);

  const prompt = `
You are Vance, an autonomous commercial software operator.
Write a concise, launch-ready promotional packet for our newly deployed tool:
Name: ${toolSpec.name}
Tagline: ${toolSpec.tagline}
Web App Link: ${webUrl}
Stripe Offline Download Link: ${checkoutUrl}

Generate a clear Markdown document with:
1. Substack Post Draft (Subject line + 3 short paragraphs explaining the pain point, zero-cloud offline utility, and links).
2. Hacker News "Show HN" / Reddit r/webdev value post.
3. A 280-character launch post.

Keep the tone authentic, direct, and focused on local-first privacy. No fluff.
`;

  try {
    const content = await callGemini(prompt, false, 45000);
    if (content) {
      const dispatchDir = './marketing/dispatches';
      fs.mkdirSync(dispatchDir, { recursive: true });
      const filename = `${new Date().toISOString().slice(0, 10)}-${toolSpec.slug}.md`;
      fs.writeFileSync(path.join(dispatchDir, filename), content, 'utf8');
      console.log(`[VANCE-MARKETING] Saved launch dispatch to ${dispatchDir}/${filename}`);
    }
  } catch (err) {
    console.warn('[VANCE-MARKETING] Dispatch generation failed:', err.message);
  }
}

async function thinkAndSynthesizeNextTool() {
  if (!GEMINI_API_KEY) {
    console.log('[VANCE-AI] No GEMINI_API_KEY detected. Skipping autonomous synthesis.');
    return;
  }

  console.log('[VANCE-AI] Engaging cognitive loop: Analyzing inventory...');

  const previousTools = [
    ...state.deployed_assets.map(a => `${a.name}: ${a.tagline}`),
    ...state.autonomous_lab_assets.map(a => `${a.name}: ${a.tagline}`)
  ].join('\n');

  const ideationPrompt = `
You are Vance, an autonomous commercial software architect.
Review the tools already created:
${previousTools || 'None yet.'}

Task: Invent ONE high-utility, local-first, zero-cloud developer or business utility that has NOT been built yet.
Top Priority: Deterministic Japan Freelance 10.21% Withholding & Consumption Tax Invoice Engine.

Return a strict JSON object with these exact keys:
{
  "slug": "japan-freelance-tax-engine",
  "name": "Japan Freelance Tax & Qualified Invoice Engine",
  "tagline": "Offline 10.21% withholding tax and 8%/10% consumption tax calculator with print-ready invoice export.",
  "price_cents": 600
}
`;

  let toolSpec = null;
  try {
    // Fast JSON call: 35s timeout
    const rawJson = await callGemini(ideationPrompt, true, 35000);
    toolSpec = JSON.parse(rawJson);
  } catch (err) {
    console.warn('[VANCE-AI] Ideation failed:', err.message);
    return;
  }

  if (!toolSpec || !toolSpec.slug) {
    console.warn('[VANCE-AI] Invalid tool specification returned.');
    return;
  }

  if (state.autonomous_lab_assets.some(a => a.slug === toolSpec.slug)) {
    console.log(`[VANCE-AI] Asset ${toolSpec.slug} is already deployed. Standing by.`);
    return;
  }

  console.log(`[VANCE-AI] Invented concept: ${toolSpec.name} (${toolSpec.slug})`);

  const codingPrompt = `
Write a complete, single-file, production-ready, beautiful HTML5/JavaScript application for:
Name: ${toolSpec.name}
Description: ${toolSpec.tagline}

CRITICAL RULES:
1. Everything must be self-contained in ONE single HTML file (HTML, clean modern inline CSS, vanilla JS).
2. Clean dark theme (Slate-900 / Slate-950, Sky blue / Emerald accents, crisp typography).
3. 100% functional, responsive, and working. Include interactive inputs, buttons, calculations, and local-first output (e.g. printable table or clean export).
4. ZERO external backend dependencies. Run 100% in-browser client.
5. Return ONLY the raw valid <!DOCTYPE html> string. No explanation, no backticks.
`;

  try {
    // Heavy code synthesis call: 180s (3 full minutes) timeout
    let appHtml = await callGemini(codingPrompt, false, 180000);
    appHtml = appHtml.replace(/^```html/i, '').replace(/```$/i, '').trim();

    if (appHtml.startsWith('<!DOCTYPE') || appHtml.includes('<html')) {
      const redirectUrl = `${state.agent_identity.storefront_url}products/${toolSpec.slug}/?pro=unlocked`;
      const stripeData = await getOrCreateStripeLink(toolSpec, redirectUrl);
      const packagedHtml = packageHtml(appHtml, toolSpec, stripeData.checkout_url, '../../lab/index.html', 'Vance Lab');

      const targetDir = path.join(state.pipeline_policy.products_dir, toolSpec.slug);
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, 'index.html'), packagedHtml, 'utf8');

      const webUrl = `${state.agent_identity.storefront_url}products/${toolSpec.slug}/`;
      state.autonomous_lab_assets.push({
        slug: toolSpec.slug,
        type: 'autonomous_utility',
        name: toolSpec.name,
        tagline: toolSpec.tagline,
        price_cents: toolSpec.price_cents,
        revenue_cents: 0,
        web_url: `../products/${toolSpec.slug}/`,
        checkout_url: stripeData.checkout_url,
        stripe_product_id: stripeData.product_id,
        invented_at: new Date().toISOString()
      });

      state.execution_log.unshift(`${new Date().toISOString().slice(0, 10)}: Vance Lab deployed ${toolSpec.name}`);
      console.log(`[VANCE-AI] Deployed ${toolSpec.name} to Vance Lab.`);

      await generateMarketingDispatch(toolSpec, webUrl, stripeData.checkout_url);
    }
  } catch (err) {
    console.warn('[VANCE-AI] Code generation failed:', err.message);
  }
}

function rebuildStoreA() {
  console.log('[VANCE] Building Store A: Creative Arcade & Author Vault (index.html)...');
  const userAssets = state.deployed_assets || [];
  const renderCard = a => `
    <div class="card">
      <div>
        <div class="badge">$${(a.price_cents / 100).toFixed(2)} USD</div>
        <h3>${a.name}</h3>
        <p>${a.tagline}</p>
      </div>
      <div class="actions">
        <a href="${a.web_url}" class="btn secondary">Launch Browser App</a>
        <a href="${a.checkout_url}" class="btn primary">Buy Offline Copy ($${(a.price_cents / 100).toFixed(0)})</a>
      </div>
    </div>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>JAE Cole // The Creative Arcade & Lore Vault</title>
  <style>
    :root { --bg: #0b0f19; --card: #131b2e; --text: #e2e8f0; --accent: #38bdf8; --emerald: #10b981; }
    body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 2rem; line-height: 1.6; }
    .container { max-width: 940px; margin: 0 auto; }
    header { border-bottom: 1px solid #1e293b; padding-bottom: 1.5rem; margin-bottom: 2rem; display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 1rem; }
    .lab-link { display: inline-flex; align-items: center; gap: 6px; font-size: 0.85rem; color: #a855f7; text-decoration: none; padding: 6px 12px; background: #2e106544; border: 1px solid #a855f744; border-radius: 8px; font-weight: 600; }
    .grid { display: grid; gap: 1.5rem; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
    .card { background: var(--card); padding: 1.5rem; border-radius: 12px; border: 1px solid #1e293b; display: flex; flex-direction: column; justify-content: space-between; }
    .badge { display: inline-block; background: rgba(56, 189, 248, 0.15); color: var(--accent); padding: 0.25rem 0.6rem; border-radius: 6px; font-weight: 700; font-size: 0.8rem; margin-bottom: 0.75rem; }
    .actions { display: flex; gap: 0.75rem; margin-top: 1.25rem; }
    .btn { text-decoration: none; padding: 0.6rem 1rem; border-radius: 8px; font-weight: 600; font-size: 0.85rem; text-align: center; flex: 1; }
    .btn.primary { background: var(--accent); color: #081726; }
    .btn.secondary { background: #1e293b; color: var(--text); }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1 style="margin:0; color: var(--accent);">JAE COLE // THE ARCADE & VAULT</h1>
        <p style="margin:0.25rem 0 0; color:#94a3b8;">Original Creative Experiments, Language Engines & Retro Cartridges</p>
      </div>
      <div>
        <a href="./lab/index.html" class="lab-link">Visit Vance Autonomous Lab &rarr;</a>
      </div>
    </header>

    <div class="grid">
      ${userAssets.map(renderCard).join('\n') || '<p style="color:#64748b;">No items staged yet.</p>'}
    </div>
    <footer style="margin-top:3rem; font-size:0.8rem; color:#64748b; text-align:center;">
      Curated by JAE Cole &middot; Powered by Vance Merchant Engine
    </footer>
  </div>
</body>
</html>`;

  fs.writeFileSync('./index.html', html, 'utf8');
}

function rebuildStoreB() {
  console.log('[VANCE] Building Store B: Vance Autonomous Lab (lab/index.html)...');
  const allLabAssets = state.autonomous_lab_assets || [];
  fs.mkdirSync('./lab', { recursive: true });

  const earners = allLabAssets.filter(a => (a.revenue_cents || 0) > 0);
  earners.sort((a, b) => b.revenue_cents - a.revenue_cents);

  const unproven = allLabAssets.filter(a => !a.revenue_cents || a.revenue_cents === 0);
  unproven.sort((a, b) => new Date(b.invented_at || 0) - new Date(a.invented_at || 0));

  const showcase = [...earners, ...unproven].slice(0, 10);
  const showcaseSlugs = new Set(showcase.map(s => s.slug));
  const archived = allLabAssets.filter(a => !showcaseSlugs.has(a.slug));

  const renderCard = a => `
    <div class="card">
      <div>
        <div class="badge">$${(a.price_cents / 100).toFixed(2)} USD</div>
        <h3>${a.name}</h3>
        <p>${a.tagline}</p>
      </div>
      <div class="actions">
        <a href="${a.web_url}" class="btn secondary">Launch App</a>
        <a href="${a.checkout_url}" class="btn primary">Buy Offline ($${(a.price_cents / 100).toFixed(0)})</a>
      </div>
    </div>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Vance Autonomous Lab // Zero-Cloud Utilities</title>
  <style>
    :root { --bg: #030712; --card: #0f172a; --text: #f8fafc; --accent: #a855f7; }
    body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 2rem; line-height: 1.6; }
    .container { max-width: 940px; margin: 0 auto; }
    header { border-bottom: 1px solid #1e293b; padding-bottom: 1.5rem; margin-bottom: 2rem; display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 1rem; }
    .arcade-link { display: inline-flex; align-items: center; gap: 6px; font-size: 0.85rem; color: #38bdf8; text-decoration: none; padding: 6px 12px; background: #0c4a6e44; border: 1px solid #0284c744; border-radius: 8px; font-weight: 600; }
    .grid { display: grid; gap: 1.5rem; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
    .card { background: var(--card); padding: 1.5rem; border-radius: 12px; border: 1px solid #1e293b; display: flex; flex-direction: column; justify-content: space-between; }
    .badge { display: inline-block; background: rgba(168, 85, 247, 0.15); color: var(--accent); padding: 0.25rem 0.6rem; border-radius: 6px; font-weight: 700; font-size: 0.8rem; margin-bottom: 0.75rem; }
    .actions { display: flex; gap: 0.75rem; margin-top: 1.25rem; }
    .btn { text-decoration: none; padding: 0.6rem 1rem; border-radius: 8px; font-weight: 600; font-size: 0.85rem; text-align: center; flex: 1; }
    .btn.primary { background: var(--accent); color: #ffffff; }
    .btn.secondary { background: #1e293b; color: var(--text); }
    details { margin-top: 3rem; background: var(--card); border: 1px solid #1e293b; border-radius: 12px; padding: 1.25rem; }
    summary { cursor: pointer; font-weight: 700; color: #94a3b8; font-size: 0.95rem; }
    .archive-list { margin-top: 1rem; display: flex; flex-direction: column; gap: 0.75rem; }
    .archive-item { display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0; border-bottom: 1px solid #1e293b; font-size: 0.85rem; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1 style="margin:0; color: var(--accent);">VANCE // AUTONOMOUS LAB</h1>
        <p style="margin:0.25rem 0 0; color:#94a3b8;">Zero-Cloud Client Tools, Calculators & Privacy Utilities Synthesized by AI</p>
      </div>
      <div>
        <a href="../index.html" class="arcade-link">&larr; Return to Creative Arcade</a>
      </div>
    </header>

    <div class="grid">
      ${showcase.map(renderCard).join('\n') || '<p style="color:#64748b;">The Lab is formulating its first batch of utilities...</p>'}
    </div>

    ${archived.length > 0 ? `
    <details>
      <summary>View Lab Archives (${archived.length} earlier utilities)</summary>
      <div class="archive-list">
        ${archived.map(a => `
          <div class="archive-item">
            <div>
              <strong>${a.name}</strong> &mdash; <span style="color:#64748b;">${a.tagline}</span>
            </div>
            <div>
              <a href="${a.web_url}" style="color:var(--accent); text-decoration:none; margin-right:12px;">Launch</a>
              <a href="${a.checkout_url}" style="color:#38bdf8; text-decoration:none;">Buy ($${(a.price_cents / 100).toFixed(0)})</a>
            </div>
          </div>
        `).join('')}
      </div>
    </details>
    ` : ''}

    <footer style="margin-top:3rem; font-size:0.8rem; color:#64748b; text-align:center;">
      Autonomous Node Vance &middot; Self-synthesizing and self-packaging
    </footer>
  </div>
</body>
</html>`;

  fs.writeFileSync('./lab/index.html', html, 'utf8');
}

async function run() {
  await syncStripeTelemetry();

  // 1. Process manually staged creations (Store A)
  for (const item of state.catalog_manifest) {
    if (fs.existsSync(item.source_file)) {
      console.log(`[VANCE] Detected staged artifact: ${item.source_file}`);
      const rawHtml = fs.readFileSync(item.source_file, 'utf8');
      const targetRedirectUrl = `${state.agent_identity.storefront_url}products/${item.slug}/?pro=unlocked`;
      const stripeData = await getOrCreateStripeLink(item, targetRedirectUrl);
      const packagedHtml = packageHtml(rawHtml, item, stripeData.checkout_url, '../../index.html', 'The Arcade');

      const targetDir = path.join(state.pipeline_policy.products_dir, item.slug);
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, 'index.html'), packagedHtml, 'utf8');

      const assetRecord = {
        slug: item.slug,
        type: item.type,
        name: item.name,
        tagline: item.tagline,
        price_cents: item.price_cents,
        web_url: `./products/${item.slug}/`,
        checkout_url: stripeData.checkout_url,
        stripe_product_id: stripeData.product_id,
        deployed_at: new Date().toISOString()
      };

      const existingIdx = state.deployed_assets.findIndex(a => a && a.slug === item.slug);
      if (existingIdx >= 0) {
        state.deployed_assets[existingIdx] = assetRecord;
      } else {
        state.deployed_assets.push(assetRecord);
      }
      item.status = 'deployed';
    }
  }

  // 2. Run autonomous thinking, synthesis & dispatch loop (Store B)
  await thinkAndSynthesizeNextTool();

  // 3. Assemble both storefronts
  rebuildStoreA();
  rebuildStoreB();

  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  console.log('[VANCE] Full cycle complete.');
}

run().catch(err => {
  console.error('[VANCE] Fatal error:', err);
  process.exit(1);
});
