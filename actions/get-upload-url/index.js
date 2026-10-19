/*
* Image Extension — step 1: presigned upload URL.
*
* Returns a short-lived presigned WRITE URL in App Builder Files so the
* InDesign plugin uploads the source image DIRECTLY to storage — image bytes
* never pass through a Runtime request (1 MB payload limit).
*
* Request (JSON): { planId: "EXT_xxxxxxxx", contentType: "image/jpeg"|"image/png"|"image/webp" }
* Response:       { uploadUrl, storagePath, expiresInSeconds, uploadHeaders }
* The plugin uploads with HTTP PUT + uploadHeaders (Azure Blob behind
* App Builder Files expects x-ms-blob-type: BlockBlob — verified on the first
* real Stage test).
*
* No IMS credentials needed here (no include-ims-credentials).
*/

const { Core, Files } = require('@adobe/aio-sdk')
const { errorResponse } = require('../utils')
const { checkPluginKey, safeParams, PLAN_ID, UPLOAD_PREFIX, CONTENT_TYPES } = require('../image-extension/gate')

const EXPIRY_SECONDS = 600

async function main (params, deps) {
  const logger = Core.Logger('get-upload-url', { level: params.LOG_LEVEL || 'info' })
  logger.debug(safeParams(params))

  const gate = checkPluginKey(params)
  if (gate) return errorResponse(401, gate, logger)
  if (!PLAN_ID.test(String(params.planId || ''))) return errorResponse(400, 'invalid planId', logger)
  const ext = CONTENT_TYPES[params.contentType]
  if (!ext) return errorResponse(400, 'unsupported contentType', logger)

  try {
    const files = (deps && deps.files) || await Files.init()
    const storagePath = `${UPLOAD_PREFIX}${params.planId}-${Date.now()}.${ext}`
    const uploadUrl = await files.generatePresignURL(storagePath, { expiryInSeconds: EXPIRY_SECONDS, permissions: 'w' })
    logger.info(`upload URL issued for ${params.planId}`)
    return {
      statusCode: 200,
      body: {
        uploadUrl,
        storagePath,
        expiresInSeconds: EXPIRY_SECONDS,
        uploadHeaders: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': params.contentType }
      }
    }
  } catch (error) {
    logger.error(error)
    return errorResponse(500, 'could not create an upload URL', logger)
  }
}

exports.main = main
