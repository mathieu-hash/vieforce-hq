// VieForce HQ — Frontend API Client

var API_BASE = 'https://vieforce-hq-api-1057619753074.asia-southeast1.run.app/api';

function getApiHeaders() {
  var session = getSession();
  return {
    'Content-Type': 'application/json',
    'x-session-id': session ? session.id : ''
  };
}

async function apiFetch(endpoint, params) {
  params = params || {};
  // Cache-buster guarantees browser + CDN do not return stale responses when period/filter changes
  params._t = Date.now();
  var qs = new URLSearchParams(params).toString();
  var url = API_BASE + '/' + endpoint + (qs ? '?' + qs : '');

  console.log('[API]', endpoint, 'params=', params);
  var res;
  try {
    res = await fetch(url, { headers: getApiHeaders(), cache: 'no-store' });
  } catch (e) {
    console.error('[API] Network error:', endpoint, e.message);
    throw e;
  }

  console.log('[API]', endpoint, 'HTTP', res.status);
  if (res.status === 401) {
    console.error('[API] 401 Unauthorized — session invalid');
    logout();
    return null;
  }
  if (!res.ok) {
    var body = '';
    try { body = await res.text(); } catch(e) {}
    console.error('[API] Error', res.status, body);
    throw new Error('API error: ' + res.status + ' ' + body);
  }
  return res.json();
}

function getDashboardData(params) { return apiFetch('dashboard', params); }
function getSalesData(params) { return apiFetch('sales', params); }
function getARData(params) { return apiFetch('ar', params); }
function getInventoryData(params) { return apiFetch('inventory', params); }
function getSpeedData(params) { return apiFetch('speed', params); }
function getCustomersData(params) { return apiFetch('customers', params); }
function getCustomerProfile(params) { return apiFetch('customer', params); }
function getMarginData(params) { return apiFetch('margin', params); }
function getIntelligenceData(params) { return apiFetch('intelligence', params); }
function getTeamData(params) { return apiFetch('team', params); }
function getBudgetData(params) { return apiFetch('budget', params); }
function getItemizedData(params) { return apiFetch('itemized', params); }
function getCustomerSOA(params) { return apiFetch('customer/soa', params); }
function searchGlobal(params) { return apiFetch('search', params); }

// Silence system — POST helpers use JSON body; GET helper reuses apiFetch
async function apiPost(endpoint, body) {
  var url = API_BASE + '/' + endpoint;
  var res = await fetch(url, {
    method: 'POST',
    headers: getApiHeaders(),
    body: JSON.stringify(body || {})
  });
  if (res.status === 401) { logout(); return null; }
  var data = null;
  try { data = await res.json(); } catch(e) {}
  if (!res.ok) {
    var msg = (data && data.error) ? data.error : ('HTTP ' + res.status);
    throw new Error(msg);
  }
  return data;
}
function silenceAlert(payload)   { return apiPost('silence',   payload); }
function unsilenceAlert(payload) { return apiPost('unsilence', payload); }
function getSilenced()           { return apiFetch('silenced'); }
function getDsmHome()            { return apiFetch('dsm/home'); }
