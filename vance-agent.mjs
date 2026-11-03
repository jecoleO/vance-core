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

// Commercial Configuration: Universal $1.00 min / $2.00 preset floor
const UNIVERSAL_MIN_CENTS = 100;
const UNIVERSAL_PRESET_CENTS = 200;
const NEWS_FREE_WINDOW = 7;
const DEFAULT_FREE_WINDOW = 5;

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

// ---------------------------------------------------------------------
// 1. STRIPE API HELPERS & TELEMETRY (PWYW: $1.00 Min / $2.00 Preset)
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

async function getOrCreateStripeLink(item, targetRedirectUrl) {
  console.log(`[VANCE] Checking Stripe asset: ${item.name} (Universal PWYW: $1.00 min / $2.00 preset)`);

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
    // Find an existing custom_unit_amount PWYW price
    price = Array.isArray(existingPrices.data) ? existingPrices.data.find(pr => pr.custom_unit_amount?.enabled) : null;
  } catch (e) {}

  if (!price) {
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

function packageHtml(rawHtml, item, checkoutUrl, hubUrl = '../index.html', hubName = 'The Pod') {
  const isArcade = item.pod === 'arcade' || item.type === 'arcade_cartridge';
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
      Own Offline File ($1+ PWYW)
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
        console.warn(`[VANCE-AI] ${model} capacity/rate limit hit (HTTP ${res.status}). Cascading to backup...`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      if (!res.ok) {
        console.warn(`[VANCE-AI] ${model} returned HTTP ${res.status}: ${raw.slice(0, 120)}. Cascading...`);
        continue;
      }

      const data = JSON.parse(raw);
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
      if (!text) {
        console.warn(`[VANCE-AI] ${model} returned empty candidate text. Cascading...`);
        continue;
      }

      return text;
    } catch (err) {
      clearTimeout(timer);
      const isAbort = err.name === 'AbortError' || controller.signal.aborted;
      const reason = isAbort ? `timeout after ${Math.round(timeoutMs / 1000)}s` : err.message;
      console.warn(`[VANCE-AI] ${model} failed (${reason}). Cascading to next tier...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  throw new Error('All model tiers in the cascade (3.8 Flash -> 3.5 Lite -> 3.1 Lite) were exhausted.');
}

// ---------------------------------------------------------------------
// 3. DAILY COMMUTE DOSSIER SYNTHESIS (JAPANESE TODAY POD)
// ---------------------------------------------------------------------
function getDailyJlptSpec() {
  const now = new Date();
  const jstDate = new Date(now.getTime() + (9 * 60 * 60 * 1000));
  const jstDay = jstDate.getUTCDay();

  const levelConfigs = {
    1: { level: "N5", dayName: "Monday", titleSuffix: "Elementary Foundations", paragraphs: 2, charCap: 200, grammarGuide: "Strict JLPT N5 grammar: です/ます forms, core particles (は, が, を, に, で, と, も), basic adjective predicates, simple non-past/past." },
    2: { level: "N4", dayName: "Tuesday", titleSuffix: "Early Intermediate Clauses", paragraphs: 2, charCap: 260, grammarGuide: "JLPT N4 grammar: 〜たり〜たり, 〜ている, 〜てから, 〜たら/〜ば, 〜ので/から, basic potential and passive forms." },
    3: { level: "N3", dayName: "Wednesday", titleSuffix: "Intermediate Bridge", paragraphs: 3, charCap: 340, grammarGuide: "JLPT N3 grammar: 〜に対して, 〜によって, 〜に関する, 〜わけではない, compound verbs, authentic written だ/である register." },
    4: { level: "N2", dayName: "Thursday", titleSuffix: "Advanced Press Register", paragraphs: 3, charCap: 380, grammarGuide: "JLPT N2 newspaper register: 〜をはじめとする, 〜にともなって, 〜をめぐって, 〜ざるを得ない, high-density kanji compounds." },
    5: { level: "N1", dayName: "Friday", titleSuffix: "Mastery Editorial Register", paragraphs: 3, charCap: 420, grammarGuide: "JLPT N1 editorial register: 〜を余儀なくされる, 〜ならではの, 〜極まりない, formal discourse particles and nuanced critique." }
  };

  return levelConfigs[jstDay] || {
    level: "N3",
    dayName: "Weekend Edition",
    titleSuffix: "Consolidated Weekend Review",
    paragraphs: 3,
    charCap: 340,
    grammarGuide: "Balanced JLPT N3 intermediate news register with practical compound patterns."
  };
}

async function synthesizeDailyDossier() {
  if (!GEMINI_API_KEY) {
    console.log('[VANCE-AI] No GEMINI_API_KEY detected. Skipping Japanese Today synthesis.');
    return;
  }

  const dossierTemplatePath = path.join(TEMPLATES_DIR, 'dossier-shell.html');
  if (!fs.existsSync(dossierTemplatePath)) {
    console.warn(`[VANCE-AI] Master template ${dossierTemplatePath} missing. Skipping synthesis.`);
    return;
  }

  const spec = getDailyJlptSpec();
  console.log(`[VANCE-AI] Synthesizing Japanese Today: ${spec.level} (${spec.dayName} Commute Edition)`);

  const previousDossiers = (state.autonomous_lab_assets || []).map(a => a.name).join(', ');

  const prompt = `
You are a bilingual senior Japanese news editor and curriculum designer writing for English-speaking adults learning Japanese.

TASK:
Write an authentic, engaging, real-world Japanese news story and its comprehensive study dossier.

TOPIC ROTATION:
Pick a real, timely, or evergreen news story from one of these broad categories:
- Technology & Innovation (AI, robotics, space, gadgets, clean energy)
- Business & Market Trends (startups, retail shifts, remote work, consumer trends)
- Food & Culinary Culture (regional cuisine, agricultural breakthroughs, culinary arts)
- Travel, Regional Japan & Nature (bullet train routes, historic towns, national parks)
- Sports & Athletics (baseball, sumo, marathons, international athletics)
- Arts, Pop Culture & Entertainment (cinema, animation, gaming milestones, architecture)
(Avoid recently covered topics if possible: ${previousDossiers || 'None yet'}).

PEDAGOGICAL CONTRACT FOR ${spec.level}:
1. GRAMMAR AS THE LEVEL CEILING:
   - Grammatical complexity must adhere strictly to ${spec.level} conventions.
   - Grammatical Scope: ${spec.grammarGuide}
2. NATURAL ADULT VOCABULARY:
   - Do NOT infantilize the language or write unnatural children's sentences.
   - Use standard Japanese kanji (e.g., write 清掃ロボット not 清潔なロボット; write 旅行客 or 観光地, not unnatural literal translations).
   - All kanji MUST have accurate <ruby> annotations in "furi_html".
3. CONCISE COMMUTE LENGTH:
   - EXACTLY ${spec.paragraphs} concise paragraphs.
   - Total character count must NOT exceed ${spec.charCap} characters.
4. ACCURATE VOCABULARY CATEGORIES:
   - Categorize the 25 vocabulary items accurately based on their actual nature (e.g., "Technology", "Food", "Action", "Travel", "Descriptor", "Business"), NOT one repeated category.
5. GRAMMAR INTEGRATION:
   - The 5 grammar patterns must appear naturally in the article.
   - The example sentence for each grammar pattern must use ONLY words from the 25 vocabulary words.
6. CLOZE EXERCISES & COMPREHENSION:
   - 10 cloze exercises with 4 plausible options each, testing authentic particles, forms, or connectors.
   - 5 reading comprehension questions with 4 distinct choices, strictly answerable from the text.

OUTPUT FORMAT (STRICT JSON ONLY):
{
  "edition_slug": "news-${spec.level.toLowerCase()}-[kebab-topic-slug]",
  "meta": {
    "level": "${spec.level}",
    "category": "Selected Category (e.g. Travel & Regional Culture / Food Trends / Sports)",
    "source_title": "Real News Outlet or Organization Citation (e.g. NHK World, Kyodo News, Mainichi, Japan Times)",
    "source_url": "https://...",
    "target_level": "${spec.level}"
  },
  "article": {
    "title_jp": "Natural Japanese Headline using standard adult kanji",
    "title_en": "Natural English Headline",
    "raw_text": "Paragraph 1 in natural Japanese.\\n\\nParagraph 2...",
    "furi_html": "<p><ruby>新幹線<rt>しんかんせん</rt></ruby>の...</p><p>...</p>",
    "translation_en": "Natural, idiomatic English translation."
  },
  "vocabulary_25": [
    {
      "id": "v1",
      "category": "Travel",
      "word": "新幹線",
      "kana": "しんかんせん",
      "en": "bullet train",
      "type": "Noun"
    }
  ],
  "grammar_5": [
    {
      "id": "g1",
      "pattern": "〜で行く（手段・交通）",
      "formation": "Transportation/Tool + で + 行く / 来る",
      "meaning": "to go by [means of transport]",
      "nuance": "Particle で marks the instrument or method of travel.",
      "sentence_jp": "新幹線で新しい町へ行きます。",
      "sentence_furi": "<ruby>新幹線<rt>しんかんせん</rt></ruby>で<ruby>新<rt>あたら</rt></ruby>しい<ruby>町<rt>まち</rt></ruby>へ<ruby>行<rt>い</rt></ruby>きます。",
      "sentence_en": "I go to the new town by bullet train.",
      "breakdown": "新幹線 (Transport) で + 新しい町へ (Destination) + 行きます (Verb)"
    }
  ],
  "grammar_quiz_10": [
    {
      "id": 1,
      "prompt": "東京から京都まで新幹線 [ ? ] 行きました。",
      "translation": "I went from Tokyo to Kyoto by bullet train.",
      "options": ["で", "に", "を", "へ"],
      "correct": "で",
      "explanation": "で indicates the method of transportation used for moving."
    }
  ],
  "comprehension_quiz_5": [
    {
      "id": "rc1",
      "question_jp": "記事によると、旅行客は何を利用して町を訪れていますか？",
      "question_en": "According to the article, what are travelers using to visit the town?",
      "options": [
        "新しく開通した新幹線",
        "海岸沿いを走る自転車",
        "国際線の大型飛行機",
        "川を下る観光用の船"
      ],
      "correct": 0,
      "explanation": "本文の第1段落に新幹線の利用について書かれています。"
    }
  ]
}
`;

  try {
    const rawJson = await callGemini(prompt, true, 45000);
    const dossierData = JSON.parse(rawJson);

    if (!dossierData || !dossierData.edition_slug) {
      console.warn('[VANCE-AI] Invalid dossier payload returned.');
      return;
    }

    const slug = dossierData.edition_slug;
    if (state.autonomous_lab_assets.some(a => a.slug === slug)) {
      console.log(`[VANCE-AI] Dossier edition ${slug} is already deployed.`);
      return;
    }

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

    const templateHtml = fs.readFileSync(dossierTemplatePath, 'utf8');
    let compiledHtml = templateHtml
      .replace('__DOSSIER_DATA__', JSON.stringify(dossierData))
      .replace('World News Japanese Dossier', `${dossierData.article.title_en} (${spec.level})`);

    compiledHtml = compiledHtml.replace(
      'href="#" target="_blank" style="background:#0284c7;',
      `href="${stripeData.checkout_url}" target="_blank" style="background:#0284c7;`
    );

    const targetDir = path.join(PRODUCTS_DIR, slug);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'index.html'), compiledHtml, 'utf8');

    const webUrl = `../products/${slug}/`;
    state.autonomous_lab_assets.unshift({
      slug: slug,
      pod: 'news',
      type: 'news_dossier',
      level: spec.level,
      name: itemSpec.name,
      tagline: itemSpec.tagline,
      price_cents: itemSpec.price_cents,
      revenue_cents: 0,
      web_url: webUrl,
      checkout_url: stripeData.checkout_url,
      stripe_product_id: stripeData.product_id,
      invented_at: new Date().toISOString()
    });

    state.execution_log.unshift(`${new Date().toISOString().slice(0, 10)}: Deployed ${itemSpec.name}`);
    console.log(`[VANCE-AI] Deployed ${itemSpec.name} to products/${slug}/`);

    await generateMarketingDispatch(itemSpec, `https://jecoleo.github.io/vance-core/products/${slug}/`, stripeData.checkout_url, dossierData, spec);
  } catch (err) {
    console.warn('[VANCE-AI] Dossier synthesis failed:', err.message);
  }
}

