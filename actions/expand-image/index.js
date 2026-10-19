/*
* Image Extension — step 2: start Firefly Generative Expand for ONE plan.
*
* Request (JSON):
*   { planId, storagePath, contentType, prompt?,
*     working: { source: {width, height}, size: {width, height}, inset: {top, right, bottom, left} } }
* prompt: optional text the designer typed to guide the generated area.
* (`working` is the plan's Firefly request, computed in the plugin from the
* final InDesign geometry — source + inset add up to size exactly.)
*
* 1. read the uploaded source from App Builder Files
* 2. resize it to working.source (only when the plan was downscaled for
*    Firefly's 2688 px limit) so the inset box IS the source size
* 3. upload to Firefly storage, submit /v3/images/expand-async
* 4. delete the temporary upload
* Response: { planId, jobId, statusUrl, uploadId, fireflyRequest, workingSource }
* (fireflyRequest = the exact expand-async body; no credentials.
*  statusUrl = Firefly's own URL, for logging only — the plugin polls
*  expand-status with the jobId.)
*
* Firefly token: the Stage workspace OAuth S2S credential injected via
* include-ims-credentials, exchanged by Core.AuthClient (see image-extension/auth.js).
*/

const { Core, Files } = require('@adobe/aio-sdk')
const { errorResponse } = require('../utils')
const { checkPluginKey, validateExpandRequest, safeParams } = require('../image-extension/gate')
const { getFireflyAuth } = require('../image-extension/auth')
const { createFireflyClient, JOB_ID } = require('../image-extension/firefly')

// Resizes image bytes to exactly width x height (the plan keeps the aspect;
// floor rounding differs by < 1 px). Pure JS (jimp) — no native modules.
async function resizeWithJimp (bytes, contentType, width, height) {
  const Jimp = require('jimp')
  const img = await Jimp.read(Buffer.from(bytes))
  if (img.bitmap.width === width && img.bitmap.height === height) return { bytes: Buffer.from(bytes), contentType }
  img.resize(width, height, Jimp.RESIZE_BICUBIC)
  const outType = contentType === 'image/png' ? Jimp.MIME_PNG : Jimp.MIME_JPEG
  if (outType === Jimp.MIME_JPEG) img.quality(92)
  return { bytes: await img.getBufferAsync(outType), contentType: outType }
}

async function main (params, deps) {
  const logger = Core.Logger('expand-image', { level: params.LOG_LEVEL || 'info' })
  logger.debug(safeParams(params))

  const gate = checkPluginKey(params)
  if (gate) return errorResponse(401, gate, logger)
  const invalid = validateExpandRequest(params)
  if (invalid) return errorResponse(400, invalid, logger)

  const d = deps || {}
  let files = d.files
  try {
    let firefly = d.firefly
    if (!firefly) {
      const auth = getFireflyAuth(params)
      firefly = createFireflyClient({ fetch, getAccessToken: auth.getAccessToken, clientId: auth.clientId })
    }
    if (!files) files = await Files.init()

    const original = await files.read(params.storagePath)
    if (!original || !original.length) return errorResponse(400, 'uploaded source not found or empty', logger)

    const w = params.working
    const sized = await (d.resize || resizeWithJimp)(original, params.contentType, w.source.width, w.source.height)
    const uploadId = await firefly.uploadImage(sized.bytes, sized.contentType)
    const prompt = typeof params.prompt === 'string' ? params.prompt.trim() : ''
    const job = await firefly.submitExpand({ uploadId, size: w.size, inset: w.inset, prompt })
    // Logged so the job can be recovered from Runtime logs if the client loses it.
    logger.info(`expand job submitted for ${params.planId}: jobId=${job.jobId} statusUrl=${job.statusUrl}`)
    if (!JOB_ID.test(String(job.jobId))) logger.warn(`jobId ${job.jobId} doesn't match the expected Firefly format — expand-status will reject it`)
    return {
      statusCode: 200,
      body: {
        planId: params.planId,
        jobId: job.jobId,
        statusUrl: job.statusUrl,
        uploadId,
        fireflyRequest: job.requestBody || null,
        workingSource: { width: w.source.width, height: w.source.height, contentType: sized.contentType }
      }
    }
  } catch (error) {
    logger.error(error && error.message ? error.message : String(error))
    return errorResponse(502, error && error.message ? error.message : 'expand failed', logger)
  } finally {
    // The temporary upload is only needed until Firefly has its own copy.
    try { if (files) await files.delete(params.storagePath) } catch (e) { /* best effort */ }
  }
}

exports.main = main
exports.resizeWithJimp = resizeWithJimp
