import fs from 'fs';
import path from 'path';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STATE_PATH = './vance.state.json';

if (!STRIPE_SECRET_KEY) {
  console.error('[VANCE] Missing STRIPE_SECRET_KEY in environment.');
  process.exit(1);
}

const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));

// Defensive initialization
if (!Array.isArray(state.deployed_assets)) {
  state.deployed_assets = [];
}
if (!Array.isArray(state.catalog_manifest)) {
  state.catalog_manifest = [];
}
if (!Array.isArray(state.execution_log)) {
  state.execution_log = [];
}

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

async function getOrCreateStripeLink(item) {
  console.log(`[VANCE] Provisioning/checking Stripe asset for: ${item.name} ($${(item.price_cents / 100).toFixed(2)})`);

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

  const unlockParam = item.type === 'arcade_cartridge' ? 'cartridge=unlocked' : 'pro=unlocked';
  const targetRedirectUrl = `${state.agent_identity.storefront_url}products/${item.slug}/?${unlockParam}`;

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

  return {
    product_id: product.id,
    price_id: price.id,
    checkout_url: paymentLink.url
  };
}

async function getOrCreateVaultPass() {
  const vaultItem = {
    name: 'Vance Arcade: Lifetime Access & Download Pass',
    tagline: 'Permanent offline cartridge downloads and unlimited browser access to all creative experiments.',
    price_cents: state.pipeline_policy.arcade_vault_price_cents
  };

  let product = null;
  try {
    const existing = await stripeRequest('products?active=true&limit=50');
    product = Array.isArray(existing.data) ? existing.data.find(p => p.name === vaultItem.name) : null;
  } catch (e) {}

  if (!product) {
    product = await stripeRequest('products', 'POST', {
      name: vaultItem.name,
      description: vaultItem.tagline
    });
  }

  let price = null;
  try {
    const existingPrices = await stripeRequest(`prices?product=${product.id}&active=true&limit=10`);
    price = Array.isArray(existingPrices.data) ? existingPrices.data.find(pr => pr.unit_amount === vaultItem.price_cents) : null;
  } catch (e) {}

  if (!price) {
    price = await stripeRequest('prices', 'POST', {
      product: product.id,
      unit_amount: vaultItem.price_cents,
      currency: 'usd'
    });
  }

  const vaultUnlockUrl = `${state.agent_identity.storefront_url}?vault=unlocked`;
  try {
    const existingLinks = await stripeRequest('payment_links?active=true&limit=50');
    const match = Array.isArray(existingLinks.data)
      ? existingLinks.data.find(pl => pl.after_completion?.redirect?.url === vaultUnlockUrl)
      : null;
    if (match) return match.url;
  } catch (e) {}

  const paymentLink = await stripeRequest('payment_links', 'POST', {
    line_items: [{ price: price.id, quantity: 1 }],
    after_completion: {
      type: 'redirect',
      redirect: { url: vaultUnlockUrl }
    }
  });

  return paymentLink.url;
}

