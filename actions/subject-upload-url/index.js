/*
* Center Subject — step 1: presigned upload URL.
*
* The plugin uploads the product photo straight to App Builder Files with
* this short-lived WRITE URL (image bytes never pass through a Runtime
* request, which is limited to about 1 MB).
*
* Request (JSON): { contentType: "image/jpeg"|"image/png" }
* Response:       { uploadUrl, storagePath, expiresInSeconds, uploadHeaders }
*
* Header: x-plugin-key (same gate as Image Extension). No Adobe credential needed.
*/

const crypto = require('crypto')
const { Core, Files } = require('@adobe/aio-sdk')
const { errorResponse } = require('../utils')
const { checkPluginKey, safeParams } = require('../image-extension/gate')
const { UPLOAD_PREFIX, CONTENT_TYPES } = require('../subject/photoshop')

const EXPIRY_SECONDS = 600

async function main (params, deps) {
  const logger = Core.Logger('subject-upload-url', { level: params.LOG_LEVEL || 'info' })
  logger.debug(safeParams(params))

  const gate = checkPluginKey(params)
  if (gate) return errorResponse(401, gate, logger)
  const ext = CONTENT_TYPES[params.contentType]
  if (!ext) return errorResponse(400, 'unsupported contentType (use image/jpeg or image/png)', logger)

  try {
    const files = (deps && deps.files) || await Files.init()
    const id = crypto.randomBytes(6).toString('hex')
    const storagePath = `${UPLOAD_PREFIX}SUB_${id}-${Date.now()}.${ext}`
    const uploadUrl = await files.generatePresignURL(storagePath, { expiryInSeconds: EXPIRY_SECONDS, permissions: 'w' })
    logger.info(`subject upload URL issued: ${storagePath}`)
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
