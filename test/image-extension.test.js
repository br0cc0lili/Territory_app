/*
* Image Extension actions — mocked tests (no network, no real credentials).
*/

jest.mock('@adobe/aio-sdk', () => ({
  Core: {
    Logger: jest.fn(),
    AuthClient: { resolveCredentials: jest.fn(), generateAccessToken: jest.fn() }
  },
  Files: { init: jest.fn() }
}))

const { Core, Files } = require('@adobe/aio-sdk')
const logger = { info: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn() }
Core.Logger.mockReturnValue(logger)

const gate = require('../actions/image-extension/gate')
const auth = require('../actions/image-extension/auth')
const { createFireflyClient } = require('../actions/image-extension/firefly')
const getUploadUrl = require('../actions/get-upload-url/index.js')
const expandImage = require('../actions/expand-image/index.js')
const expandStatus = require('../actions/expand-status/index.js')
const authCheck = require('../actions/firefly-auth-check/index.js')

const KEY = 'stage-prototype-key'
const base = { PLUGIN_SHARED_KEY: KEY, __ow_headers: { 'x-plugin-key': KEY } }
const ims = { client_id: 'cid', client_secret: 'SECRET-VALUE', org_id: 'org@AdobeOrg', scopes: ['openid', 'firefly_api', 'ff_apis'] }
const working = { source: { width: 100, height: 80 }, size: { width: 100, height: 120 }, inset: { top: 0, right: 0, bottom: 40, left: 0 } }
const expandReq = { ...base, planId: 'EXT_0123abcd', storagePath: 'image-extension/uploads/EXT_0123abcd-1.jpg', contentType: 'image/jpeg', working }

