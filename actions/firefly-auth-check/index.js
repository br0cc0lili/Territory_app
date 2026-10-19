/*
* Image Extension — Stage diagnostic: does the injected workspace credential
* carry the Firefly scopes, and can it obtain an IMS token?
* Call once before the first real Firefly request.
*
* Response: { clientIdPresent, imsEnv, scopesListed, scopes, requiredScopes,
*             missingScopes, tokenOk, tokenError? }
* Never returns the client secret or the token.
*/

const { Core } = require('@adobe/aio-sdk')
const { errorResponse } = require('../utils')
const { checkPluginKey } = require('../image-extension/gate')
const { describeCredential, REQUIRED_FIREFLY_SCOPES } = require('../image-extension/auth')

async function main (params) {
  const logger = Core.Logger('firefly-auth-check', { level: params.LOG_LEVEL || 'info' })
  const gate = checkPluginKey(params)
  if (gate) return errorResponse(401, gate, logger)

  let c
  try {
    c = describeCredential(params)
  } catch (error) {
    return errorResponse(500, 'no OAuth Server-to-Server credential injected (include-ims-credentials / workspace binding)', logger)
  }
  const body = {
    clientIdPresent: !!c.clientId,
    imsEnv: c.imsEnv,
    scopesListed: c.scopesListed,
    scopes: c.scopes,
    requiredScopes: REQUIRED_FIREFLY_SCOPES,
    missingScopes: c.missingScopes,
    tokenOk: false
  }
  try {
    const token = await Core.AuthClient.generateAccessToken(c.resolved)
    body.tokenOk = !!(token && token.access_token)
  } catch (error) {
    body.tokenError = error && error.message ? error.message : String(error)
  }
  logger.info(`auth check: tokenOk=${body.tokenOk} missingScopes=${body.missingScopes.join(',') || 'none'}`)
  return { statusCode: 200, body }
}

exports.main = main
