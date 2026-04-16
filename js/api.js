// VieForce HQ — Frontend API Client
// Calls Vercel serverless functions under /api/

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
  var qs = new URLSearchParams(params).toString();
  var url = API_BASE + '/' + endpoint + (qs ? '?' + qs : '');

  console.log('[API]', endpoint, qs || '');
  var res;
  try {
    res = await fetch(url, { headers: getApiHeaders() });
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