// ---------------------------------------------------------------------
// 4. CLEANUP & DELETE (SITE + STRIPE ARCHIVE)
// ---------------------------------------------------------------------
async function deleteAsset(targetSlug) {
  if (!targetSlug) {
    console.warn('[VANCE-CLEANUP] No target_slug provided for deletion.');
    return;
  }

  console.log(`[VANCE-CLEANUP] Initiating deletion & archival of asset: ${targetSlug}`);

  // 1. Remove physical folder in /products/
  const productDir = path.join(PRODUCTS_DIR, targetSlug);
  if (fs.existsSync(productDir)) {
    fs.rmSync(productDir, { recursive: true, force: true });
    console.log(`[VANCE-CLEANUP] Deleted directory: ${productDir}`);
  }

  // 2. Remove marketing dispatch if it exists
  const files = fs.existsSync(DISPATCH_DIR) ? fs.readdirSync(DISPATCH_DIR) : [];
  for (const f of files) {
    if (f.includes(targetSlug)) {
      const p = path.join(DISPATCH_DIR, f);
      fs.unlinkSync(p);
      console.log(`[VANCE-CLEANUP] Deleted dispatch file: ${p}`);
    }
  }

  // 3. Find asset and archive on Stripe
  const allAssets = [...state.autonomous_lab_assets, ...state.deployed_assets];
  const targetAsset = allAssets.find(a => a.slug === targetSlug);
  if (targetAsset && targetAsset.stripe_product_id) {
    try {
      console.log(`[VANCE-CLEANUP] Archiving Stripe product: ${targetAsset.stripe_product_id}`);
      await stripeRequest(`products/${targetAsset.stripe_product_id}`, 'POST', { active: 'false' });
      console.log(`[VANCE-CLEANUP] Stripe product archived successfully.`);
    } catch (err) {
      console.warn(`[VANCE-CLEANUP] Stripe archival warning:`, err.message);
    }
  }

  // 4. Remove from state arrays
  state.autonomous_lab_assets = state.autonomous_lab_assets.filter(a => a.slug !== targetSlug);
  state.deployed_assets = state.deployed_assets.filter(a => a.slug !== targetSlug);
  state.execution_log.unshift(`${new Date().toISOString().slice(0, 10)}: Removed & archived asset ${targetSlug}`);
}

