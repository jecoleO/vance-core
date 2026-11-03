import fs from 'fs';
import path from 'path';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ACTION = process.env.ACTION || 'generate';
const TARGET_SLUG = (process.env.TARGET_SLUG || '').trim();

const STATE_PATH = './vance.state.json';
const TEMPLATES_DIR = './templates';
const PRODUCTS_DIR = './products';
const DISPATCH_DIR = './marketing/dispatches';
const RSS_PATH = './feed.xml';

// Commercial Rules
const UNIVERSAL_MIN_CENTS = 100;    // $1.00 USD minimum floor
const UNIVERSAL_PRESET_CENTS = 200; // $2.00 USD suggested preset
const LIFETIME_PASS_CENTS = 3000;   // $30.00 USD one-time lifetime pass
const NEWS_FREE_WINDOW = 7;         // Top 7 news editions free in-browser
const DEFAULT_FREE_WINDOW = 5;      // Top 5 arcade/utility items free in-browser

if (!STRIPE_SECRET_KEY) {
  console.error('[VANCE] Missing STRIPE_SECRET_KEY in environment.');
  process.exit(1);
}

const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));

state.deployed_assets = Array.isArray(state.deployed_assets) ? state.deployed_assets : [];
state.catalog_manifest = Array.isArray(state.catalog_manifest) ? state.catalog_manifest : [];
state.autonomous_lab_assets = Array.isArray(state.autonomous_lab_assets) ? state.autonomous_lab_assets : [];
state.execution_log = Array.isArray(state.execution_log) ? state.execution_log : [];
state.financial_telemetry = state.financial_telemetry || {};
state.agent_identity = state.agent_identity || { storefront_url: 'https://jecoleo.github.io/vance-core/' };

// ---------------------------------------------------------------------
// 1. STRIPE API HELPERS & TELEMETRY
// ---------------------------------------------------------------------
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

// AUTONOMOUS $30 LIFETIME SUPPORTER PASS PROVISIONER
async function ensureLifetimeStripeLink() {
  if (state.financial_telemetry?.lifetime_pass_url && !state.financial_telemetry.lifetime_pass_url.includes('placeholder')) {
    return state.financial_telemetry.lifetime_pass_url;
  }

  console.log('[VANCE] Autonomously provisioning $30 Lifetime Supporter Pass on Stripe...');
  const prodName = 'The Creativity Experiment: All-Access Lifetime Pass';
  let product = null;

  try {
    const existing = await stripeRequest('products?active=true&limit=50');
    product = Array.isArray(existing.data) ? existing.data.find(p => p.name === prodName) : null;
  } catch (e) {}

  if (!product) {
    product = await stripeRequest('products', 'POST', {
      name: prodName,
      description: 'Permanent all-access lifetime pass to all retro arcade cartridges, daily Japanese news dossiers, and offline local-first utilities across the entire studio.'
    });
  }

  let price = null;
  try {
    const existingPrices = await stripeRequest(`prices?product=${product.id}&active=true&limit=10`);
    price = Array.isArray(existingPrices.data) ? existingPrices.data.find(pr => pr.unit_amount === LIFETIME_PASS_CENTS) : null;
  } catch (e) {}

  if (!price) {
    price = await stripeRequest('prices', 'POST', {
      product: product.id,
      unit_amount: LIFETIME_PASS_CENTS,
      currency: 'usd'
    });
  }

  const targetRedirectUrl = `${state.agent_identity.storefront_url}?lifetime=unlocked`;

  let paymentLink = null;
  try {
    const existingLinks = await stripeRequest('payment_links?active=true&limit=50');
    paymentLink = Array.isArray(existingLinks.data)
      ? existingLinks.data.find(pl => pl.line_items?.data?.[0]?.price?.id === price.id || pl.after_completion?.redirect?.url === targetRedirectUrl)
      : null;
  } catch (e) {}

  if (!paymentLink) {
    paymentLink = await stripeRequest('payment_links', 'POST', {
      line_items: [{ price: price.id, quantity: 1 }],
      after_completion: {
        type: 'redirect',
        redirect: { url: targetRedirectUrl }
      }
    });
  }

  state.financial_telemetry.lifetime_pass_url = paymentLink.url;
  state.financial_telemetry.lifetime_price_id = price.id;
  state.financial_telemetry.lifetime_product_id = product.id;
  console.log(`[VANCE] Live Autonomous Lifetime Pass Link: ${paymentLink.url}`);
  return paymentLink.url;
}

