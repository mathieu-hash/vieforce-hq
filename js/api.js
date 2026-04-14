// VieForce HQ — Frontend API Client
// Calls Vercel serverless functions under /api/

var API_BASE = '/api';

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

  var res = await fetch(url, { headers: getApiHeaders() });

  if (res.status === 401) {
    logout();
    return null;
  }
  if (!res.ok) {
    throw new Error('API error: ' + res.status);
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