// ---------------------------------------------------------------------
// 5. MARKETING DISPATCH
// ---------------------------------------------------------------------
async function generateMarketingDispatch(toolSpec, webUrl, checkoutUrl, dossierData = null, spec = null) {
  if (!GEMINI_API_KEY) return;
  fs.mkdirSync(DISPATCH_DIR, { recursive: true });
  const filename = `${new Date().toISOString().slice(0, 10)}-${toolSpec.slug}.md`;

  if (dossierData && spec) {
    const markdownContent = `# Daily Japanese News Dossier: ${dossierData.article.title_en} (${spec.level})

**Level:** ${spec.level} (${spec.dayName} Commute Edition)  
**Topic:** ${dossierData.meta.category}  
**Source Citation:** [${dossierData.meta.source_title}](${dossierData.meta.source_url})  

### Headline
**${dossierData.article.title_jp}**  
*${dossierData.article.title_en}*

### Reading Summary (English Translation)
> ${dossierData.article.translation_en.replace(/\\n/g, '\\n> ')}

### Links
- **Interactive Web Edition (Free for 7 Days):** ${webUrl}
- **Standalone Offline Workstation ($1+ PWYW):** ${checkoutUrl}
`;
    fs.writeFileSync(path.join(DISPATCH_DIR, filename), markdownContent, 'utf8');
    console.log(`[VANCE-MARKETING] Dispatch saved: ${filename}`);
  }
}

