'use strict';

const path = require('node:path');
const { loadEnvFile } = require('node:process');

function loadLocalEnv() {
  try { loadEnvFile(path.join(__dirname, '.env')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function validateConfig({ siteUrl, production }) {
  if (production && !siteUrl) throw new Error('SITE_URL is required in production.');
  if (siteUrl) {
    let url;
    try { url = new URL(siteUrl); } catch { throw new Error('SITE_URL must be a valid public URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.search || url.hash || url.pathname !== '/' || (production && url.protocol !== 'https:')) {
      throw new Error('SITE_URL must be an origin with no path, credentials, query, or fragment; use HTTPS in production.');
    }
    return url.origin;
  }
  return undefined;
}

// "journal=promo_123,222=promo_456" -> { journal: 'promo_123', '222': 'promo_456' }
function parseSourcePromos(v) {
  const out = {};
  for (const pair of String(v || '').split(',')) {
    const [k, id] = pair.split('=').map((x) => (x || '').trim());
    if (k && /^promo_/.test(id)) out[k.toLowerCase()] = id;
  }
  return out;
}

// The public address used in emailed links. SITE_URL wins; on Vercel the
// production domain is used when SITE_URL isn't set. Production never trusts
// a visitor's Host header for payment redirects or emailed sign-in links.
function resolveSiteUrl(env = process.env, log = console) {
  const production = env.NODE_ENV === 'production';
  const candidate = env.SITE_URL || env.RENDER_EXTERNAL_URL || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : '');
  return validateConfig({ siteUrl: candidate, production });
}

module.exports = { loadLocalEnv, validateConfig, resolveSiteUrl, parseSourcePromos };
