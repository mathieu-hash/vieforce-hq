// VieForce HQ — Auth Module
// Shares users table with VieForce Patrol but uses a different session key

var SESSION_KEY = 'vf_session';
var SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours
var AUTH_API = 'https://vieforce-hq-api-1057619753074.asia-southeast1.run.app/api/auth/login';
var GOOGLE_BRIDGE_API = AUTH_API.replace(/\/login\/?$/i, '') + '/google-bridge';
var GOOGLE_ALLOWED_DOMAIN = 'vienovo.ph';

/**
 * OAuth redirect after Google → Supabase (PKCE ?code= lands here).
 * Add EXACT production URL to Supabase Redirect URLs:
 *   https://vieforce-hq.vercel.app/auth/callback.html
 * Also set Site URL to https://vieforce-hq.vercel.app — otherwise GoTrue may fall back
 * to Patrol and you will never hit this page.
 */
function getHqOAuthRedirectUrl() {
  var path = '/auth/callback.html';
  var host = '';
  try {
    host = String(window.location.hostname || '').toLowerCase();
  } catch (e) {}
  if (host === 'localhost' || host === '127.0.0.1') {
    return 'https://vieforce-hq.vercel.app' + path;
  }
  var o = '';
  try {
    o = String(window.location.origin || '').replace(/\/$/, '');
  } catch (e2) {}
  if (o) return o + path;
  return 'https://vieforce-hq.vercel.app' + path;
}

/** Substring that must not appear in Supabase authorize URL redirect_to when signing in from HQ. */
var PATROL_OAUTH_HOST_MARKER = 'vieforce-patrol';

/**
 * Inspect OAuth authorize URL before navigating (requires skipBrowserRedirect).
 * @returns {{ ok: boolean, error?: string }}
 */
function verifyHqOAuthAuthorizeUrl(authorizeUrl) {
  if (!authorizeUrl) {
    return { ok: false, error: 'Google sign-in did not return a URL. Try again or use phone + PIN.' };
  }
  var redirectParam = '';
  try {
    redirectParam = new URL(authorizeUrl).searchParams.get('redirect_to') || '';
  } catch (e) {
    return { ok: false, error: 'Could not verify Google redirect. Check Supabase Redirect URLs for HQ.' };
  }
  if (!redirectParam) {
    return {
      ok: false,
      error:
        'Supabase omitted redirect_to. Set Site URL and Redirect URLs for HQ (see RUNBOOK_DEPLOY.md) or run npm run fix:supabase-auth-url.'
    };
  }
  var decoded = redirectParam;
  try {
    decoded = decodeURIComponent(redirectParam);
  } catch (e2) {}
  if (decoded.toLowerCase().indexOf(PATROL_OAUTH_HOST_MARKER) !== -1) {
    return {
      ok: false,
      error:
        'Sign-in would return to Patrol, not HQ. In Supabase → Authentication → URL Configuration, set Site URL to the HQ origin and add this app\'s /auth/callback.html to Redirect URLs, or run npm run fix:supabase-auth-url.'
    };
  }
  return { ok: true };
}

async function isGoogleProviderEnabled() {
  if (!window.supabaseClient || !window.HQ_SUPABASE_URL || !window.HQ_SUPABASE_KEY) return null;
  try {
    var settingsUrl = HQ_SUPABASE_URL + '/auth/v1/settings?apikey=' + encodeURIComponent(HQ_SUPABASE_KEY);
    var res = await fetch(settingsUrl);
    if (!res.ok) return null;
    var data = await res.json();
    return !!(data && data.external && data.external.google);
  } catch (e) {
    return null;
  }
}

function normalizeHqEmail(raw) {
  if (!raw) return '';
  return String(raw).trim().toLowerCase();
}

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
 * Logout — clear HQ session, Supabase OAuth session if any, redirect
 */
async function logout() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch (e) {}
  try {
    if (window.supabaseClient && supabaseClient.auth) {
      await supabaseClient.auth.signOut();
    }
  } catch (e2) {}
  window.location.href = 'index.html';
}

/**
 * Google OAuth (same Supabase project as Patrol). After redirect, call maybeHandleGoogleLoginOnLoad().
 */