// UNIVERSAL PWYW LINK PROVISIONER ($1.00 min / $2.00 preset)
async function getOrCreateStripeLink(item, targetRedirectUrl) {
  console.log(`[VANCE] Provisioning Stripe asset: ${item.name} (Universal PWYW: $1.00 min / $2.00 preset)`);

  let product = null;
  try {
    const existing = await stripeRequest('products?active=true&limit=50');
    product = Array.isArray(existing.data) ? existing.data.find(p => p.name === item.name) : null;
  } catch (e) {}

  if (!product) {
    product = await stripeRequest('products', 'POST', {
      name: item.name,
      description: item.tagline || 'The Creativity Experiment Standalone Application'
    });
  }

  // Find or create PWYW price (ignores legacy fixed prices)
  let price = null;
  try {
    const existingPrices = await stripeRequest(`prices?product=${product.id}&active=true&limit=20`);
    price = Array.isArray(existingPrices.data)
      ? existingPrices.data.find(pr => pr.custom_unit_amount?.enabled === true && pr.custom_unit_amount?.minimum === UNIVERSAL_MIN_CENTS)
      : null;
  } catch (e) {}

  if (!price) {
    console.log(`[VANCE] Creating fresh PWYW price for ${item.name}...`);
    price = await stripeRequest('prices', 'POST', {
      product: product.id,
      currency: 'usd',
      custom_unit_amount: {
        enabled: true,
        minimum: UNIVERSAL_MIN_CENTS,
        preset: UNIVERSAL_PRESET_CENTS
      }
    });
  }

  // Reuse only if link belongs to THIS specific PWYW price
  try {
    const existingLinks = await stripeRequest('payment_links?active=true&limit=50');
    const match = Array.isArray(existingLinks.data)
      ? existingLinks.data.find(pl =>
          pl.after_completion?.redirect?.url === targetRedirectUrl &&
          pl.line_items?.data?.[0]?.price?.id === price.id
        )
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

// IN-APP HEADER WITH UNIFIED LIFETIME PASS + PWYW DOWNLOADING
function packageHtml(rawHtml, item, checkoutUrl, hubUrl = '../index.html', hubName = 'The Pod') {
  const lifetimeUrl = state.financial_telemetry?.lifetime_pass_url || '#';
  const unlockKey = `vance_unlocked_${item.slug}`;

  const injectedSnippet = `
<!-- [VANCE-MERCHANT-HARNESS: START] -->
<div id="vance-header" style="background:#090d16;color:#e2e8f0;padding:10px 18px;font-family:system-ui,-apple-system,sans-serif;font-size:13px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #1e293b;position:sticky;top:0;z-index:999999;">
  <div style="display:flex;align-items:center;gap:14px;">
    <a href="${hubUrl}" style="color:#38bdf8;text-decoration:none;font-weight:700;">&larr; ${hubName}</a>
    <span style="color:#64748b;">|</span>
    <span style="font-weight:600;">${item.name}</span>
    <span style="background:#10b98122;color:#10b981;font-size:11px;font-weight:700;padding:2px 6px;border-radius:4px;border:1px solid #10b98144;">FREE PREVIEW</span>
  </div>
  <div style="display:flex;align-items:center;gap:10px;">
    <span id="vance-pro-badge" style="display:none;background:#10b98122;color:#10b981;padding:3px 8px;border-radius:4px;font-size:11px;font-weight:700;border:1px solid #10b98144;">★ UNLOCKED</span>
    <button id="vance-dl-btn" style="display:none;background:#10b981;color:#041f14;border:none;padding:5px 12px;border-radius:6px;font-weight:800;cursor:pointer;font-size:12px;">Download Offline .html</button>
    <a id="vance-buy-btn" href="${checkoutUrl}" target="_blank" rel="noopener" style="background:#1e293b;color:#f8fafc;padding:5px 12px;border-radius:6px;font-weight:700;text-decoration:none;font-size:12px;border:1px solid #334155;">
      Own File ($1+ PWYW)
    </a>
    <a id="vance-lifetime-btn" href="${lifetimeUrl}" target="_blank" rel="noopener" style="background:#38bdf8;color:#081726;padding:5px 12px;border-radius:6px;font-weight:800;text-decoration:none;font-size:12px;">
      Get Lifetime Pass ($30)
    </a>
  </div>
</div>
<script>
(function() {
  const params = new URLSearchParams(window.location.search);
  const isLifetime = params.get('lifetime') === 'unlocked' || localStorage.getItem('vance_lifetime_pass') === 'true';
  const isItemUnlocked = params.get('unlocked') === 'true' || params.get('pro') === 'unlocked' || localStorage.getItem('${unlockKey}') === 'true';

  if (isLifetime || isItemUnlocked) {
    if (isLifetime) localStorage.setItem('vance_lifetime_pass', 'true');
    if (isItemUnlocked) localStorage.setItem('${unlockKey}', 'true');

    const buyBtn = document.getElementById('vance-buy-btn');
    const lifetimeBtn = document.getElementById('vance-lifetime-btn');
    const badge = document.getElementById('vance-pro-badge');
    const dlBtn = document.getElementById('vance-dl-btn');

    if (buyBtn) buyBtn.style.display = 'none';
    if (lifetimeBtn) lifetimeBtn.style.display = 'none';
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

// ---------------------------------------------------------------------
// 2. GEMINI CASCADE INFERENCE
// ---------------------------------------------------------------------
async function callGemini(prompt, isJson = false, timeoutMs = 60000) {
  const modelCascade = [
    'gemini-3.8-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite'
  ];

  for (let mIdx = 0; mIdx < modelCascade.length; mIdx++) {
    const model = modelCascade[mIdx];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: isJson ? 0.2 : 0.3,
        maxOutputTokens: 6000
      }
    };

    if (isJson) {
      body.generationConfig.response_mime_type = 'application/json';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      console.log(`[VANCE-AI] Querying ${model} (tier ${mIdx + 1}/${modelCascade.length}, timeout: ${Math.round(timeoutMs / 1000)}s)...`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      const raw = await res.text();
      clearTimeout(timer);

      if (res.status === 503 || res.status === 429) {
        console.warn(`[VANCE-AI] ${model} capacity limit hit. Cascading...`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      if (!res.ok) {
        console.warn(`[VANCE-AI] ${model} returned HTTP ${res.status}. Cascading...`);
        continue;
      }

      const data = JSON.parse(raw);
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
      if (!text) continue;

      return text;
    } catch (err) {
      clearTimeout(timer);
      console.warn(`[VANCE-AI] ${model} failed (${err.message}). Cascading...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  throw new Error('All model tiers in the cascade were exhausted.');
}

// ---------------------------------------------------------------------
// 3. DAILY COMMUTE DOSSIER SYNTHESIS (JAPANESE TODAY POD)
// ---------------------------------------------------------------------
function getDailyJlptSpec() {
  const now = new Date();
  const jstDate = new Date(now.getTime() + (9 * 60 * 60 * 1000));
  const jstDay = jstDate.getUTCDay();

  const levelConfigs = {
    1: { level: "N5", dayName: "Monday", paragraphs: 2, charCap: 200, grammarGuide: "Strict JLPT N5 grammar." },
    2: { level: "N4", dayName: "Tuesday", paragraphs: 2, charCap: 260, grammarGuide: "JLPT N4 grammar: 〜たり〜たり, 〜ている, 〜てから, 〜たら/〜ば, 〜ので/から." },
    3: { level: "N3", dayName: "Wednesday", paragraphs: 3, charCap: 340, grammarGuide: "JLPT N3 grammar: 〜に対して, 〜によって, 〜に関する, 〜わけではない." },
    4: { level: "N2", dayName: "Thursday", paragraphs: 3, charCap: 380, grammarGuide: "JLPT N2 newspaper register." },
    5: { level: "N1", dayName: "Friday", paragraphs: 3, charCap: 420, grammarGuide: "JLPT N1 editorial register." }
  };

  return levelConfigs[jstDay] || {
    level: "N3",
    dayName: "Weekend Edition",
    paragraphs: 3,
    charCap: 340,
    grammarGuide: "Balanced JLPT N3 intermediate news register."
  };
}

async function synthesizeDailyDossier() {
  if (!GEMINI_API_KEY) {
    console.log('[VANCE-AI] No GEMINI_API_KEY detected. Skipping Japanese Today synthesis.');
    return;
  }

  const dossierTemplatePath = path.join(TEMPLATES_DIR, 'dossier-shell.html');
  if (!fs.existsSync(dossierTemplatePath)) return;

  const spec = getDailyJlptSpec();
  console.log(`[VANCE-AI] Synthesizing Japanese Today: ${spec.level} (${spec.dayName} Commute Edition)`);

  const prompt = `
You are a senior Japanese news editor and curriculum designer writing for adults learning Japanese.
Generate an authentic news story and study dossier for JLPT Level ${spec.level}.
Output JSON ONLY matching this format:
{
  "edition_slug": "news-${spec.level.toLowerCase()}-[kebab-slug]",
  "meta": { "level": "${spec.level}", "category": "Tech / Culture / Business", "source_title": "NHK / Kyodo", "source_url": "https://..." },
  "article": {
    "title_jp": "Headline in natural Japanese",
    "title_en": "Natural English Headline",
    "raw_text": "Japanese text...",
    "furi_html": "<p><ruby>漢<rt>かん</rt>字<rt>じ</rt></ruby>...</p>",
    "translation_en": "English translation..."
  },
  "vocabulary_25": [ { "id": "v1", "category": "General", "word": "漢字", "kana": "かんじ", "en": "kanji", "type": "Noun" } ],
  "grammar_5": [ { "id": "g1", "pattern": "〜によって", "formation": "Noun + によって", "meaning": "due to / by means of", "nuance": "Formal", "sentence_jp": "...", "sentence_furi": "...", "sentence_en": "...", "breakdown": "..." } ],
  "grammar_quiz_10": [ { "id": 1, "prompt": "Sentence [ ? ]", "translation": "...", "options": ["に", "で", "を", "へ"], "correct": "に", "explanation": "..." } ],
  "comprehension_quiz_5": [ { "id": "rc1", "question_jp": "...", "question_en": "...", "options": ["A", "B", "C", "D"], "correct": 0, "explanation": "..." } ]
}`;

  try {
    const rawJson = await callGemini(prompt, true, 45000);
    const dossierData = JSON.parse(rawJson);

    if (!dossierData || !dossierData.edition_slug) return;
    const slug = dossierData.edition_slug;
    if (state.autonomous_lab_assets.some(a => a.slug === slug)) return;

    const itemSpec = {
      slug: slug,
      pod: 'news',
      type: 'news_dossier',
      name: `World News Japanese: ${dossierData.article.title_en} (${spec.level})`,
      tagline: `${spec.dayName} Commute Edition &bull; 25-Word Match, 5 Grammar Cloze & Reading Check.`,
      price_cents: UNIVERSAL_PRESET_CENTS
    };

    const targetRedirectUrl = `${state.agent_identity.storefront_url}products/${slug}/?unlocked=true`;
    const stripeData = await getOrCreateStripeLink(itemSpec, targetRedirectUrl);

    let templateHtml = fs.readFileSync(dossierTemplatePath, 'utf8');
    let compiledHtml = templateHtml
      .replace('__DOSSIER_DATA__', JSON.stringify(dossierData))
      .replace('World News Japanese Dossier', `${dossierData.article.title_en} (${spec.level})`);

    // Clean any legacy $5 copy from template
    compiledHtml = compiledHtml.replace(/\$5(\.00)?/g, '$1+ PWYW');
    compiledHtml = compiledHtml.replace('href="#"', `href="${stripeData.checkout_url}"`);

    // Package with in-app header harness
    compiledHtml = packageHtml(compiledHtml, itemSpec, stripeData.checkout_url, '../news/index.html', 'Japanese Today');

    const targetDir = path.join(PRODUCTS_DIR, slug);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'index.html'), compiledHtml, 'utf8');

    state.autonomous_lab_assets.unshift({
      slug: slug,
      pod: 'news',
      type: 'news_dossier',
      level: spec.level,
      name: itemSpec.name,
      tagline: itemSpec.tagline,
      price_cents: itemSpec.price_cents,
      revenue_cents: 0,
      web_url: `../products/${slug}/`,
      checkout_url: stripeData.checkout_url,
      stripe_product_id: stripeData.product_id,
      invented_at: new Date().toISOString()
    });

    state.execution_log.unshift(`${new Date().toISOString().slice(0, 10)}: Deployed ${itemSpec.name}`);
    console.log(`[VANCE-AI] Deployed ${itemSpec.name}`);
  } catch (err) {
    console.warn('[VANCE-AI] Dossier synthesis failed:', err.message);
  }
}

