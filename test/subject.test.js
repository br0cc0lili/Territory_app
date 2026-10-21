/*
* Center Subject actions — mocked tests (no network, no real credentials).
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

const ps = require('../actions/subject/photoshop')
const uploadUrl = require('../actions/subject-upload-url/index.js')
const subjectMask = require('../actions/subject-mask/index.js')
const subjectStatus = require('../actions/subject-status/index.js')

const KEY = 'stage-prototype-key'
const base = { PLUGIN_SHARED_KEY: KEY, __ow_headers: { 'x-plugin-key': KEY } }
const JOB = 'urn:ff:jobs:va6:0b1c2d3e-aaaa-bbbb-cccc-123456789abc'
const PATH = 'subject/uploads/SUB_0123456789ab-1.jpg'

function jsonResponse (status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

beforeEach(() => {
  jest.clearAllMocks()
  Core.Logger.mockReturnValue(logger)
})

describe('validation', () => {
  test('upload path and content type', () => {
    expect(ps.validateUpload({ storagePath: PATH, contentType: 'image/jpeg' })).toBe('')
    expect(ps.validateUpload({ storagePath: 'image-extension/uploads/x.jpg', contentType: 'image/jpeg' })).toBe('invalid storagePath')
    expect(ps.validateUpload({ storagePath: 'subject/uploads/../x.jpg', contentType: 'image/jpeg' })).toBe('invalid storagePath')
    expect(ps.validateUpload({ storagePath: PATH, contentType: 'image/webp' })).toMatch(/unsupported contentType/)
  })
  test('status URL from the client is only trusted on Adobe hosts with the same job id', () => {
    expect(ps.trustedStatusUrl(JOB, `https://firefly-epo851211.adobe.io/v3/status/${JOB}`)).toBe(`https://firefly-epo851211.adobe.io/v3/status/${JOB}`)
    expect(ps.trustedStatusUrl(JOB, `https://evil.example.com/v3/status/${JOB}`)).toBe(null)
    expect(ps.trustedStatusUrl(JOB, `https://firefly-api.adobe.io.evil.com/v3/status/${JOB}`)).toBe(null)
    expect(ps.trustedStatusUrl(JOB, 'https://firefly-api.adobe.io/v3/status/urn:ff:jobs:other')).toBe(null)
    expect(ps.trustedStatusUrl(JOB, `https://firefly-api.adobe.io/v3/status/${JOB}?x=1`)).toBe(null)
    expect(ps.statusUrlsFor(JOB, 'nonsense')).toEqual([
      `https://firefly-api.adobe.io/v3/status/${JOB}`,
      `https://photoshop-api.adobe.io/v2/status/${JOB}`
    ])
    expect(() => ps.statusUrlsFor('../../x')).toThrow(/invalid jobId/)
  })
})

describe('photoshop client', () => {
  const auth = { getAccessToken: async () => 'TOKEN-VALUE', clientId: 'cid' }

  test('submitMask sends mode "mask" with the upload id', async () => {
    const fetch = jest.fn().mockResolvedValue(jsonResponse(202, { jobId: JOB, statusUrl: `https://firefly-epo1.adobe.io/v3/status/${JOB}` }))
    const job = await ps.createPhotoshopClient({ fetch, ...auth }).submitMask('UPLOAD-1')
    expect(job.jobId).toBe(JOB)
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('https://image.adobe.io/v2/remove-background')
    expect(JSON.parse(init.body)).toEqual({ image: { source: { uploadId: 'UPLOAD-1' } }, mode: 'mask', output: { mediaType: 'image/png' } })
    expect(init.headers.Authorization).toBe('Bearer TOKEN-VALUE')
    expect(init.headers['X-Api-Key']).toBe('cid')
  })

  test('getMaskStatus returns the mask URL, falls back on 404', async () => {
    const fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse(404, { message: 'not here' }))
      .mockResolvedValueOnce(jsonResponse(200, { status: 'succeeded', result: { outputs: [{ destination: { url: 'https://s3.example/mask.png' } }] } }))
    const st = await ps.createPhotoshopClient({ fetch, ...auth }).getMaskStatus(JOB)
    expect(st).toEqual({ status: 'succeeded', jobId: JOB, maskUrl: 'https://s3.example/mask.png' })
    expect(fetch.mock.calls[1][0]).toBe(`https://photoshop-api.adobe.io/v2/status/${JOB}`)
  })

  test('getMaskStatus reports failures and running jobs', async () => {
    const fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse(200, { status: 'running' }))
      .mockResolvedValueOnce(jsonResponse(200, { status: 'failed', errors: [{ message: 'bad image' }] }))
      .mockResolvedValueOnce(jsonResponse(200, { status: 'succeeded', result: { outputs: [] } }))
    const client = ps.createPhotoshopClient({ fetch, ...auth })
    expect((await client.getMaskStatus(JOB)).status).toBe('running')
    expect(await client.getMaskStatus(JOB)).toEqual({ status: 'failed', jobId: JOB, error: 'bad image' })
    expect((await client.getMaskStatus(JOB)).error).toMatch(/without a mask URL/)
  })
})

describe('subject-upload-url', () => {
  test('rejects a wrong key and a wrong type', async () => {
    const r1 = await uploadUrl.main({ PLUGIN_SHARED_KEY: KEY, contentType: 'image/jpeg' })
    expect(r1.error.statusCode).toBe(401)
    const r2 = await uploadUrl.main({ ...base, contentType: 'image/gif' })
    expect(r2.error.statusCode).toBe(400)
  })
  test('issues a write URL under subject/uploads/', async () => {
    const files = { generatePresignURL: jest.fn().mockResolvedValue('https://files.example/put?sig') }
    const r = await uploadUrl.main({ ...base, contentType: 'image/png' }, { files })
    expect(r.statusCode).toBe(200)
    expect(r.body.storagePath).toMatch(/^subject\/uploads\/SUB_[0-9a-f]{12}-\d+\.png$/)
    expect(r.body.uploadHeaders['x-ms-blob-type']).toBe('BlockBlob')
    expect(files.generatePresignURL.mock.calls[0][1]).toEqual({ expiryInSeconds: 600, permissions: 'w' })
    expect(Files.init).not.toHaveBeenCalled()
  })
})

describe('subject-mask', () => {
  test('reads, shrinks, uploads, submits and deletes the temporary file', async () => {
    const files = { read: jest.fn().mockResolvedValue(Buffer.from('JPEGDATA')), delete: jest.fn().mockResolvedValue() }
    const storage = { uploadImage: jest.fn().mockResolvedValue('UPLOAD-1') }
    const photoshop = { submitMask: jest.fn().mockResolvedValue({ jobId: JOB, statusUrl: 'https://firefly-epo1.adobe.io/v3/status/' + JOB }) }
    const shrink = jest.fn().mockResolvedValue({ bytes: Buffer.from('SMALL'), contentType: 'image/jpeg', width: 2048, height: 1365 })
    const r = await subjectMask.main({ ...base, storagePath: PATH, contentType: 'image/jpeg' }, { files, storage, photoshop, shrink })
    expect(r.statusCode).toBe(200)
    expect(r.body.jobId).toBe(JOB)
    expect(r.body.sentSize).toEqual({ width: 2048, height: 1365 })
    expect(storage.uploadImage.mock.calls[0][1]).toBe('image/jpeg')
    expect(photoshop.submitMask).toHaveBeenCalledWith('UPLOAD-1')
    expect(files.delete).toHaveBeenCalledWith(PATH)
  })
  test('rejects paths outside subject/uploads/ before touching storage', async () => {
    const files = { read: jest.fn(), delete: jest.fn() }
    const r = await subjectMask.main({ ...base, storagePath: 'image-extension/uploads/EXT_0123abcd-1.jpg', contentType: 'image/jpeg' }, { files, storage: {}, photoshop: {} })
    expect(r.error.statusCode).toBe(400)
    expect(files.read).not.toHaveBeenCalled()
  })
  test('API errors become 502 and the upload is still deleted', async () => {
    const files = { read: jest.fn().mockResolvedValue(Buffer.from('X')), delete: jest.fn().mockResolvedValue() }
    const storage = { uploadImage: jest.fn().mockRejectedValue(new Error('Firefly image upload failed (HTTP 403)')) }
    const r = await subjectMask.main({ ...base, storagePath: PATH, contentType: 'image/jpeg' },
      { files, storage, photoshop: {}, shrink: async (b, t) => ({ bytes: b, contentType: t }) })
    expect(r.error.statusCode).toBe(502)
    expect(r.error.body.error).toMatch(/HTTP 403/)
    expect(files.delete).toHaveBeenCalledWith(PATH)
  })
})

describe('subject-status', () => {
  test('validates the job id and passes the status URL hint', async () => {
    const bad = await subjectStatus.main({ ...base, jobId: 'https://evil' })
    expect(bad.error.statusCode).toBe(400)
    const photoshop = { getMaskStatus: jest.fn().mockResolvedValue({ status: 'succeeded', jobId: JOB, maskUrl: 'https://s3/m.png' }) }
    const hint = 'https://firefly-epo1.adobe.io/v3/status/' + JOB
    const r = await subjectStatus.main({ ...base, jobId: JOB, statusUrl: hint }, { photoshop })
    expect(r.body.maskUrl).toBe('https://s3/m.png')
    expect(photoshop.getMaskStatus).toHaveBeenCalledWith(JOB, hint)
  })
})

describe('subject box (plugin integration)', () => {
  const box = require('../actions/subject/box')
  const bitmap = (w, h, rect) => {
    const data = Buffer.alloc(w * h * 4)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const on = x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h
      data[i] = data[i + 1] = data[i + 2] = on ? 255 : 0; data[i + 3] = 255
    }
    return { width: w, height: h, data }
  }
  test('box as shares of the mask; stray pixels ignored', () => {
    const b = bitmap(200, 100, { x: 50, y: 20, w: 100, h: 60 })
    b.data[(5 * 200 + 5) * 4] = 255; b.data[(5 * 200 + 5) * 4 + 1] = 255; b.data[(5 * 200 + 5) * 4 + 2] = 255 // stray pixel
    expect(box.boxFromBitmap(b)).toMatchObject({ x: 0.25, y: 0.2, width: 0.5, height: 0.6 })
  })
  test('empty mask → null', () => {
    expect(box.boxFromBitmap(bitmap(10, 10, { x: 0, y: 0, w: 0, h: 0 }))).toBeNull()
  })
  test('subject-status returns subjectBox on success; a box failure does not fail the status', async () => {
    const photoshop = { getMaskStatus: jest.fn().mockResolvedValue({ status: 'succeeded', jobId: JOB, maskUrl: 'https://mask.example/m.png' }) }
    let r = await subjectStatus.main({ ...base, jobId: JOB }, { photoshop, box: async () => ({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }) })
    expect(r.body.subjectBox).toEqual({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 })
    r = await subjectStatus.main({ ...base, jobId: JOB }, { photoshop, box: async () => { throw new Error('boom') } })
    expect(r.statusCode).toBe(200)
    expect(r.body).toMatchObject({ status: 'succeeded', boxError: 'boom' })
  })
})