async function loginWithGoogle() {
  if (!window.supabaseClient || !supabaseClient.auth) {
    return {
      ok: false,
      error: 'Google login is not configured. Check supabase.js and Supabase Google provider.'
    };
  }
  var providerEnabled = await isGoogleProviderEnabled();
  if (providerEnabled === false) {
    return {
      ok: false,
      error: 'Google sign-in is off in this project. Use phone + PIN or enable Google in Supabase Auth.'
    };
  }
  var redirectTo = getHqOAuthRedirectUrl();
  var result = await supabaseClient.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: redirectTo,
      queryParams: {
        hd: GOOGLE_ALLOWED_DOMAIN,
        prompt: 'select_account'
      },
      skipBrowserRedirect: true
    }
  });
  if (result.error) {
    return { ok: false, error: result.error.message || 'Google sign-in failed to start.' };
  }
  var authorizeUrl = result.data && result.data.url;
  var check = verifyHqOAuthAuthorizeUrl(authorizeUrl);
  if (!check.ok) {
    return { ok: false, error: check.error };
  }
  window.location.assign(authorizeUrl);
  return { ok: true, pendingRedirect: true };
}

async function bridgeGoogleSession(accessToken) {
  var res = await fetch(GOOGLE_BRIDGE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: accessToken })
  });
  var data = null;
  try {
    data = await res.json();
  } catch (e) {}
  if (!res.ok || !data || !data.ok) {
    return { ok: false, error: (data && data.error) || ('Google login failed (' + res.status + ')') };
  }
  localStorage.setItem(SESSION_KEY, JSON.stringify(data.user));
  return { ok: true, user: data.user };
}

/**
 * Run on index.html after OAuth redirect: exchange code / restore session, then bridge to vf_session.
 * @returns {{ handled: boolean, ok?: boolean, error?: string }}
 */
async function maybeHandleGoogleLoginOnLoad() {
  if (!window.supabaseClient || !supabaseClient.auth) {
    return { handled: false };
  }

  var query = new URLSearchParams(window.location.search || '');
  var oauthError = query.get('error');
  var oauthErrorDescription = query.get('error_description');
  if (oauthError || oauthErrorDescription) {
    if (window.history && typeof window.history.replaceState === 'function') {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
    return {
      handled: true,
      ok: false,
      error: decodeURIComponent(oauthErrorDescription || oauthError || 'Google sign-in failed.')
    };
  }

  var authSession = null;
  var pkceCode = query.get('code');
  if (pkceCode) {
    var exchanged = await supabaseClient.auth.exchangeCodeForSession(pkceCode);
    if (window.history && typeof window.history.replaceState === 'function') {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
    if (exchanged.error) {
      return {
        handled: true,
        ok: false,
        error: exchanged.error.message || 'Could not complete Google sign-in.'
      };
    }
    authSession = exchanged.data && exchanged.data.session;
  }

  if (!authSession || !authSession.access_token) {
    var rawHash = (window.location.hash || '').replace(/^#/, '');
    if (rawHash.indexOf('access_token=') !== -1) {
      var hp = new URLSearchParams(rawHash);
      var at = hp.get('access_token');
      var rt = hp.get('refresh_token');
      if (at && rt) {
        var setRes = await supabaseClient.auth.setSession({ access_token: at, refresh_token: rt });
        if (window.history && typeof window.history.replaceState === 'function') {
          window.history.replaceState({}, document.title, window.location.pathname);
        }
        if (setRes.error) {
          return {
            handled: true,
            ok: false,
            error: setRes.error.message || 'Could not restore Google session.'
          };
        }
        authSession = setRes.data && setRes.data.session;
      }
    }
  }

  if (!authSession || !authSession.access_token) {
    var existing = await supabaseClient.auth.getSession();
    if (!existing.error && existing.data && existing.data.session) {
      authSession = existing.data.session;
    }
  }

  if (!authSession || !authSession.access_token) {
    return { handled: false };
  }

  var email = normalizeHqEmail(authSession.user && authSession.user.email);
  if (!email || !email.endsWith('@' + GOOGLE_ALLOWED_DOMAIN)) {
    try {
      await supabaseClient.auth.signOut();
    } catch (so) {}
    return {
      handled: true,
      ok: false,
      error: 'Only @' + GOOGLE_ALLOWED_DOMAIN + ' Google accounts are allowed.'
    };
  }

  var bridge = await bridgeGoogleSession(authSession.access_token);
  try {
    await supabaseClient.auth.signOut();
  } catch (so2) {}
  if (!bridge.ok) {
    return { handled: true, ok: false, error: bridge.error };
  }
  return { handled: true, ok: true, user: bridge.user };
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
