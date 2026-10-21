/*
* Center Subject — shared helpers for the subject-* actions
* (InDesign plugin -> Photoshop API remove-background, mode "mask").
*
* Owned by the bounding-box feature. It only READS the existing shared
* modules (image-extension/gate.js, auth.js, firefly.js) and never changes
* them:
*   - checkPluginKey / safeParams  -> same x-plugin-key gate as Image Extension
*   - getFireflyAuth               -> same injected OAuth S2S credential
*   - createFireflyClient().uploadImage -> same Firefly storage upload
*
* Photoshop API calls (v2):
*   POST https://image.adobe.io/v2/remove-background   { image: { source: { uploadId } }, mode: "mask" }
*        -> { jobId, statusUrl }
*   GET  <status URL>  -> { status, result: { outputs: [ { destination: { url } } ] } }
* The mask URL is a pre-signed download link (about 1 hour).
*/

const MASK_URL = 'https://image.adobe.io/v2/remove-background'
const UPLOAD_PREFIX = 'subject/uploads/'
const CONTENT_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png' }
// Longest side sent to the API. The box is measured as a share (0..1) of the
// photo, so a smaller copy gives the same box and a faster, safer request.
const MAX_SIDE = 2048
// Same strict job id format as Image Extension ("urn:ff:jobs:<region>:<uuid>").
const JOB_ID = /^urn:ff:jobs:[A-Za-z0-9._:-]{1,200}$/
// Hosts that may serve a job status. A status URL from the client is only
// used when it is on one of these hosts AND ends with the same job id.
const STATUS_HOST = /^(firefly-api|photoshop-api|image|firefly-epo[0-9a-z-]{1,40})\.adobe\.io$/
const CANONICAL_STATUS = [
  (jobId) => `https://firefly-api.adobe.io/v3/status/${jobId}`,
  (jobId) => `https://photoshop-api.adobe.io/v2/status/${jobId}`
]

/** "" if the storage path is one of our temporary uploads, else a reason. */
function validateUpload (p) {
  const path = String(p.storagePath || '')
  if (!path.startsWith(UPLOAD_PREFIX) || /\.\./.test(path) || /[?#\\]/.test(path)) return 'invalid storagePath'
  if (!CONTENT_TYPES[p.contentType]) return 'unsupported contentType (use image/jpeg or image/png)'
  return ''
}

function assertJobId (jobId) {
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) throw new Error('invalid jobId')
}

/** The client's status URL if it is safe to call with our token, else null. */
function trustedStatusUrl (jobId, statusUrl) {
  if (!statusUrl) return null
  let url
  try { url = new URL(String(statusUrl)) } catch (e) { return null }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return null
  if (!STATUS_HOST.test(url.hostname)) return null
  const m = /^\/v[23]\/status\/(.+)$/.exec(url.pathname)
  if (!m) return null
  let tail
  try { tail = decodeURIComponent(m[1]) } catch (e) { return null }
  return tail === jobId ? url.toString() : null
}

/** Status URLs to try, most specific first, no duplicates. */
function statusUrlsFor (jobId, statusUrl) {
  assertJobId(jobId)
  const list = []
  const hint = trustedStatusUrl(jobId, statusUrl)
  if (hint) list.push(hint)
  for (const make of CANONICAL_STATUS) {
    const u = make(jobId)
    if (!list.includes(u)) list.push(u)
  }
  return list
}

function maskUrlOf (json) {
  const outputs = (json.result && json.result.outputs) || json.outputs || []
  const first = outputs[0] || {}
  return (first.destination && first.destination.url) || (first.image && first.image.url) || first.url || ''
}

function failureText (json) {
  const parts = []
  for (const list of [json.errors, json.errorDetails]) {
    if (Array.isArray(list)) for (const e of list) parts.push(e.message || e.errorCode || e.code || 'error')
  }
  if (json.error && typeof json.error === 'object') parts.push(json.error.message || json.error.error_code || 'error')
  if (json.message) parts.push(json.message)
  if (json.error_code) parts.push(json.error_code)
  return parts.join('; ') || 'unknown reason'
}

function createPhotoshopClient ({ fetch, getAccessToken, clientId }) {
  async function headers (extra) {
    return Object.assign({ 'X-Api-Key': clientId, Authorization: `Bearer ${await getAccessToken()}` }, extra || {})
  }

  async function failure (res, what) {
    let detail = ''
    try {
      const j = await res.json()
      detail = j.message || j.error_code || j.title || ''
    } catch (e) { /* no JSON body */ }
    return new Error(`${what} failed (HTTP ${res.status}${detail ? ': ' + detail : ''})`)
  }

  /** Starts a mask job for an uploaded image. Returns { jobId, statusUrl }. */
  async function submitMask (uploadId) {
    const res = await fetch(MASK_URL, {
      method: 'POST',
      headers: await headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ image: { source: { uploadId } }, mode: 'mask', output: { mediaType: 'image/png' } })
    })
    if (!res.ok) throw await failure(res, 'Photoshop remove-background')
    const json = await res.json()
    if (!json.jobId && !json.statusUrl) throw new Error('Photoshop remove-background returned no job')
    let jobId = json.jobId
    if (!jobId && json.statusUrl) {
      const m = /\/status\/([^/?#]+)$/.exec(json.statusUrl)
      jobId = m ? decodeURIComponent(m[1]) : ''
    }
    return { jobId, statusUrl: json.statusUrl || null }
  }

  /**
   * Reads a mask job. Returns
   *   { status: "running"|"succeeded"|"failed"|…, jobId, maskUrl?, error? }
   */
  async function getMaskStatus (jobId, statusUrl) {
    let lastError = null
    for (const url of statusUrlsFor(jobId, statusUrl)) {
      const res = await fetch(url, { method: 'GET', headers: await headers() })
      if (res.status === 404) { lastError = await failure(res, 'Photoshop job status'); continue }
      if (!res.ok) throw await failure(res, 'Photoshop job status')
      const json = await res.json()
      const out = { status: String(json.status || 'unknown').toLowerCase(), jobId }
      if (out.status === 'succeeded') {
        out.maskUrl = maskUrlOf(json) || null
        if (!out.maskUrl) { out.status = 'failed'; out.error = 'succeeded without a mask URL' }
      } else if (out.status === 'failed') {
        out.error = failureText(json)
      }
      return out
    }
    throw lastError || new Error('Photoshop job status: job not found')
  }

  return { submitMask, getMaskStatus }
}

/** Shrinks the photo so its longest side is at most MAX_SIDE (pure JS, jimp). */
async function shrinkWithJimp (bytes, contentType) {
  const Jimp = require('jimp')
  const img = await Jimp.read(Buffer.from(bytes))
  const { width, height } = img.bitmap
  const longest = Math.max(width, height)
  if (longest <= MAX_SIDE) return { bytes: Buffer.from(bytes), contentType, width, height }
  img.scaleToFit(MAX_SIDE, MAX_SIDE, Jimp.RESIZE_BICUBIC)
  const outType = contentType === 'image/png' ? Jimp.MIME_PNG : Jimp.MIME_JPEG
  if (outType === Jimp.MIME_JPEG) img.quality(92)
  return { bytes: await img.getBufferAsync(outType), contentType: outType, width: img.bitmap.width, height: img.bitmap.height }
}

module.exports = {
  createPhotoshopClient,
  shrinkWithJimp,
  validateUpload,
  assertJobId,
  trustedStatusUrl,
  statusUrlsFor,
  maskUrlOf,
  MASK_URL,
  UPLOAD_PREFIX,
  CONTENT_TYPES,
  MAX_SIDE,
  JOB_ID
}
