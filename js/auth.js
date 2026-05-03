// VieForce HQ — Auth Module
// Shares users table with VieForce Patrol but uses a different session key

var SESSION_KEY = 'vf_session';
var SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours
var AUTH_API = 'https://vieforce-hq-api-1057619753074.asia-southeast1.run.app/api/auth/login';

/**
 * Login with phone + PIN — calls the server-side endpoint that compares pin_hash
 * with the service-role Supabase client, so the anon key (and any browser
 * inspector) never sees pin_hash. Server enforces 5/min IP rate limit.
 * Returns { ok, user, error, retryAfterSeconds? }
 */
async function login(phone, pin) {
  try {
    var res = await fetch(AUTH_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: phone, pin: pin })
    });

    var data = null;
    try { data = await res.json(); } catch(e) {}

    // Rate-limited
    if (res.status === 429) {
      return { ok: false, error: (data && data.error) || 'Too many attempts. Try again in a minute.', retryAfterSeconds: data && data.retryAfterSeconds };
    }
    // Disabled account
    if (res.status === 403) {
      return { ok: false, error: (data && data.error) || 'Account is disabled' };
    }
    // Invalid (generic — don't distinguish phone vs PIN to defeat enumeration)
    if (res.status === 401) {
      return { ok: false, error: 'Invalid credentials' };
    }
    // Other errors
    if (!res.ok || !data || !data.ok) {
      return { ok: false, error: (data && data.error) || ('Login failed (' + res.status + ')') };
    }

    // Success — server returns the same session shape we used to build client-side
    localStorage.setItem(SESSION_KEY, JSON.stringify(data.user));
    return { ok: true, user: data.user };
  } catch (err) {
    return { ok: false, error: err.message || 'Login failed' };
  }
}

/**
 * Get current session (null if expired or missing)
 */
function getSession() {
  try {
    var raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;

    var session = JSON.parse(raw);
    if (!session || !session.id) return null;

    // Check 24h expiry
    if (Date.now() > session.expiresAt) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }

    return session;
  } catch (e) {
    localStorage.removeItem(SESSION_KEY);
    return null;
  }
}

/**
 * Require auth — redirect to login if no valid session
 */
function requireAuth() {
  var session = getSession();
  if (!session) {
    window.location.href = 'index.html';
    return null;
  }
  return session;
}

/**
 * Logout — clear session and redirect
 */
function logout() {
  localStorage.removeItem(SESSION_KEY);
  window.location.href = 'index.html';
}

/**
 * Check if current user has one of the given roles
 * @param {string|string[]} roles - single role or array of roles
 */
function hasRole(roles) {
  var session = getSession();
  if (!session) return false;
  if (typeof roles === 'string') roles = [roles];
  return roles.indexOf(session.role) !== -1;
}