function mockCredential (scopes) {
  Core.AuthClient.resolveCredentials.mockReturnValue({
    credentials: { clientId: 'cid', clientSecret: 'SECRET-VALUE', orgId: 'org@AdobeOrg', scopes }, env: 'prod'
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  Core.Logger.mockReturnValue(logger)
  mockCredential(ims.scopes)
  Core.AuthClient.generateAccessToken.mockResolvedValue({ access_token: 'TOKEN-VALUE', expires_in: 86399 })
})

describe('gate', () => {
  test('rejects missing / wrong key, accepts the right one', () => {
    expect(gate.checkPluginKey({ PLUGIN_SHARED_KEY: KEY })).toBe('invalid plugin key')
    expect(gate.checkPluginKey({ PLUGIN_SHARED_KEY: KEY, __ow_headers: { 'x-plugin-key': 'nope' } })).toBe('invalid plugin key')
    expect(gate.checkPluginKey({ __ow_headers: { 'x-plugin-key': KEY } })).toMatch(/missing PLUGIN_SHARED_KEY/)
    expect(gate.checkPluginKey(base)).toBe('')
  })
  test('validates the working request', () => {
    expect(gate.validateExpandRequest(expandReq)).toBe('')
    expect(gate.validateExpandRequest({ ...expandReq, planId: 'x' })).toBe('invalid planId')
    expect(gate.validateExpandRequest({ ...expandReq, storagePath: 'image-extension/uploads/../x' })).toBe('invalid storagePath')
    expect(gate.validateExpandRequest({ ...expandReq, contentType: 'image/gif' })).toBe('unsupported contentType')
    expect(gate.validateExpandRequest({ ...expandReq, working: { ...working, size: { width: 100, height: 121 } } })).toMatch(/doesn't match/)
    expect(gate.validateExpandRequest({ ...expandReq, working: { source: { width: 2000, height: 2000 }, size: { width: 2000, height: 2800 }, inset: { top: 0, right: 0, bottom: 800, left: 0 } } })).toMatch(/exceeds 2688/)
  })
  test('safeParams hides key and credential', () => {
    const s = gate.safeParams({ ...base, __ims_oauth_s2s: ims })
    expect(s).not.toContain(KEY)
    expect(s).not.toContain('SECRET-VALUE')
  })
})

describe('auth', () => {
  test('token comes from Core.AuthClient with the injected credential', async () => {
    const a = auth.getFireflyAuth({ __ims_oauth_s2s: ims })
    expect(a.clientId).toBe('cid')
    expect(await a.getAccessToken()).toBe('TOKEN-VALUE')
    expect(Core.AuthClient.generateAccessToken).toHaveBeenCalledWith(expect.objectContaining({ env: 'prod' }))
  })
  test('refuses a credential that lists scopes but not Firefly\'s', () => {
    mockCredential(['openid', 'AdobeID'])
    expect(() => auth.getFireflyAuth({})).toThrow(/firefly_api, ff_apis/)
  })
  test('empty scope list is allowed (checked by the first token call)', () => {
    mockCredential([])
    expect(auth.describeCredential({}).scopesListed).toBe(false)
    expect(() => auth.getFireflyAuth({})).not.toThrow()
  })
})

describe('get-upload-url', () => {
  test('401 without key', async () => {
    const r = await getUploadUrl.main({ PLUGIN_SHARED_KEY: KEY, planId: 'EXT_0123abcd', contentType: 'image/jpeg' })
    expect(r.error.statusCode).toBe(401)
  })
  test('returns presigned write URL + BlockBlob headers', async () => {
    const files = { generatePresignURL: jest.fn().mockResolvedValue('https://storage.example/presigned') }
    const r = await getUploadUrl.main({ ...base, planId: 'EXT_0123abcd', contentType: 'image/png' }, { files })
    expect(r.statusCode).toBe(200)
    expect(r.body.storagePath).toMatch(/^image-extension\/uploads\/EXT_0123abcd-\d+\.png$/)
    expect(r.body.uploadHeaders).toEqual({ 'x-ms-blob-type': 'BlockBlob', 'Content-Type': 'image/png' })
    expect(files.generatePresignURL).toHaveBeenCalledWith(r.body.storagePath, { expiryInSeconds: 600, permissions: 'w' })
  })
  test('uses Files.init() from aio-sdk by default', async () => {
    Files.init.mockResolvedValue({ generatePresignURL: jest.fn().mockResolvedValue('u') })
    const r = await getUploadUrl.main({ ...base, planId: 'EXT_0123abcd', contentType: 'image/jpeg' })
    expect(Files.init).toHaveBeenCalled()
    expect(r.statusCode).toBe(200)
  })
})

describe('expand-image', () => {
  test('400 on invalid request, nothing touched', async () => {
    const r = await expandImage.main({ ...expandReq, planId: 'bad' })
    expect(r.error.statusCode).toBe(400)
    expect(Files.init).not.toHaveBeenCalled()
  })
  test('full flow with real Firefly client against mocked fetch; secret/token never in response', async () => {
    const files = { read: jest.fn().mockResolvedValue(Buffer.from('img')), delete: jest.fn().mockResolvedValue() }
    Files.init.mockResolvedValue(files)
    const calls = []
    global.fetch = jest.fn(async (url, opts) => {
      calls.push({ url, opts })
      if (url.endsWith('/v2/storage/image')) return { ok: true, json: async () => ({ images: [{ id: 'up-1' }] }) }
      return { ok: true, json: async () => ({ jobId: 'urn:ff:jobs:epo1:job-1', statusUrl: 'https://firefly-epo1.adobe.io/v3/status/urn:ff:jobs:epo1:job-1' }) }
    })
    const resize = jest.fn(async (b, ct) => ({ bytes: b, contentType: ct }))
    const r = await expandImage.main({ ...expandReq, __ims_oauth_s2s: ims }, { resize })
    expect(r.statusCode).toBe(200)
    expect(r.body).toMatchObject({ planId: 'EXT_0123abcd', jobId: 'urn:ff:jobs:epo1:job-1', uploadId: 'up-1', statusUrl: 'https://firefly-epo1.adobe.io/v3/status/urn:ff:jobs:epo1:job-1' })
    expect(r.body.fireflyRequest).toEqual({
      numVariations: 1, size: { width: 100, height: 120 }, image: { source: { uploadId: 'up-1' } },
      placement: { inset: { left: 0, top: 0, right: 0, bottom: 40 } }
    })
    expect(resize).toHaveBeenCalledWith(expect.anything(), 'image/jpeg', 100, 80)
    expect(calls[1].url).toBe('https://firefly-api.adobe.io/v3/images/expand-async')
    expect(calls[1].opts.headers).toMatchObject({ 'X-Api-Key': 'cid', Authorization: 'Bearer TOKEN-VALUE' })
    expect(files.delete).toHaveBeenCalledWith(expandReq.storagePath)
    const out = JSON.stringify(r)
    expect(out).not.toContain('TOKEN-VALUE')
    expect(out).not.toContain('SECRET-VALUE')
  })
  test('missing Firefly scopes → 502, temp upload still cleaned', async () => {
    mockCredential(['openid'])
    const files = { read: jest.fn(), delete: jest.fn().mockResolvedValue() }
    const r = await expandImage.main(expandReq, { files })
    expect(r.error.statusCode).toBe(502)
    expect(r.error.body.error).toMatch(/lacks Firefly scope/)
    expect(files.delete).toHaveBeenCalled()
  })
  test('resizeWithJimp produces the exact working size', async () => {
    const Jimp = require('jimp')
    const src = await new Jimp(200, 160, 0xff0000ff).getBufferAsync(Jimp.MIME_JPEG)
    const out = await expandImage.resizeWithJimp(src, 'image/jpeg', 100, 80)
    const img = await Jimp.read(out.bytes)
    expect([img.bitmap.width, img.bitmap.height]).toEqual([100, 80])
  })
})

describe('expand-image prompt', () => {
  test('validates prompt type and length', () => {
    expect(gate.validateExpandRequest({ ...expandReq, prompt: 'wet asphalt, dusk' })).toBe('')
    expect(gate.validateExpandRequest({ ...expandReq, prompt: 'x'.repeat(1025) })).toMatch(/1024/)
    expect(gate.validateExpandRequest({ ...expandReq, prompt: 42 })).toMatch(/prompt/)
  })
  test('passes a trimmed prompt to expand-async; omits an empty one', async () => {
    const bodies = []
    global.fetch = jest.fn(async (url, opts) => {
      if (url.endsWith('/v2/storage/image')) return { ok: true, json: async () => ({ images: [{ id: 'up-1' }] }) }
      bodies.push(JSON.parse(opts.body))
      return { ok: true, json: async () => ({ jobId: 'urn:ff:jobs:x:1', statusUrl: 'https://firefly-epo1.adobe.io/v3/status/urn:ff:jobs:x:1' }) }
    })
    const files = { read: jest.fn().mockResolvedValue(Buffer.from('img')), delete: jest.fn().mockResolvedValue() }
    const resize = async (b, ct) => ({ bytes: b, contentType: ct })
    let r = await expandImage.main({ ...expandReq, __ims_oauth_s2s: ims, prompt: '  wet asphalt, dusk  ' }, { files, resize })
    expect(r.statusCode).toBe(200)
    expect(bodies[0].prompt).toBe('wet asphalt, dusk')
    expect(r.body.fireflyRequest.prompt).toBe('wet asphalt, dusk')
    r = await expandImage.main({ ...expandReq, __ims_oauth_s2s: ims, prompt: '   ' }, { files, resize })
    expect('prompt' in bodies[1]).toBe(false)
  })
})

describe('expand-status', () => {
  const JOB = 'urn:ff:jobs:epo123456:0f1e2d3c-aaaa-bbbb-cccc-1234567890ab'
  test('rejects missing / malformed jobIds (no fetch)', async () => {
    global.fetch = jest.fn()
    for (const jobId of [undefined, '', 'job-1', 'urn:ff:jobs:', 'urn:ff:jobs:x/../../v2/storage', 'urn:ff:jobs:x?y=1', 'urn:ff:jobs:x#f', 'urn:ff:jobs:%2e%2e', 'https://firefly-api.adobe.io/v3/status/urn:ff:jobs:x']) {
      const r = await expandStatus.main({ ...base, __ims_oauth_s2s: ims, jobId })
      expect(r.error.statusCode).toBe(400)
    }
    expect(global.fetch).not.toHaveBeenCalled()
  })
  test('ignores a client statusUrl; queries the canonical endpoint built from jobId', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ status: 'running', jobId: JOB }) }))
    const r = await expandStatus.main({ ...base, __ims_oauth_s2s: ims, jobId: JOB, statusUrl: 'https://evil.example/x' })
    expect(r.statusCode).toBe(200)
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(global.fetch.mock.calls[0][0]).toBe(`https://firefly-api.adobe.io/v3/status/${JOB}`)
    expect(global.fetch.mock.calls[0][1].headers).toMatchObject({ 'X-Api-Key': 'cid', Authorization: 'Bearer TOKEN-VALUE' })
    expect(JSON.stringify(r)).not.toContain('TOKEN-VALUE')
  })
  test('normalises a succeeded job', async () => {
    const firefly = createFireflyClient({
      fetch: async () => ({ ok: true, json: async () => ({ status: 'succeeded', jobId: JOB, result: { size: { width: 100, height: 120 }, outputs: [{ image: { url: 'https://out.example/x.jpg' } }] } }) }),
      getAccessToken: async () => 't', clientId: 'cid'
    })
    const r = await expandStatus.main({ ...base, jobId: JOB }, { firefly })
    expect(r.body).toMatchObject({ status: 'succeeded', jobId: JOB, outputUrl: 'https://out.example/x.jpg' })
  })
})

describe('firefly-auth-check', () => {
  test('reports scopes and token result without secrets', async () => {
    const r = await authCheck.main({ ...base, __ims_oauth_s2s: ims })
    expect(r.body).toMatchObject({ clientIdPresent: true, missingScopes: [], tokenOk: true, scopesListed: true })
    const out = JSON.stringify(r)
    expect(out).not.toContain('TOKEN-VALUE')
    expect(out).not.toContain('SECRET-VALUE')
  })
  test('reports missing scopes', async () => {
    mockCredential(['openid'])
    const r = await authCheck.main(base)
    expect(r.body.missingScopes).toEqual(['firefly_api', 'ff_apis'])
  })
})
