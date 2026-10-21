/*
* Center Subject — step 2: start a subject mask job for ONE photo.
*
* Request (JSON): { storagePath, contentType }   (from subject-upload-url)
*
* 1. read the uploaded photo from App Builder Files
* 2. shrink it to at most 2048 px on the longest side (the plugin only needs
*    the subject's box as a share of the photo, so the result is the same)
* 3. upload to Firefly storage, POST image.adobe.io/v2/remove-background (mode "mask")
* 4. delete the temporary upload
* Response: { jobId, statusUrl, sentSize: { width, height } }
*
* Token: the workspace OAuth S2S credential injected by include-ims-credentials
* (same as Image Extension). Nothing secret is returned.
*/

const { Core, Files } = require('@adobe/aio-sdk')
const { errorResponse } = require('../utils')
const { checkPluginKey, safeParams } = require('../image-extension/gate')
const { getFireflyAuth } = require('../image-extension/auth')
const { createFireflyClient } = require('../image-extension/firefly')
const { createPhotoshopClient, shrinkWithJimp, validateUpload, JOB_ID } = require('../subject/photoshop')

async function main (params, deps) {
  const logger = Core.Logger('subject-mask', { level: params.LOG_LEVEL || 'info' })
  logger.debug(safeParams(params))

  const gate = checkPluginKey(params)
  if (gate) return errorResponse(401, gate, logger)
  const invalid = validateUpload(params)
  if (invalid) return errorResponse(400, invalid, logger)

  const d = deps || {}
  let files = d.files
  try {
    let storage = d.storage
    let photoshop = d.photoshop
    if (!storage || !photoshop) {
      const auth = getFireflyAuth(params)
      const client = { fetch, getAccessToken: auth.getAccessToken, clientId: auth.clientId }
      if (!storage) storage = createFireflyClient(client)
      if (!photoshop) photoshop = createPhotoshopClient(client)
    }
    if (!files) files = await Files.init()

    const original = await files.read(params.storagePath)
    if (!original || !original.length) return errorResponse(400, 'uploaded photo not found or empty', logger)

    const small = await (d.shrink || shrinkWithJimp)(original, params.contentType)
    const uploadId = await storage.uploadImage(small.bytes, small.contentType)
    const job = await photoshop.submitMask(uploadId)
    logger.info(`subject mask job submitted: jobId=${job.jobId} statusUrl=${job.statusUrl}`)
    if (!JOB_ID.test(String(job.jobId))) logger.warn(`jobId ${job.jobId} doesn't match the expected format — subject-status will reject it`)
    return {
      statusCode: 200,
      body: { jobId: job.jobId, statusUrl: job.statusUrl, sentSize: { width: small.width || null, height: small.height || null } }
    }
  } catch (error) {
    logger.error(error && error.message ? error.message : String(error))
    return errorResponse(502, error && error.message ? error.message : 'subject mask failed', logger)
  } finally {
    // The temporary upload is only needed until Adobe has its own copy.
    try { if (files) await files.delete(params.storagePath) } catch (e) { /* best effort */ }
  }
}

exports.main = main
