// Shared HTTP helpers for API handlers.

// Send a 500 without leaking internal error detail to the client.
// mssql/Supabase error messages contain SQL fragments, table/column names,
// and login/host details ("Login failed for user 'gsheet'", "Invalid column
// name 'U_districtName'") — these must never reach the browser. The full error
// (with stack) is logged server-side for debugging; the client gets a generic
// message plus a short reference id it can quote in a support request.
function serverError(res, err, tag = 'api', status = 500) {
  const ref = Math.random().toString(36).slice(2, 8)
  const msg = err && err.message ? err.message : String(err)
  console.error(`[${tag}] error ref=${ref}:`, msg, err && err.stack ? '\n' + err.stack : '')
  res.status(status).json({ error: 'Server error', ref })
}

module.exports = { serverError }
