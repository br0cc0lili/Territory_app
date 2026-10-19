/*
* Image Extension — request gate + request validation shared by the
* image-extension actions.
*
* STAGE PROTOTYPE ONLY: these actions use require-adobe-auth: false (the
* InDesign UXP plugin has no Adobe user token to send) and instead check
* x-plugin-key. The plugin key lives in the plugin's client-side config —
* it is a lightweight request gate, NOT a secret and NOT production
* authentication. Before Production: per-user Adobe IMS auth
* (require-adobe-auth: true) + rate limiting.
*/

const crypto = require('crypto')

const PLAN_ID = /^EXT_[0-9a-f]{8}$/
const UPLOAD_PREFIX = 'image-extension/uploads/'
const CONTENT_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
const MAX_SIDE = 2688
const MAX_PROMPT = 1024 // Firefly ExpandImageRequest.prompt maxLength

/** "" if x-plugin-key matches PLUGIN_SHARED_KEY (constant-time), else a reason. */
function checkPluginKey (params) {
  const expected = String(params.PLUGIN_SHARED_KEY || '')
  const given = String((params.__ow_headers || {})['x-plugin-key'] || '')
  if (!expected) return 'action is missing PLUGIN_SHARED_KEY'
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return 'invalid plugin key'
  return ''
}

const isInt = (n) => Number.isInteger(n) && n >= 0

/** Validates the plan's working request sent by the plugin. "" or a reason. */
function validateExpandRequest (p) {
  if (!PLAN_ID.test(String(p.planId || ''))) return 'invalid planId'
  if (!String(p.storagePath || '').startsWith(UPLOAD_PREFIX) || /\.\./.test(p.storagePath)) return 'invalid storagePath'
  if (!CONTENT_TYPES[p.contentType]) return 'unsupported contentType'
  if (p.prompt !== undefined && p.prompt !== null && (typeof p.prompt !== 'string' || p.prompt.length > MAX_PROMPT)) {
    return `prompt must be text of at most ${MAX_PROMPT} characters`
  }
  const w = p.working || {}
  const src = w.source || {}; const size = w.size || {}; const inset = w.inset || {}
  if (![src.width, src.height, size.width, size.height].every((n) => isInt(n) && n > 0)) return 'invalid working sizes'
  if (!['top', 'right', 'bottom', 'left'].every((k) => isInt(inset[k]))) return 'invalid inset'
  if (size.width > MAX_SIDE || size.height > MAX_SIDE) return `size exceeds ${MAX_SIDE} px`
  if (src.width + inset.left + inset.right !== size.width || src.height + inset.top + inset.bottom !== size.height) {
    return "source + inset doesn't match the requested size"
  }
  return ''
}

/** Params safe to debug-log: no plugin key, no injected credential. */
function safeParams (params) {
  const copy = { ...params }
  delete copy.PLUGIN_SHARED_KEY
  delete copy.__ims_oauth_s2s
  if (copy.__ow_headers) copy.__ow_headers = { ...copy.__ow_headers, 'x-plugin-key': '<hidden>', authorization: '<hidden>' }
  return JSON.stringify(copy)
}

module.exports = { checkPluginKey, validateExpandRequest, safeParams, PLAN_ID, UPLOAD_PREFIX, CONTENT_TYPES, MAX_SIDE, MAX_PROMPT }
