/*
* Center Subject — step 3: read a mask job. The plugin polls this; the Adobe
* token never leaves the backend.
*
* Request (JSON): { jobId, statusUrl? }
*   statusUrl (from subject-mask) is only used when it is an Adobe status
*   host (*.adobe.io, /v2|v3/status/) AND ends with the same jobId;
*   otherwise the canonical status endpoints are used.
* Response: { status: "running"|"succeeded"|"failed"|…, jobId, maskUrl?, subjectBox?, boxError?, error? }
*   maskUrl: pre-signed PNG download (white = subject), valid about 1 hour.
*   subjectBox: { x, y, width, height } as shares (0..1) of the photo, measured
*     from the mask here (actions/subject/box.js) — UXP can't decode the PNG.
*     If measuring fails, boxError says why; the status itself still succeeds.
*/

const { Core } = require('@adobe/aio-sdk')
const { errorResponse } = require('../utils')
const { checkPluginKey, safeParams } = require('../image-extension/gate')
const { getFireflyAuth } = require('../image-extension/auth')
const { createPhotoshopClient, assertJobId } = require('../subject/photoshop')
const { subjectBoxFromMask } = require('../subject/box')

async function main (params, deps) {
  const logger = Core.Logger('subject-status', { level: params.LOG_LEVEL || 'info' })
  logger.debug(safeParams(params))

  const gate = checkPluginKey(params)
  if (gate) return errorResponse(401, gate, logger)
  try {
    assertJobId(params.jobId)
  } catch (error) {
    return errorResponse(400, error.message, logger)
  }

  try {
    let photoshop = deps && deps.photoshop
    if (!photoshop) {
      const auth = getFireflyAuth(params)
      photoshop = createPhotoshopClient({ fetch, getAccessToken: auth.getAccessToken, clientId: auth.clientId })
    }
    const status = await photoshop.getMaskStatus(params.jobId, params.statusUrl)
    if (status.status === 'succeeded' && status.maskUrl) {
      try {
        status.subjectBox = await ((deps && deps.box) || ((url) => subjectBoxFromMask(url, fetch)))(status.maskUrl)
        if (!status.subjectBox) status.boxError = 'mask contains no subject'
      } catch (error) {
        status.boxError = error && error.message ? error.message : 'could not measure the mask'
      }
    }
    logger.info(`subject job ${params.jobId}: ${status.status}`)
    return { statusCode: 200, body: status }
  } catch (error) {
    return errorResponse(502, error && error.message ? error.message : 'status failed', logger)
  }
}

exports.main = main