// ---------------------------------------------------------------------
// 4. CLEANUP & DELETE
// ---------------------------------------------------------------------
async function deleteAsset(targetSlug) {
  if (!targetSlug) return;
  console.log(`[VANCE-CLEANUP] Archiving asset: ${targetSlug}`);

  const productDir = path.join(PRODUCTS_DIR, targetSlug);
  if (fs.existsSync(productDir)) {
    fs.rmSync(productDir, { recursive: true, force: true });
  }

  const allAssets = [...state.autonomous_lab_assets, ...state.deployed_assets];
  const targetAsset = allAssets.find(a => a.slug === targetSlug);
  if (targetAsset && targetAsset.stripe_product_id) {
    try {
      await stripeRequest(`products/${targetAsset.stripe_product_id}`, 'POST', { active: 'false' });
    } catch (e) {}
  }

  state.autonomous_lab_assets = state.autonomous_lab_assets.filter(a => a.slug !== targetSlug);
  state.deployed_assets = state.deployed_assets.filter(a => a.slug !== targetSlug);
  state.execution_log.unshift(`${new Date().toISOString().slice(0, 10)}: Removed ${targetSlug}`);
}

// ---------------------------------------------------------------------
// 5. FEDERATED STOREFRONTS BUILDER (ROLLING FREEMIUM VAULT + $30 BANNER)
// ---------------------------------------------------------------------
function renderCard(a, isVaulted = false) {
  const isArcade = a.pod === 'arcade' || a.type === 'arcade_cartridge';

  if (!isVaulted) {
    return `
    <div class="card" style="background:#0f172a; border:1px solid #1e293b; border-radius:12px; padding:1.25rem; display:flex; flex-direction:column; justify-content:space-between; gap:1rem;">
      <div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
          <div class="badge" style="background:#10b98122; color:#10b981; font-weight:700; font-size:0.75rem; padding:2px 8px; border-radius:4px; text-transform:uppercase;">Free Web Edition</div>
          ${a.level ? `<span style="font-size:0.75rem; font-weight:700; color:#38bdf8; background:#0369a133; padding:2px 8px; border-radius:9999px;">${a.level}</span>` : ''}
        </div>
        <h3 style="font-size:1.05rem; font-weight:700; margin-bottom:0.35rem; color:#fff;">${a.name}</h3>
        <p style="font-size:0.85rem; color:#94a3b8; line-height:1.4;">${a.tagline || ''}</p>
      </div>
      <div class="actions" style="display:flex; gap:0.5rem; margin-top:1.25rem;">
        <a href="${a.web_url}" class="btn ${isArcade ? 'btn-play' : 'btn-launch'}" style="text-decoration:none; padding:0.5rem; border-radius:6px; font-size:0.8rem; font-weight:700; text-align:center; flex:1; background:#1e293b; color:#fff; border:1px solid #334155;">Launch</a>
        <a href="${a.checkout_url}" target="_blank" rel="noopener" class="btn btn-buy" style="text-decoration:none; padding:0.5rem; border-radius:6px; font-size:0.8rem; font-weight:700; text-align:center; flex:1; background:#38bdf8; color:#081726;">Own File ($1+)</a>
      </div>
    </div>`;
  } else {
    return `
    <div class="card vault-card" style="background:#090d16; border:1px dashed #334155; border-radius:12px; padding:1.25rem; display:flex; flex-direction:column; justify-content:space-between; gap:1rem; opacity:0.65;">
      <div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
          <div class="badge" style="background:#f59e0b22; color:#f59e0b; font-weight:700; font-size:0.75rem; padding:2px 8px; border-radius:4px; text-transform:uppercase;">Vault Archive</div>
          ${a.level ? `<span style="font-size:0.75rem; font-weight:700; color:#64748b; background:#1e293b; padding:2px 8px; border-radius:9999px;">${a.level}</span>` : ''}
        </div>
        <h3 style="font-size:1.05rem; font-weight:700; margin-bottom:0.35rem; color:#cbd5e1;">${a.name}</h3>
        <p style="font-size:0.85rem; color:#64748b; line-height:1.4;">${a.tagline || ''}</p>
      </div>
      <div class="actions" style="margin-top:1.25rem;">
        <a href="${a.checkout_url}" target="_blank" rel="noopener" class="btn btn-buy" style="display:block; text-decoration:none; padding:0.5rem; border-radius:6px; font-size:0.8rem; font-weight:700; text-align:center; background:#f59e0b; color:#081726;">Unlock Archive ($1+)</a>
      </div>
    </div>`;
  }
}

