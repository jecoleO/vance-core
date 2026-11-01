import fs from 'fs';
import path from 'path';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const STATE_PATH = './vance.state.json';
const TEMPLATE_PATH = './templates/dossier-shell.html';

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
// 1. STRIPE HELPERS & TELEMETRY
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

// ---------------------------------------------------------------------
// 2. GEMINI CASCADE INFERENCE
// ---------------------------------------------------------------------
async function callGemini(prompt, isJson = false, timeoutMs = 60000) {
  const modelCascade = [
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-3.8-flash'
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

  throw new Error('All model tiers in the cascade (3.5 Lite -> 3.1 Lite -> 3.8 Flash) were exhausted.');
}

// ---------------------------------------------------------------------
// 3. DAILY LEVEL PROGRESSION ROUTER & DOSSIER SYNTHESIS (STORE B)
// ---------------------------------------------------------------------
function getDailyJlptSpec() {
  const now = new Date();
  const jstDate = new Date(now.getTime() + (9 * 60 * 60 * 1000));
  const jstDay = jstDate.getUTCDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat

  const levelConfigs = {
    1: {
      level: "N5",
      dayName: "Monday",
      titleSuffix: "Elementary Foundations",
      paragraphs: 2,
      charCap: 200,
      grammarGuide: "Strict JLPT N5 grammar: です/ます forms, core particles (は, が, を, に, で, と, も), basic adjective predicates, simple non-past/past."
    },
    2: {
      level: "N4",
      dayName: "Tuesday",
      titleSuffix: "Early Intermediate Clauses",
      paragraphs: 2,
      charCap: 260,
      grammarGuide: "JLPT N4 grammar: 〜たり〜たり, 〜ている, 〜てから, 〜たら/〜ば, 〜ので/から, basic potential and passive forms."
    },
    3: {
      level: "N3",
      dayName: "Wednesday",
      titleSuffix: "Intermediate Bridge",
      paragraphs: 3,
      charCap: 340,
      grammarGuide: "JLPT N3 grammar: 〜に対して, 〜によって, 〜に関する, 〜わけではない, compound verbs, authentic written だ/である register."
    },
    4: {
      level: "N2",
      dayName: "Thursday",
      titleSuffix: "Advanced Press Register",
      paragraphs: 3,
      charCap: 380,
      grammarGuide: "JLPT N2 newspaper register: 〜をはじめとする, 〜にともなって, 〜をめぐって, 〜ざるを得ない, high-density kanji compounds."
    },
    5: {
      level: "N1",
      dayName: "Friday",
      titleSuffix: "Mastery Editorial Register",
      paragraphs: 3,
      charCap: 420,
      grammarGuide: "JLPT N1 editorial register: 〜を余儀なくされる, 〜ならではの, 〜極まりない, formal discourse particles and nuanced critique."
    }
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
    console.log('[VANCE-AI] No GEMINI_API_KEY detected. Skipping Store B synthesis.');
    return;
  }

  if (!fs.existsSync(TEMPLATE_PATH)) {
    console.warn(`[VANCE-AI] Master template ${TEMPLATE_PATH} missing. Skipping Store B synthesis.`);
    return;
  }

  const spec = getDailyJlptSpec();
  console.log(`[VANCE-AI] Target schedule: ${spec.level} (${spec.dayName} Commute Edition)`);

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
    "raw_text": "Paragraph 1 in natural Japanese.\n\nParagraph 2...",
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
      type: 'news_dossier',
      name: `World News Japanese: ${dossierData.article.title_en} (${spec.level})`,
      tagline: `${spec.dayName} Commute Edition &bull; 25-Word Match, 5 Grammar Cloze & Reading Check.`,
      price_cents: 500
    };

    const targetRedirectUrl = `${state.agent_identity.storefront_url}products/${slug}/?unlocked=true`;
    const stripeData = await getOrCreateStripeLink(itemSpec, targetRedirectUrl);

    const templateHtml = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    let compiledHtml = templateHtml
      .replace('__DOSSIER_DATA__', JSON.stringify(dossierData))
      .replace('World News Japanese Dossier', `${dossierData.article.title_en} (${spec.level})`);

    // Attach Vance Store B header and live checkout URL
    compiledHtml = compiledHtml.replace(
      'href="#" target="_blank" style="background:#0284c7;',
      `href="${stripeData.checkout_url}" target="_blank" style="background:#0284c7;`
    );

    const targetDir = path.join(state.pipeline_policy.products_dir, slug);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'index.html'), compiledHtml, 'utf8');

    const webUrl = `${state.agent_identity.storefront_url}products/${slug}/`;
    state.autonomous_lab_assets.push({
      slug: slug,
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

    state.execution_log.unshift(`${new Date().toISOString().slice(0, 10)}: Vance Lab deployed ${itemSpec.name}`);
    console.log(`[VANCE-AI] Deployed ${itemSpec.name} to Vance Lab.`);

    await generateMarketingDispatch(itemSpec, webUrl, stripeData.checkout_url, dossierData, spec);
  } catch (err) {
    console.warn('[VANCE-AI] Dossier synthesis failed:', err.message);
  }
}