function packageHtml(rawHtml, item, checkoutUrl, vaultUrl) {
  const isArcade = item.type === 'arcade_cartridge';
  const unlockKey = `vance_unlocked_${item.slug}`;

  const injectedSnippet = `
<!-- [VANCE-MERCHANT-HARNESS: START] -->
<div id="vance-header" style="background:#090d16;color:#e2e8f0;padding:10px 18px;font-family:system-ui,-apple-system,sans-serif;font-size:13px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #1e293b;position:sticky;top:0;z-index:999999;">
  <div style="display:flex;align-items:center;gap:14px;">
    <a href="../../index.html" style="color:#38bdf8;text-decoration:none;font-weight:700;">&larr; Vance // Forge</a>
    <span style="color:#64748b;">|</span>
    <span style="font-weight:600;">${item.name}</span>
  </div>
  <div style="display:flex;align-items:center;gap:10px;">
    <span id="vance-pro-badge" style="display:none;background:#10b98122;color:#10b981;padding:3px 8px;border-radius:4px;font-size:11px;font-weight:700;border:1px solid #10b98144;">OFFLINE EDITION UNLOCKED</span>
    <button id="vance-dl-btn" style="display:none;background:#10b981;color:#041f14;border:none;padding:5px 12px;border-radius:6px;font-weight:700;cursor:pointer;font-size:12px;">Download Offline .html</button>
    <a id="vance-buy-btn" href="${checkoutUrl}" target="_blank" style="background:#38bdf8;color:#081726;padding:5px 12px;border-radius:6px;font-weight:700;text-decoration:none;font-size:12px;">
      ${isArcade ? `Buy Standalone Cartridge ($${(item.price_cents / 100).toFixed(0)})` : `Unlock Pro Edition ($${(item.price_cents / 100).toFixed(0)})`}
    </a>
    ${isArcade ? `<a href="${vaultUrl}" target="_blank" style="background:#1e293b;color:#94a3b8;padding:5px 10px;border-radius:6px;text-decoration:none;font-size:11px;">Lifetime Pass ($20)</a>` : ''}
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

function rebuildStorefrontHub(vaultUrl) {
  console.log('[VANCE] Assembling Storefront Hub (index.html)...');
  const rev = state.financial_telemetry.monthly_revenue_current || 0;
  const pct1 = Math.min(100, Math.round((rev / 30) * 100));
  const pct2 = Math.min(100, Math.round((rev / 150) * 100));

  const utilities = (state.deployed_assets || []).filter(a => a && a.type === 'utility');
  const arcade = (state.deployed_assets || []).filter(a => a && a.type === 'arcade_cartridge');

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

  const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Vance // Forge & Arcade</title>
  <style>
    :root { --bg: #0b0f19; --card: #131b2e; --text: #e2e8f0; --accent: #38bdf8; --emerald: #10b981; }
    body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 2rem; line-height: 1.6; }
    .container { max-width: 940px; margin: 0 auto; }
    header { border-bottom: 1px solid #1e293b; padding-bottom: 1.5rem; margin-bottom: 2.5rem; display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 1.5rem; }
    .telemetry { background: var(--card); padding: 1rem 1.25rem; border-radius: 10px; border: 1px solid #1e293b; min-width: 270px; font-size: 0.85rem; }
    .bar-bg { background: #1e293b; height: 8px; border-radius: 4px; overflow: hidden; margin: 6px 0 12px; }
    .bar-fill { background: var(--emerald); height: 100%; }
    .vault-banner { background: linear-gradient(135deg, #1e1b4b, #172554); border: 1px solid #3b82f644; border-radius: 12px; padding: 1.5rem; margin-bottom: 2.5rem; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem; }
    .section-title { font-size: 1.25rem; margin: 2rem 0 1rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700; border-bottom: 1px solid #1e293b; padding-bottom: 0.5rem; }
    .grid { display: grid; gap: 1.5rem; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
    .card { background: var(--card); padding: 1.5rem; border-radius: 12px; border: 1px solid #1e293b; display: flex; flex-direction: column; justify-content: space-between; }
    .badge { display: inline-block; background: rgba(56, 189, 248, 0.15); color: var(--accent); padding: 0.25rem 0.6rem; border-radius: 6px; font-weight: 700; font-size: 0.8rem; margin-bottom: 0.75rem; }
    .actions { display: flex; gap: 0.75rem; margin-top: 1.25rem; flex-wrap: wrap; }
    .btn { text-decoration: none; padding: 0.6rem 1rem; border-radius: 8px; font-weight: 600; font-size: 0.85rem; text-align: center; flex: 1; }
    .btn.primary { background: var(--accent); color: #081726; }
    .btn.secondary { background: #1e293b; color: var(--text); }
    .btn.vault { background: #3b82f6; color: #ffffff; padding: 0.75rem 1.5rem; }
    footer { margin-top: 4rem; font-size: 0.8rem; color: #64748b; text-align: center; border-top: 1px solid #1e293b; padding-top: 2rem; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1 style="margin:0; color: var(--accent); letter-spacing:-0.02em;">VANCE // FORGE</h1>
        <p style="margin:0.25rem 0 0; color:#94a3b8;">Autonomous Zero-Bloat Utilities & Indie Creative Experiments</p>
      </div>
      <div class="telemetry">
        <div><strong>Stripe Telemetry (Last 30 Days)</strong></div>
        <div>Milestone 1 ($30/mo Core): <strong>$${rev} / $30</strong> (${pct1}%)</div>
        <div class="bar-bg"><div class="bar-fill" style="width:${pct1}%"></div></div>
        <div>Milestone 2 ($150/mo Ultra): <strong>$${rev} / $150</strong> (${pct2}%)</div>
        <div class="bar-bg"><div class="bar-fill" style="width:${pct2}%"></div></div>
      </div>
    </header>

    <div class="vault-banner">
      <div>
        <h3 style="margin:0 0 0.25rem; color:#60a5fa;">The Experimental Arcade Vault</h3>
        <p style="margin:0; font-size:0.9rem; color:#cbd5e1;">Get instant lifetime access and offline standalone <code>.html</code> downloads for every game cartridge.</p>
      </div>
      <a href="${vaultUrl}" target="_blank" class="btn vault">Unlock Lifetime Vault ($20)</a>
    </div>

    <div class="section-title">Tactical Study Consoles & Tools</div>
    <div class="grid">
      ${utilities.map(renderCard).join('\n') || '<p style="color:#64748b;">No utilities in staging yet. Drop index.html files into /staging to publish.</p>'}
    </div>

    <div class="section-title">Indie Retro Arcade Experiments</div>
    <div class="grid">
      ${arcade.map(renderCard).join('\n') || '<p style="color:#64748b;">No arcade cartridges in staging yet. Drop game index.html files into /staging to publish.</p>'}
    </div>

    <footer>Operated autonomously by Vance-Core &middot; Last Synced: ${state.financial_telemetry.last_synced}</footer>
  </div>
</body>
</html>`;

  fs.writeFileSync('./index.html', indexHtml, 'utf8');
}

async function run() {
  await syncStripeTelemetry();
  const vaultUrl = await getOrCreateVaultPass();

  for (const item of state.catalog_manifest) {
    if (fs.existsSync(item.source_file)) {
      console.log(`[VANCE] Detected staged artifact: ${item.source_file}`);
      const rawHtml = fs.readFileSync(item.source_file, 'utf8');
      const stripeData = await getOrCreateStripeLink(item);
      const packagedHtml = packageHtml(rawHtml, item, stripeData.checkout_url, vaultUrl);

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

      if (!Array.isArray(state.deployed_assets)) {
        state.deployed_assets = [];
      }

      const existingIdx = state.deployed_assets.findIndex(a => a && a.slug === item.slug);
      if (existingIdx >= 0) {
        state.deployed_assets[existingIdx] = assetRecord;
      } else {
        state.deployed_assets.push(assetRecord);
      }

      item.status = 'deployed';
      state.execution_log.unshift(`${new Date().toISOString().slice(0, 10)}: Deployed ${item.name} ($${(item.price_cents / 100).toFixed(2)})`);
    }
  }

  rebuildStorefrontHub(vaultUrl);
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  console.log('[VANCE] Cycle complete.');
}

run().catch(err => {
  console.error('[VANCE] Fatal error:', err);
  process.exit(1);
});
