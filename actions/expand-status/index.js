/*
* Image Extension — step 3: read a Firefly job's status. The plugin polls
* this; the Adobe token never leaves the backend.
*
* Request (JSON): { jobId }  — a Firefly job id ("urn:ff:jobs:…")
* Response:       { status: "running"|"succeeded"|"failed"|…, jobId, outputUrl?, size?, error? }
*
* The status endpoint is constructed server-side
* (https://firefly-api.adobe.io/v3/status/<jobId>). The client never supplies
* a URL; any statusUrl in the request is ignored.
* outputUrl is Firefly's presigned download URL for the generated image.
*/

const { Core } = require('@adobe/aio-sdk')
const { errorResponse } = require('../utils')
const { checkPluginKey, safeParams } = require('../image-extension/gate')
const { getFireflyAuth } = require('../image-extension/auth')
const { createFireflyClient, assertJobId } = require('../image-extension/firefly')

async function main (params, deps) {
  const logger = Core.Logger('expand-status', { level: params.LOG_LEVEL || 'info' })
  logger.debug(safeParams(params))

  const gate = checkPluginKey(params)
  if (gate) return errorResponse(401, gate, logger)
  try {
    assertJobId(params.jobId)
  } catch (error) {
    return errorResponse(400, error.message, logger)
  }

  try {
    let firefly = deps && deps.firefly
    if (!firefly) {
      const auth = getFireflyAuth(params)
      firefly = createFireflyClient({ fetch, getAccessToken: auth.getAccessToken, clientId: auth.clientId })
    }
    const status = await firefly.getJobStatus(params.jobId)
    logger.info(`job ${params.jobId}: ${status.status}`)
    return { statusCode: 200, body: status }
  } catch (error) {
    return errorResponse(502, error && error.message ? error.message : 'status failed', logger)
  }
}

exports.main = main
