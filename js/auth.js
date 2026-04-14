// VieForce HQ — Auth Module
// Shares users table with VieForce Patrol but uses a different session key

var SESSION_KEY = 'vf_session';
var SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Login with phone + PIN against Supabase users table (v1 direct query)
 * Returns { ok, user, error }
 */
async function login(phone, pin) {
  try {
    var cleaned = phone.replace(/\D/g, '');
    if (cleaned.startsWith('0')) cleaned = '63' + cleaned.slice(1);
    if (!cleaned.startsWith('63')) cleaned = '63' + cleaned;

    var { data, error } = await supabaseClient
      .from('users')
      .select('id, name, role, region, district, territory, pin, active')
      .eq('phone', cleaned)
      .single();

    if (error || !data) {
      return { ok: false, error: 'Invalid phone number' };
    }

    if (!data.active) {
      return { ok: false, error: 'Account is disabled' };
    }

    if (String(data.pin) !== String(pin)) {
      return { ok: false, error: 'Incorrect PIN' };
    }

    var now = Date.now();
    var session = {
      id: data.id,
      name: data.name,
      role: data.role,
      region: data.region || null,
      district: data.district || null,
      territory: data.territory || null,
      loggedInAt: now,
      expiresAt: now + SESSION_TTL
    };

    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return { ok: true, user: session };
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
