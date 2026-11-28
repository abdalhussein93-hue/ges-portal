'use strict';
/** Security headers and cross-site request protection. */

// The original apps use inline scripts and onclick="" handlers, so 'unsafe-inline' is required for scripts.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function setSecurityHeaders(res, https) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  // Costing has voice input; Dining Halls scans barcodes with the phone camera (this site only)
  res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(), microphone=(self)');
  res.setHeader('Content-Security-Policy', CSP);
  if (https) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

/**
 * Browsers send an Origin header with every script-made POST/PUT/DELETE.
 * A different origin means another website is trying to act with the user's cookie.
 */
function isCrossSite(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  const host = req.headers.host;
  return origin !== `http://${host}` && origin !== `https://${host}`;
}

module.exports = { setSecurityHeaders, isCrossSite };
