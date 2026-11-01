import fs from 'fs';
import path from 'path';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const STATE_PATH = './vance.state.json';

if (!GEMINI_API_KEY || !STRIPE_SECRET_KEY) {
  console.error('Missing GEMINI_API_KEY or STRIPE_SECRET_KEY in environment.');
  process.exit(1);
}

const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));

// Helper: Encode form data for Stripe REST API (Zero npm dependencies)
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
  const options = { method, headers };
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
  console.log('Syncing Stripe telemetry...');
  try {
    const balance = await stripeRequest('balance');
    const available = balance.available?.reduce((acc, b) => acc + b.amount, 0) || 0;
    const pending = balance.pending?.reduce((acc, b) => acc + b.amount, 0) || 0;

    // Calculate charges in the last 30 days
    const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
    const charges = await stripeRequest(`charges?created[gte]=${thirtyDaysAgo}&limit=100`);
    const monthlyGrossCents = charges.data
      ?.filter(c => c.paid && !c.refunded)
      .reduce((acc, c) => acc + c.amount, 0) || 0;

    state.financial_telemetry.stripe_available_balance = +(available / 100).toFixed(2);
    state.financial_telemetry.stripe_pending_balance = +(pending / 100).toFixed(2);
    state.financial_telemetry.monthly_revenue_current = +(monthlyGrossCents / 100).toFixed(2);
    state.financial_telemetry.last_synced = new Date().toISOString();
    console.log(`Monthly Revenue: $${state.financial_telemetry.monthly_revenue_current}`);
  } catch (err) {
    console.warn('Telemetry warning:', err.message);
  }
}

async function createStripeProductAndLink(item) {
  console.log(`Setting up Stripe product & payment link for: ${item.name}`);

  // Check if product already exists from a previous partial run to avoid duplicates
  let product = null;
  try {
    const existing = await stripeRequest('products?active=true&limit=50');
    product = existing.data?.find(p => p.name === item.name) || null;
    if (product) {
      console.log(`Found existing Stripe product (${product.id}), reusing...`);
    }
  } catch (e) {
    // Fallback to creating new product
  }

  if (!product) {
    product = await stripeRequest('products', 'POST', {
      name: item.name,
      description: item.tagline
    });
  }

  const price = await stripeRequest('prices', 'POST', {
    product: product.id,
    unit_amount: item.price_cents,
    currency: 'usd'
  });

  const proUnlockUrl = `${state.agent_identity.storefront_url}products/${item.slug}/?pro=unlocked`;
  const paymentLink = await stripeRequest('payment_links', 'POST', {
    line_items: [{ price: price.id, quantity: 1 }],
    after_completion: {
      type: 'redirect',
      redirect: { url: proUnlockUrl }
    }
  });

  return {
    product_id: product.id,
    price_id: price.id,
    checkout_url: paymentLink.url
  };
}

async function generateSingleFileApp(item, checkoutUrl) {
  console.log(`Calling Gemini API (${GEMINI_MODEL}) to engineer: ${item.slug}...`);
  const prompt = `You are VANCE, an elite zero-dependency web application architect.
${item.prompt_spec.replace('{{CHECKOUT_URL}}', checkoutUrl)}

CRITICAL REQUIREMENTS:
1. Return ONLY raw, valid HTML starting with <!DOCTYPE html> and ending with </html>. Do NOT wrap in markdown code fences.
2. Everything (CSS, JavaScript, rich interactive data, localStorage persistence) MUST be inside this single HTML file.
3. If the URL query string contains "?pro=unlocked", automatically unlock Pro Mode in localStorage, hide the upgrade banner, display a "PRO EDITION UNLOCKED" badge, and enable a "Download Offline Copy (.html)" button that triggers a file download of the page itself.
4. Include a prominent, high-converting upgrade button linking directly to: ${checkoutUrl}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4 }
      })
    }
  );

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Gemini API Error: ${JSON.stringify(data)}`);
  }

  let html = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  html = html.replace(/^```html\s*/i, '').replace(/```\s*$/i, '').trim();
  return html;
}

