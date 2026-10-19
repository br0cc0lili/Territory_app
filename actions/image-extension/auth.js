/*
* Image Extension — Firefly authentication via the workspace's own
* OAuth Server-to-Server credential.
*
* The actions that call Firefly are annotated `include-ims-credentials: true`
* (app.config.yaml). Runtime then injects the Stage workspace credential as
* params.__ims_oauth_s2s (client id / secret / org / scopes) — nothing in
* .env. Core.AuthClient.generateAccessToken() (@adobe/aio-lib-core-auth)
* resolves it, requests the IMS token and caches it (5 min TTL).
*
* Never log or return the credential or the token.
*/

const { Core } = require('@adobe/aio-sdk')

// Scopes Firefly Services needs on the credential.
const REQUIRED_FIREFLY_SCOPES = ['firefly_api', 'ff_apis']

/**
 * Non-secret view of the injected credential, plus the scope check.
 * Throws if no credential was injected (annotation missing / workspace has
 * no OAuth Server-to-Server credential).
 */
function describeCredential (params) {
  const resolved = Core.AuthClient.resolveCredentials(params)
  const scopes = resolved.credentials.scopes || []
  return {
    resolved,
    clientId: resolved.credentials.clientId,
    imsEnv: resolved.env,
    scopes,
    // An empty scope list means the credential's default scopes are used —
    // can't be checked locally; the first token request is the check then.
    scopesListed: scopes.length > 0,
    missingScopes: scopes.length > 0 ? REQUIRED_FIREFLY_SCOPES.filter(s => !scopes.includes(s)) : []
  }
}

/**
 * What lib/firefly.js needs: the client id (X-Api-Key) and a token getter.
 * Refuses to proceed if the credential lists scopes but not Firefly's.
 */
function getFireflyAuth (params) {
  const c = describeCredential(params)
  if (c.missingScopes.length) {
    throw new Error(`Stage OAuth Server-to-Server credential lacks Firefly scope(s): ${c.missingScopes.join(', ')}`)
  }
  return {
    clientId: c.clientId,
    getAccessToken: async () => {
      const token = await Core.AuthClient.generateAccessToken(c.resolved)
      if (!token || !token.access_token) throw new Error('IMS returned no access token')
      return token.access_token
    }
  }
}

module.exports = { REQUIRED_FIREFLY_SCOPES, describeCredential, getFireflyAuth }