// ---------------------------------------------------------------------
// 4. MARKETING DISPATCH GENERATION
// ---------------------------------------------------------------------
async function generateMarketingDispatch(toolSpec, webUrl, checkoutUrl, dossierData = null, spec = null) {
  if (!GEMINI_API_KEY) return;
  console.log(`[VANCE-MARKETING] Generating launch dispatch for ${toolSpec.name}...`);

  const dispatchDir = './marketing/dispatches';
  fs.mkdirSync(dispatchDir, { recursive: true });
  const filename = `${new Date().toISOString().slice(0, 10)}-${toolSpec.slug}.md`;

  if (dossierData && spec) {
    const markdownContent = `# Daily Japanese News Dossier: ${dossierData.article.title_en} (${spec.level})

**Level:** ${spec.level} (${spec.dayName} Commute Edition)  
**Topic:** ${dossierData.meta.category}  
**Source Citation:** [${dossierData.meta.source_title}](${dossierData.meta.source_url})  
**Format:** 2-Paragraph Japanese Text • 25 Vocab Match • 5 Grammar Cloze • 5 Comprehension Questions

---

### Headline
**${dossierData.article.title_jp}**  
*${dossierData.article.title_en}*

### Reading Summary (English Translation)
> ${dossierData.article.translation_en.replace(/\n/g, '\n> ')}

---

### Key Grammar Points Covered
${dossierData.grammar_5.map((g, i) => `${i + 1}. **${g.pattern}** (${g.formation}) — *${g.meaning}*`).join('\n')}

---

### Interactive Web App Links
- **Launch Interactive App:** ${webUrl}
- **Unlock Standalone Offline Edition ($5):** ${checkoutUrl}
- **Vance Autonomous Lab:** https://jecoleo.github.io/vance-core/lab/index.html
`;

    fs.writeFileSync(path.join(dispatchDir, filename), markdownContent, 'utf8');
    console.log(`[VANCE-MARKETING] Saved launch dispatch to ${dispatchDir}/${filename}`);
    return;
  }

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
      fs.writeFileSync(path.join(dispatchDir, filename), content, 'utf8');
      console.log(`[VANCE-MARKETING] Saved launch dispatch to ${dispatchDir}/${filename}`);
    }
  } catch (err) {
    console.warn('[VANCE-MARKETING] Dispatch generation failed:', err.message);
  }
}

// ---------------------------------------------------------------------
// 5. STORE A & STORE B REBUILDERS
// ---------------------------------------------------------------------
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
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
          <div class="badge">$${(a.price_cents / 100).toFixed(2)} USD</div>
          ${a.level ? `<span style="font-size:0.75rem; font-weight:700; color:#38bdf8; background:#0369a133; padding:2px 8px; border-radius:9999px; border:1px solid #38bdf844;">${a.level}</span>` : ''}
        </div>
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
  <title>Vance Autonomous Lab // Zero-Cloud Utilities & Dossiers</title>
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
        <p style="margin:0.25rem 0 0; color:#94a3b8;">Daily JLPT News Dossiers & Zero-Cloud Offline Utilities</p>
      </div>
      <div>
        <a href="../index.html" class="arcade-link">&larr; Return to Creative Arcade</a>
      </div>
    </header>

    <div class="grid">
      ${showcase.map(renderCard).join('\n') || '<p style="color:#64748b;">The Lab is formulating its daily dossier...</p>'}
    </div>

    ${archived.length > 0 ? `
    <details>
      <summary>View Lab Archives (${archived.length} earlier editions)</summary>
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
      Autonomous Node Vance &middot; Self-synthesizing daily news dossiers & utilities
    </footer>
  </div>
</body>
</html>`;

  fs.writeFileSync('./lab/index.html', html, 'utf8');
}

// ---------------------------------------------------------------------
// 6. MAIN ENGINE RUNNER
// ---------------------------------------------------------------------
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

  // 2. Synthesize & Deploy Today's Japanese News Dossier (Store B)
  await synthesizeDailyDossier();

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