function generateRssFeed(allAssets) {
  try {
    const itemsXml = allAssets.slice(0, 20).map(item => {
      const pubDate = item.deployed_at || item.invented_at ? new Date(item.deployed_at || item.invented_at).toUTCString() : new Date().toUTCString();
      const itemUrl = `https://jecoleo.github.io/vance-core/products/${item.slug}/`;
      return `
      <item>
        <title><![CDATA[${item.name}]]></title>
        <link>${itemUrl}</link>
        <guid isPermaLink="true">${itemUrl}</guid>
        <pubDate>${pubDate}</pubDate>
        <description><![CDATA[${item.tagline || 'Standalone release on The Creativity Experiment'}]]></description>
      </item>`;
    }).join('');

    const rss = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>The Creativity Experiment</title>
  <link>https://jecoleo.github.io/vance-core/</link>
  <description>Autonomous zero-dependency software, retro arcade cartridges, and daily Japanese commute dossiers.</description>
  <language>en-us</language>
  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
  <atom:link href="https://jecoleo.github.io/vance-core/feed.xml" rel="self" type="application/rss+xml" />
  ${itemsXml}
</channel>
</rss>`;
    fs.writeFileSync(RSS_PATH, rss.trim(), 'utf8');
    console.log('[VANCE] Public RSS wire generated: feed.xml');
  } catch (err) {
    console.warn('[VANCE] RSS generation error:', err.message);
  }
}

function rebuildAllStorefronts() {
  console.log('[VANCE] Assembling Storefronts with Unified $30 Lifetime Banner & Rolling Freemium Vault...');
  const allAssets = [...state.deployed_assets, ...state.autonomous_lab_assets];
  const lifetimeUrl = state.financial_telemetry?.lifetime_pass_url || '#';

  // The Unified $30 Lifetime Banner
  const universalBannerHtml = `
  <div class="vance-lifetime-banner" style="background:linear-gradient(135deg,rgba(56,189,248,0.08) 0%,rgba(168,85,247,0.08) 100%);border:1px solid rgba(56,189,248,0.25);border-radius:12px;padding:1.25rem 1.5rem;margin-bottom:2rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:1rem;">
    <div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
        <span style="background:#38bdf822;color:#38bdf8;font-weight:800;font-size:0.7rem;padding:2px 8px;border-radius:4px;text-transform:uppercase;letter-spacing:0.05em;border:1px solid #38bdf844;">All-Access Pass</span>
        <span style="color:#64748b;font-size:0.8rem;">&bull; One purchase, permanent studio ownership</span>
      </div>
      <h3 style="color:#f8fafc;font-size:1.15rem;font-weight:700;margin:0 0 4px 0;">Unlock The Entire Studio for Life</h3>
      <p style="color:#94a3b8;font-size:0.85rem;margin:0;max-width:580px;line-height:1.4;">
        Get instant permanent access to every retro arcade cartridge, daily commuter news archive, and utility tool—including everything added in the future.
      </p>
    </div>
    <div>
      <a href="${lifetimeUrl}" target="_blank" rel="noopener" style="display:inline-block;background:#38bdf8;color:#020617;font-weight:800;padding:0.65rem 1.25rem;border-radius:6px;text-decoration:none;font-size:0.85rem;letter-spacing:0.02em;white-space:nowrap;box-shadow:0 4px 12px rgba(56,189,248,0.2);">
        Get Lifetime Pass &bull; $30
      </a>
    </div>
  </div>`;

  // Filter Pod Assets
  const arcadeItems = allAssets.filter(a => a.pod === 'arcade' || a.type === 'arcade_cartridge');
  const tacticalItems = allAssets.filter(a => a.pod === 'tactical' || a.slug === 'jlpt-mastery-console');
  const utilityItems = allAssets.filter(a => (a.pod === 'utility' || a.type === 'autonomous_utility' || a.type === 'utility') && a.slug !== 'jlpt-mastery-console');
  const newsItems = allAssets.filter(a => a.pod === 'news' || a.type === 'news_dossier');

  // Compile Pod with Banner and Vault Limit
  const compilePod = (shellName, outputDir, items, windowLimit) => {
    const templatePath = path.join(TEMPLATES_DIR, shellName);
    if (!fs.existsSync(templatePath)) return;
    let html = fs.readFileSync(templatePath, 'utf8');

    const cards = items.map((item, index) => {
      const isVaulted = index >= windowLimit;
      return renderCard(item, isVaulted);
    }).join('\n') || '<p style="color:#64748b; font-size:0.85rem;">No items staged in this pod yet.</p>';

    // Inject $30 banner above the roster
    html = html.replace(
      /<!-- \[POD-ROSTER-START\] -->[\s\S]*?<!-- \[POD-ROSTER-END\] -->/,
      `${universalBannerHtml}\n<!-- [POD-ROSTER-START] -->\n<div class="grid">\n${cards}\n</div>\n<!-- [POD-ROSTER-END] -->`
    );

    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'index.html'), html, 'utf8');
  };

  compilePod('arcade-shell.html', './arcade', arcadeItems, DEFAULT_FREE_WINDOW);
  compilePod('tactical-shell.html', './tactical', tacticalItems, DEFAULT_FREE_WINDOW);
  compilePod('utility-shell.html', './utility', utilityItems, DEFAULT_FREE_WINDOW);
  compilePod('news-shell.html', './news', newsItems, NEWS_FREE_WINDOW);

  // Compile Root Umbrella Portal (index.html)
  const hubTemplatePath = path.join(TEMPLATES_DIR, 'hub-shell.html');
  if (fs.existsSync(hubTemplatePath)) {
    let hubHtml = fs.readFileSync(hubTemplatePath, 'utf8');
    hubHtml = hubHtml
      .replace('__COUNT_ARCADE__', arcadeItems.length)
      .replace('__COUNT_TACTICAL__', tacticalItems.length)
      .replace('__COUNT_UTILITY__', utilityItems.length)
      .replace('__COUNT_NEWS__', newsItems.length);

    // Inject $30 banner into hub hero if placeholder exists, or above pods
    if (hubHtml.includes('<!-- [LIFETIME-BANNER] -->')) {
      hubHtml = hubHtml.replace('<!-- [LIFETIME-BANNER] -->', universalBannerHtml);
    } else {
      hubHtml = hubHtml.replace('<main', `${universalBannerHtml}\n<main`);
    }

    fs.writeFileSync('./index.html', hubHtml, 'utf8');
    console.log('[VANCE] Master Portal (index.html) recompiled.');
  }

  // Sanitize existing product files (replace old $3/$5 hardcoded text with new link)
  for (const asset of allAssets) {
    const assetIndex = path.join(PRODUCTS_DIR, asset.slug, 'index.html');
    if (fs.existsSync(assetIndex) && asset.checkout_url) {
      let content = fs.readFileSync(assetIndex, 'utf8');
      content = content.replace(/href="https:\/\/buy\.stripe\.com\/[^"]*"/g, `href="${asset.checkout_url}"`);
      content = content.replace(/\$5(\.00)?/g, '$1+ PWYW');
      content = content.replace(/\$3(\.00)?/g, '$1+ PWYW');
      fs.writeFileSync(assetIndex, content, 'utf8');
    }
  }

  generateRssFeed(allAssets);
}

// ---------------------------------------------------------------------
// 6. INGEST STAGED ARTIFACTS
// ---------------------------------------------------------------------
async function ingestStagedArtifacts() {
  const stagingMappings = [
    { dir: './staging/arcade', pod: 'arcade', hubUrl: '../arcade/index.html', hubName: "JAE & Corvus' Arcade" },
    { dir: './staging/tactical', pod: 'tactical', hubUrl: '../tactical/index.html', hubName: 'Tactical Japanese Mastery' },
    { dir: './staging/utility', pod: 'utility', hubUrl: '../utility/index.html', hubName: 'The Utility Belt' }
  ];

  for (const mapping of stagingMappings) {
    if (!fs.existsSync(mapping.dir)) continue;
    const files = fs.readdirSync(mapping.dir).filter(f => f.endsWith('.html'));

    for (const file of files) {
      const slug = path.basename(file, '.html');
      const sourceFile = path.join(mapping.dir, file);
      console.log(`[VANCE] Ingesting staged artifact: ${sourceFile}...`);

      const manifestEntry = state.catalog_manifest.find(m => m.slug === slug) || {
        slug: slug,
        name: slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
        tagline: 'Handcrafted standalone local-first release.',
        price_cents: UNIVERSAL_PRESET_CENTS
      };

      const rawHtml = fs.readFileSync(sourceFile, 'utf8');
      const targetRedirectUrl = `${state.agent_identity.storefront_url}products/${slug}/?pro=unlocked`;
      const stripeData = await getOrCreateStripeLink(manifestEntry, targetRedirectUrl);
      const packagedHtml = packageHtml(rawHtml, { ...manifestEntry, pod: mapping.pod }, stripeData.checkout_url, mapping.hubUrl, mapping.hubName);

      const targetDir = path.join(PRODUCTS_DIR, slug);
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, 'index.html'), packagedHtml, 'utf8');

      const assetRecord = {
        slug: slug,
        pod: mapping.pod,
        name: manifestEntry.name,
        tagline: manifestEntry.tagline,
        price_cents: manifestEntry.price_cents,
        web_url: `../products/${slug}/`,
        checkout_url: stripeData.checkout_url,
        stripe_product_id: stripeData.product_id,
        deployed_at: new Date().toISOString()
      };

      const existingIdx = state.deployed_assets.findIndex(a => a && a.slug === slug);
      if (existingIdx >= 0) {
        state.deployed_assets[existingIdx] = assetRecord;
      } else {
        state.deployed_assets.unshift(assetRecord);
      }
      manifestEntry.status = 'deployed';
      console.log(`[VANCE] Deployed ${slug} to pod: ${mapping.pod}`);
    }
  }
}

// ---------------------------------------------------------------------
// 7. MAIN ENGINE RUNNER
// ---------------------------------------------------------------------
async function run() {
  await syncStripeTelemetry();

  // Autonomously provision the $30 All-Access Lifetime Supporter Link
  await ensureLifetimeStripeLink();

  if (ACTION === 'delete') {
    await deleteAsset(TARGET_SLUG);
  } else {
    await ingestStagedArtifacts();
    await synthesizeDailyDossier();
  }

  // Rebuild all pod storefronts, root hub, and RSS wire
  rebuildAllStorefronts();

  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  console.log('[VANCE] Full cycle complete.');
}

run().catch(err => {
  console.error('[VANCE] Fatal error:', err);
  process.exit(1);
});
