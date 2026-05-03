const { test } = require('node:test')
const assert = require('node:assert/strict')
const { requireDiagAccess } = require('../api/lib/require-diag-access')

function mockRes() {
  return {
    _status: 0,
    _body: null,
    status(c) {
      this._status = c
      return this
    },
    json(o) {
      this._body = o
    }
  }
}

test('DISABLE_DIAG=1 returns 404', async () => {
  process.env.DISABLE_DIAG = '1'
  delete process.env.DIAG_ALLOW_SERVICE_TOKEN
  const res = mockRes()
  const out = await requireDiagAccess({}, res, {
    verifySession: async () => null,
    verifyServiceToken: async () => null
  })
  assert.equal(out, null)
  assert.equal(res._status, 404)
  delete process.env.DISABLE_DIAG
})

test('no session and no service → 401', async () => {
  const res = mockRes()
  const out = await requireDiagAccess({}, res, {
    verifySession: async () => null,
    verifyServiceToken: async () => null
  })
  assert.equal(out, null)
  assert.equal(res._status, 401)
})

test('tsr session → 403', async () => {
  const res = mockRes()
  const out = await requireDiagAccess({}, res, {
    verifySession: async () => ({ id: 'u1', role: 'tsr', name: 'T' }),
    verifyServiceToken: async () => null
  })
  assert.equal(out, null)
  assert.equal(res._status, 403)
})

test('exec session → allowed', async () => {
  const res = mockRes()
  const s = { id: 'u1', role: 'exec', name: 'E' }
  const out = await requireDiagAccess({}, res, {
    verifySession: async () => s,
    verifyServiceToken: async () => null
  })
  assert.deepEqual(out, s)
  assert.equal(res._status, 0)
})

test('service token denied when DIAG_ALLOW_SERVICE_TOKEN unset', async () => {
  delete process.env.DIAG_ALLOW_SERVICE_TOKEN
  const res = mockRes()
  const out = await requireDiagAccess({}, res, {
    verifySession: async () => null,
    verifyServiceToken: async () => ({ id: 'svc', role: 'service', name: 'P' })
  })
  assert.equal(out, null)
  assert.equal(res._status, 401)
})

test('service token allowed when DIAG_ALLOW_SERVICE_TOKEN=1', async () => {
  process.env.DIAG_ALLOW_SERVICE_TOKEN = '1'
  const svc = { id: 'svc', role: 'service', name: 'Patrol' }
  const res = mockRes()
  const out = await requireDiagAccess({}, res, {
    verifySession: async () => null,
    verifyServiceToken: async () => svc
  })
  assert.deepEqual(out, svc)
  delete process.env.DIAG_ALLOW_SERVICE_TOKEN
})