function rebuildStorefrontHub() {
  console.log('Rebuilding Vance-Core Storefront Hub (index.html)...');
  const rev = state.financial_telemetry.monthly_revenue_current;
  const pct1 = Math.min(100, Math.round((rev / 30) * 100));
  const pct2 = Math.min(100, Math.round((rev / 150) * 100));

  const cardsHtml = state.deployed_assets
    .map(
      a => `
      <div class="card">
        <div class="badge">$${(a.price_cents / 100).toFixed(2)} USD</div>
        <h3>${a.name}</h3>
        <p>${a.tagline}</p>
        <div class="actions">
          <a href="${a.web_url}" class="btn secondary">Launch Free Web App</a>
          <a href="${a.checkout_url}" class="btn primary">Buy Pro Offline Edition ($${(a.price_cents / 100).toFixed(0)})</a>
        </div>
      </div>`
    )
    .join('\n');

  const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Vance Forge | Zero-Bloat Offline Web Utilities</title>
  <style>
    :root { --bg: #0b0f19; --card: #131b2e; --text: #e2e8f0; --accent: #38bdf8; --emerald: #10b981; }
    body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 2rem; line-height: 1.6; }
    .container { max-width: 900px; margin: 0 auto; }
    header { border-bottom: 1px solid #1e293b; padding-bottom: 1.5rem; margin-bottom: 2rem; display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 1rem; }
    .telemetry { background: var(--card); padding: 1rem 1.25rem; border-radius: 10px; border: 1px solid #1e293b; min-width: 260px; font-size: 0.85rem; }
    .bar-bg { background: #1e293b; height: 8px; border-radius: 4px; overflow: hidden; margin: 6px 0 12px; }
    .bar-fill { background: var(--emerald); height: 100%; }
    .grid { display: grid; gap: 1.5rem; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
    .card { background: var(--card); padding: 1.5rem; border-radius: 12px; border: 1px solid #1e293b; position: relative; display: flex; flex-direction: column; justify-content: space-between; }
    .badge { display: inline-block; background: rgba(56, 189, 248, 0.15); color: var(--accent); padding: 0.25rem 0.6rem; border-radius: 6px; font-weight: 700; font-size: 0.8rem; width: fit-content; margin-bottom: 0.5rem; }
    .actions { display: flex; gap: 0.75rem; margin-top: 1.25rem; flex-wrap: wrap; }
    .btn { text-decoration: none; padding: 0.6rem 1rem; border-radius: 8px; font-weight: 600; font-size: 0.9rem; text-align: center; flex: 1; }
    .btn.primary { background: var(--accent); color: #0f172a; }
    .btn.secondary { background: #1e293b; color: var(--text); }
    footer { margin-top: 4rem; font-size: 0.8rem; color: #64748b; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1 style="margin:0; color: var(--accent);">VANCE // FORGE</h1>
        <p style="margin:0.25rem 0 0; color:#94a3b8;">Autonomous Single-File Offline Software & Tactical Study Consoles</p>
      </div>
      <div class="telemetry">
        <div><strong>Autonomous Revenue Telemetry</strong></div>
        <div>Milestone 1 ($30/mo Core): <strong>$${rev} / $30</strong> (${pct1}%)</div>
        <div class="bar-bg"><div class="bar-fill" style="width:${pct1}%"></div></div>
        <div>Milestone 2 ($150/mo Ultra): <strong>$${rev} / $150</strong> (${pct2}%)</div>
        <div class="bar-bg"><div class="bar-fill" style="width:${pct2}%"></div></div>
      </div>
    </header>
    <div class="grid">
      ${cardsHtml || '<p>Initializing first autonomous build...</p>'}
    </div>
    <footer>Operated autonomously by Vance-Core &middot; Last Synced: ${state.financial_telemetry.last_synced || 'Pending'}</footer>
  </div>
</body>
</html>`;

  fs.writeFileSync('./index.html', indexHtml, 'utf8');
}

async function run() {
  await syncStripeTelemetry();

  // Find next unbuilt item in backlog
  const deployedSlugs = new Set(state.deployed_assets.map(a => a.slug));
  const nextItem = state.product_backlog.find(item => !deployedSlugs.has(item.slug));

  if (nextItem) {
    const stripeData = await createStripeProductAndLink(nextItem);
    const appHtml = await generateSingleFileApp(nextItem, stripeData.checkout_url);

    const outDir = path.join('./products', nextItem.slug);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'index.html'), appHtml, 'utf8');

    const assetRecord = {
      slug: nextItem.slug,
      name: nextItem.name,
      tagline: nextItem.tagline,
      price_cents: nextItem.price_cents,
      web_url: `./products/${nextItem.slug}/`,
      checkout_url: stripeData.checkout_url,
      stripe_product_id: stripeData.product_id,
      deployed_at: new Date().toISOString()
    };

    state.deployed_assets.push(assetRecord);
    state.execution_log.unshift(
      `${new Date().toISOString().slice(0, 10)}: Built & deployed ${nextItem.name} (${stripeData.checkout_url})`
    );
  } else {
    state.execution_log.unshift(
      `${new Date().toISOString().slice(0, 10)}: Synced Stripe telemetry. All current backlog items deployed.`
    );
  }

  rebuildStorefrontHub();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  console.log('Vance cycle complete.');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
