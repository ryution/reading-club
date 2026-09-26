'use strict';

const path = require('node:path');
const { loadEnvFile } = require('node:process');

function loadLocalEnv() {
  try { loadEnvFile(path.join(__dirname, '.env')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function validateConfig({ siteUrl, capacity, production }) {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new Error('ENROLLMENT_CAPACITY must be a positive whole number.');
  }
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

function missingDetails(details) {
  const missing = ['startDate', 'lectureSchedule', 'smallGroupSchedule', 'location', 'refundPolicy']
    .filter((key) => typeof details[key] !== 'string' || !details[key].trim());
  if (typeof details.contactEmail !== 'string' || !/^[^\s@<>"&]+@[^\s@<>"&]+\.[^\s@<>"&]+$/.test(details.contactEmail)) {
    missing.push('contactEmail');
  }
  return missing;
}

module.exports = { loadLocalEnv, validateConfig, missingDetails };