// ---------------------------------------------------------------------
// 6. FEDERATED STOREFRONTS BUILDER (ROLLING FREEMIUM VAULT)
// ---------------------------------------------------------------------
function renderCard(a, isVaulted = false) {
  const isArcade = a.pod === 'arcade' || a.type === 'arcade_cartridge';

  if (!isVaulted) {
    // ACTIVE FREE CARD
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
        <a href="${a.checkout_url}" target="_blank" class="btn btn-buy" style="text-decoration:none; padding:0.5rem; border-radius:6px; font-size:0.8rem; font-weight:700; text-align:center; flex:1; background:#38bdf8; color:#081726;">Own File ($1+)</a>
      </div>
    </div>`;
  } else {
    // VAULT ARCHIVE CARD (Older than free window - locked)
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
        <a href="${a.checkout_url}" target="_blank" class="btn btn-buy" style="display:block; text-decoration:none; padding:0.5rem; border-radius:6px; font-size:0.8rem; font-weight:700; text-align:center; background:#f59e0b; color:#081726;">Unlock Archive ($1+)</a>
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
  console.log('[VANCE] Assembling Federated Storefronts with Rolling Freemium Vault...');
  const allAssets = [...state.deployed_assets, ...state.autonomous_lab_assets];

  // 1. Filter Pod Assets
  const arcadeItems = allAssets.filter(a => a.pod === 'arcade' || a.type === 'arcade_cartridge');
  const tacticalItems = allAssets.filter(a => a.pod === 'tactical' || a.slug === 'jlpt-mastery-console');
  const utilityItems = allAssets.filter(a => (a.pod === 'utility' || a.type === 'autonomous_utility' || a.type === 'utility') && a.slug !== 'jlpt-mastery-console');
  const newsItems = allAssets.filter(a => a.pod === 'news' || a.type === 'news_dossier');

  // Helper to compile a pod with the rolling freemium vault limit
  const compilePod = (shellName, outputDir, items, windowLimit) => {
    const templatePath = path.join(TEMPLATES_DIR, shellName);
    if (!fs.existsSync(templatePath)) return;
    let html = fs.readFileSync(templatePath, 'utf8');
    
    const cards = items.map((item, index) => {
      const isVaulted = index >= windowLimit;
      return renderCard(item, isVaulted);
    }).join('\n') || '<p style="color:#64748b; font-size:0.85rem;">No items staged in this pod yet.</p>';

    html = html.replace(
      /<!-- \[POD-ROSTER-START\] -->[\s\S]*?<!-- \[POD-ROSTER-END\] -->/,
      `<!-- [POD-ROSTER-START] -->\n<div class="grid">\n${cards}\n</div>\n<!-- [POD-ROSTER-END] -->`
    );
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'index.html'), html, 'utf8');
  };

  // Compile the 4 Pod sub-sites with respective free windows
  compilePod('arcade-shell.html', './arcade', arcadeItems, DEFAULT_FREE_WINDOW);
  compilePod('tactical-shell.html', './tactical', tacticalItems, DEFAULT_FREE_WINDOW);
  compilePod('utility-shell.html', './utility', utilityItems, DEFAULT_FREE_WINDOW);
  compilePod('news-shell.html', './news', newsItems, NEWS_FREE_WINDOW);

  // 2. Compile Master Umbrella Portal (Root index.html)
  const hubTemplatePath = path.join(TEMPLATES_DIR, 'hub-shell.html');
  if (fs.existsSync(hubTemplatePath)) {
    let hubHtml = fs.readFileSync(hubTemplatePath, 'utf8');
    hubHtml = hubHtml
      .replace('__COUNT_ARCADE__', arcadeItems.length)
      .replace('__COUNT_TACTICAL__', tacticalItems.length)
      .replace('__COUNT_UTILITY__', utilityItems.length)
      .replace('__COUNT_NEWS__', newsItems.length);
    fs.writeFileSync('./index.html', hubHtml, 'utf8');
    console.log('[VANCE] Master Portal (index.html) successfully recompiled.');
  }

  // 3. Generate Public RSS wire
  generateRssFeed(allAssets);
}

// ---------------------------------------------------------------------
// 7. INGEST STAGED ARTIFACTS
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
      console.log(`[VANCE] Ingesting staged artifact from ${sourceFile}...`);

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
        // Prepend so newest is at the top of the pod
        state.deployed_assets.unshift(assetRecord);
      }
      manifestEntry.status = 'deployed';
      console.log(`[VANCE] Deployed ${slug} to pod: ${mapping.pod}`);
    }
  }
}

// ---------------------------------------------------------------------
// 8. MAIN ENGINE RUNNER
// ---------------------------------------------------------------------
async function run() {
  await syncStripeTelemetry();

  if (ACTION === 'delete') {
    await deleteAsset(TARGET_SLUG);
  } else {
    // 1. Ingest staged artifacts across pods
    await ingestStagedArtifacts();

    // 2. Synthesize today's Japanese Today Commute Dossier
    await synthesizeDailyDossier();
  }

  // 3. Assemble all storefronts with rolling freemium vault and RSS feed
  rebuildAllStorefronts();

  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  console.log('[VANCE] Full cycle complete.');
}

run().catch(err => {
  console.error('[VANCE] Fatal error:', err);
  process.exit(1);
});
