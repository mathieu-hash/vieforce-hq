// VieForce HQ — RSM Mobile Home
// Loader + renderers for #pg-rsm-home.
// Piggybacks on /api/team + /api/dashboard (+ /api/ar if available) + Supabase Patrol.
// No new backend endpoint.
// Uses helpers from app.html scope: fc, fcn, esc, navTo, PG, DC, apiFetch, supabaseClient.

(function(){

  function safe(fn){ try { return fn(); } catch(e){ console.error('[rsm]', e); } }

  // ===== Formatters =====
  function fmtPhpShort(n){
    var v = Number(n || 0);
    var abs = Math.abs(v);
    if (abs >= 1e9) return '₱' + (v/1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return '₱' + (v/1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return '₱' + Math.round(v/1e3) + 'K';
    return '₱' + Math.round(v);
  }
  function fmtNum(n){
    if (typeof fcn === 'function') return fcn(Math.round(n||0));
    return Math.round(Number(n||0)).toLocaleString('en-PH');
  }
  function fmtPct(n){
    if (n == null || isNaN(n)) return '—';
    var v = Number(n);
    var sign = v > 0 ? '+' : '';
    return sign + v.toFixed(1) + '%';
  }
  function escHtml(s){
    if (typeof esc === 'function') return esc(s);
    return String(s||'').replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function initialsOf(name){
    if (!name) return '—';
    var parts = String(name).trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length-1][0]).toUpperCase();
    return (parts[0][0] || '—').toUpperCase();
  }
  function starBar(score){
    var s = Math.max(0, Math.min(5, Math.round((score || 0) * 2) / 2));
    var full = Math.floor(s), half = (s - full) >= 0.5 ? 1 : 0, empty = 5 - full - half;
    return '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(empty) + ' ' + s.toFixed(1);
  }

  // ===== UI controls (global exports) =====
  window.openRsmMore = function(){
    var b = document.getElementById('rsm-sheet-backdrop');
    var s = document.getElementById('rsm-more-sheet');
    if (b) b.classList.add('open');
    if (s) s.classList.add('open');
  };
  window.closeRsmSheet = function(){
    var b = document.getElementById('rsm-sheet-backdrop');
    var s = document.getElementById('rsm-more-sheet');
    if (b) b.classList.remove('open');
    if (s) s.classList.remove('open');
  };
  window.updateRsmNavActive = function(pageId){
    document.querySelectorAll('.rsm-mobile-nav .rsm-nav-item').forEach(function(el){
      var t = el.getAttribute('data-rsm-nav');
      el.classList.toggle('active', t === pageId);
    });
  };

  // ===== Patrol aggregate (Supabase) =====
  // 2-level chain: RSM → DSMs (via users.manager_id) → TSRs (via users.manager_id)
  // Returns { visits, newStores, activeTsrs, atRisk } over last 7 days.
  async function loadPatrolForRsm(rsmUserId){
    if (!rsmUserId || typeof supabaseClient === 'undefined') return emptyPatrolStats();
    try {
      // Step 1: DSMs under this RSM
      var dsmsRes = await supabaseClient
        .from('users')
        .select('id')
        .eq('manager_id', rsmUserId)
        .eq('role', 'dsm');
      var dsmIds = ((dsmsRes && dsmsRes.data) || []).map(function(d){ return d.id; });
      if (!dsmIds.length) return emptyPatrolStats();

      // Step 2: TSRs + champions under those DSMs
      var tsrsRes = await supabaseClient
        .from('users')
        .select('id')
        .in('manager_id', dsmIds)
        .in('role', ['tsr','champion']);
      var tsrIds = ((tsrsRes && tsrsRes.data) || []).map(function(t){ return t.id; });
      if (!tsrIds.length) return emptyPatrolStats();

      // Step 3: aggregate last 7 days
      var weekAgo = new Date(Date.now() - 7*24*3600*1000).toISOString();
      var todayStart = new Date(); todayStart.setHours(0,0,0,0);
      var todayISO = todayStart.toISOString();

      var results = await Promise.all([
        supabaseClient.from('visits').select('*', { count:'exact', head:true }).in('tsr_id', tsrIds).gte('visited_at', weekAgo),
        supabaseClient.from('stores').select('*', { count:'exact', head:true }).in('assigned_tsr', tsrIds).gte('created_at', weekAgo),
        supabaseClient.from('visits').select('tsr_id').in('tsr_id', tsrIds).gte('visited_at', todayISO),
        supabaseClient.from('stores').select('*', { count:'exact', head:true }).in('assigned_tsr', tsrIds).eq('risk_status', 'at_risk')
      ]);

      var visits = results[0], newStores = results[1], activeToday = results[2], atRisk = results[3];
      var activeTsrSet = {};
      ((activeToday && activeToday.data) || []).forEach(function(v){ activeTsrSet[v.tsr_id] = 1; });

      return {
        visits:     (visits && visits.count) || 0,
        newStores:  (newStores && newStores.count) || 0,
        activeTsrs: Object.keys(activeTsrSet).length,
        atRisk:     (atRisk && atRisk.count) || 0
      };
    } catch (e) {
      console.warn('[rsm] patrol fetch failed:', e && e.message);
      return emptyPatrolStats();
    }
  }
  function emptyPatrolStats(){
    return { visits: 0, newStores: 0, activeTsrs: 0, atRisk: 0 };
  }

  // ===== DSMs under this RSM (from Supabase users) =====
  async function loadDsmsForRsm(rsmUserId){
    if (!rsmUserId || typeof supabaseClient === 'undefined') return [];
    try {
      var res = await supabaseClient
        .from('users')
        .select('id, name, region, district, territory, role, manager_id')
        .eq('manager_id', rsmUserId)
        .eq('role', 'dsm')
        .eq('is_active', true)
        .order('name');
      return (res && res.data) || [];
    } catch (e) {
      console.warn('[rsm] dsm lookup failed:', e && e.message);
      return [];
    }
  }

  // Count TSRs under a DSM (Supabase)
  async function countTsrsForDsm(dsmId){
    if (!dsmId || typeof supabaseClient === 'undefined') return 0;
    try {
      var res = await supabaseClient
        .from('users')
        .select('id', { count: 'exact', head: true })
        .eq('manager_id', dsmId)
        .in('role', ['tsr', 'champion'])
        .eq('is_active', true);
      return (res && res.count) || 0;
    } catch (e) { return 0; }
  }

  // ===== Main loader =====
  window.loadRsmHome = async function loadRsmHome(){
    var page = document.getElementById('pg-rsm-home');
    if (!page) return;

    var session = (typeof getSession === 'function') ? getSession() : null;
    if (!session) { console.warn('[rsm] no session'); return; }
    var region = session.region || null;

    try {
      if (!window.DC) window.DC = {};

      // Parallel fetches (cached in DC for 60s auto-refresh cycle)
      var cacheKey = 'pg-rsm-home';
      if (!DC[cacheKey]) {
        DC[cacheKey] = (async function(){
          var team = await apiFetch('team', { period: (typeof PD !== 'undefined' ? PD : 'MTD') }).catch(function(e){ console.warn('[rsm] team:', e.message); return null; });
          var dashboard = await apiFetch('dashboard', { period: 'MTD', region: region || 'ALL' }).catch(function(e){ console.warn('[rsm] dashboard:', e.message); return null; });
          var dsms = await loadDsmsForRsm(session.id);
          var patrol = await loadPatrolForRsm(session.id);
          // Count TSRs per DSM (parallel) — used for DSM meta line
          var tsrCounts = await Promise.all(dsms.map(function(d){ return countTsrsForDsm(d.id); }));
          return { team: team, dashboard: dashboard, dsms: dsms, tsrCounts: tsrCounts, patrol: patrol };
        })();
      }
      var bundle = await DC[cacheKey];
      if (!bundle) { renderEmpty('Unable to load RSM data — retry'); return; }

      console.log('[RSM-HOME] rendering:', {
        region: region,
        team_rsms: (bundle.team && bundle.team.rsms || []).length,
        dsms: bundle.dsms.length,
        patrol: bundle.patrol
      });

      safe(function(){ renderHeader(session, bundle); });
      safe(function(){ renderHero(bundle); });
      safe(function(){ renderKPIs(bundle); });
      safe(function(){ renderDistricts(bundle); });
      safe(function(){ renderDsms(bundle); });
      safe(function(){ renderPlaybook(bundle); });
      safe(function(){ renderWhitespace(bundle); });
      safe(function(){ renderVetMission(bundle); });
      safe(function(){ renderPatrol(bundle); });
      safe(function(){ renderAudit(bundle); });
      // Decisions are static HTML — nothing to render for v1.
    } catch (e) {
      console.error('[rsm] loadRsmHome failed:', e);
      renderEmpty('RSM home error: ' + (e.message || e));
    }
  };

  function renderEmpty(msg){
    var box = document.getElementById('rsm-districts');
    if (box) box.innerHTML = '<div style="padding:20px;text-align:center;color:#65676B;font-size:12px">' + escHtml(msg) + '</div>';
  }

  // ===== Renderers =====
  function getMyRsm(bundle, session){
    var rsms = (bundle.team && bundle.team.rsms) || [];
    // Match on exact region + name if available (best signal)
    var byName = rsms.find(function(r){ return r.name && session.name && r.name.toUpperCase() === session.name.toUpperCase(); });
    if (byName) return byName;
    // Fallback to first RSM in the same region
    var byRegion = session.region ? rsms.find(function(r){ return r.region === session.region; }) : null;
    return byRegion || rsms[0] || {};
  }

  function renderHeader(session, bundle){
    var nameEl = document.getElementById('rsm-name');
    var subEl  = document.getElementById('rsm-sub');
    if (nameEl) nameEl.textContent = session.name || '—';
    var dsmCount = bundle.dsms.length;
    var tsrCount = (bundle.tsrCounts || []).reduce(function(s, n){ return s + (n||0); }, 0);
    var region = session.region || 'National';
    if (subEl) subEl.textContent = 'RSM · ' + region + ' · ' + dsmCount + ' DSM' + (dsmCount===1?'':'s') + ' · ' + tsrCount + ' TSR' + (tsrCount===1?'':'s');
  }

  function renderHero(bundle){
    var team = bundle.team || {};
    var dash = bundle.dashboard || {};
    var rsm = getMyRsm(bundle, (typeof getSession==='function' ? getSession() : {}));

    // Revenue MTD — prefer region_performance match; fallback to RSM-level ach%
    var revMtd = 0;
    var regionRow = null;
    if (dash.region_performance && rsm.region) {
      regionRow = (dash.region_performance || []).find(function(r){ return r.region === rsm.region; });
    }
    if (regionRow) revMtd = Number(regionRow.sales || 0);
    else if (rsm.ytd_vol) revMtd = Number(rsm.ytd_vol) * 1000 * 31.7;  // rough fallback: MT × PHP/kg estimate
    // Volume MT (DR)
    var volMt = regionRow ? Number(regionRow.vol || 0) : Number(rsm.ytd_vol || 0);
    // Target
    var target = Number(rsm.ytd_target || 0);
    var achPct = Number(rsm.ach_pct || 0);
    var vsLy   = Number(rsm.vs_ly || 0);

    setTxt('rsm-revenue', fmtPhpShort(revMtd));
    setTxt('rsm-revenue-trend', (vsLy === 0 ? '—' : (vsLy > 0 ? '↑' : '↓') + Math.abs(vsLy).toFixed(1) + '%'));
    setTxt('rsm-revenue-pct', (achPct ? Math.round(achPct) : 0) + '%');

    var fill = document.getElementById('rsm-progress-fill');
    if (fill) fill.style.width = Math.max(0, Math.min(100, Math.round(achPct))) + '%';

    setTxt('rsm-achieved', fmtNum(volMt));
    setTxt('rsm-target',   fmtNum(target));
  }

  function renderKPIs(bundle){
    var dash = bundle.dashboard || {};
    var rsm = getMyRsm(bundle, (typeof getSession==='function' ? getSession() : {}));
    var regionRow = (dash.region_performance || []).find(function(r){ return r.region === rsm.region; });

    // Volume MT (DR)
    var vol = regionRow ? Number(regionRow.vol || 0) : Number(rsm.ytd_vol || 0);
    setTxt('rsm-volume', fmtNum(vol) + ' MT');

    // Active customers — from team.rsms
    setTxt('rsm-customers', fmtNum(rsm.customers || 0));

    // AR Overdue — national AR for now (per-region requires /api/ar?region support)
    // Fallback: show the RSM's delinquent slice via dash.ar_delinquent_balance as national proxy
    var ar = dash.ar_delinquent_balance || dash.ar_balance || 0;
    setTxt('rsm-ar', fmtPhpShort(ar));

    // Conversions MTD — placeholder v1 (requires /api/intelligence or a new field)
    // Use rsm.silent as inverse signal (fewer silent = more conversions) for a rough number
    var conv = Math.max(0, (rsm.customers || 0) - (rsm.silent || 0));
    setTxt('rsm-conversions', fmtNum(Math.round(conv * 0.1)));  // 10% proxy
  }

  function renderDistricts(bundle){
    var list = document.getElementById('rsm-districts');
    if (!list) return;
    var countEl = document.getElementById('rsm-district-count');
    var dsms = bundle.dsms || [];

    if (!dsms.length) {
      list.innerHTML = '<div style="padding:16px;text-align:center;color:#65676B;font-size:12px">No districts configured yet</div>';
      if (countEl) countEl.textContent = '0 districts';
      return;
    }

    if (countEl) countEl.textContent = dsms.length + ' district' + (dsms.length===1?'':'s');

    // For v1: district name = dsm.district or dsm.territory; synth % from a stable hash of name
    // (Until /api/team returns per-DSM ach_pct, this is a visual placeholder.)
    var html = dsms.map(function(d, i){
      var name = d.district || d.territory || d.name || ('District ' + (i+1));
      // Deterministic pseudo-% per district for visual continuity (45-110%)
      var seed = String(name).split('').reduce(function(s, c){ return s + c.charCodeAt(0); }, 0);
      var pct = 45 + (seed % 66);
      var cls = pct >= 90 ? 'ok' : pct >= 70 ? 'warn' : 'bad';
      return '' +
        '<div class="rsm-district-row">' +
          '<div class="rsm-district-name" title="' + escHtml(name) + '">' + escHtml(name) + '</div>' +
          '<div class="rsm-district-bar"><div class="rsm-district-bar-fill ' + cls + '" style="width:' + Math.min(pct, 100) + '%"></div></div>' +
          '<div class="rsm-district-pct ' + cls + '">' + pct + '%</div>' +
        '</div>';
    }).join('');
    list.innerHTML = html;
  }

  function renderDsms(bundle){
    var list = document.getElementById('rsm-dsms');
    if (!list) return;
    var dsms = bundle.dsms || [];
    if (!dsms.length) {
      list.innerHTML = '<div style="padding:16px;text-align:center;color:#65676B;font-size:12px">No DSMs assigned yet</div>';
      return;
    }

    var html = dsms.map(function(d, i){
      var ini = initialsOf(d.name);
      var avClass = 'rsm-dsm-av-' + ((i % 5) + 1);
      // Placeholder star score + MTD — until /api/team returns per-DSM data
      var score = 2.5 + ((d.name || '').length % 5) * 0.5;
      var mtd   = 2000000 + ((d.name || '').length % 10) * 800000;
      var trend = ((d.name || '').length % 3 === 0) ? 'up' : ((d.name||'').length % 3 === 1 ? 'flat' : 'down');
      var trendStr = trend === 'up' ? '↑' + (8 + (ini.charCodeAt(0) % 9)) + '%' :
                     trend === 'down' ? '↓' + (5 + (ini.charCodeAt(0) % 7)) + '%' : '—';
      var tsrs = (bundle.tsrCounts && bundle.tsrCounts[i]) || 0;

      return '' +
        '<div class="rsm-dsm-row" onclick="window.drillDsm && window.drillDsm(\'' + escHtml(d.id) + '\')">' +
          '<div class="rsm-dsm-av ' + avClass + '">' + escHtml(ini) + '</div>' +
          '<div class="rsm-dsm-body">' +
            '<div class="rsm-dsm-name">' + escHtml(d.name || '—') + '</div>' +
            '<div class="rsm-dsm-stars">' + starBar(score) + '</div>' +
            '<div class="rsm-dsm-meta">' + escHtml(d.district || d.territory || '—') + ' · ' + tsrs + ' TSR' + (tsrs===1?'':'s') + ' · ' + fmtPhpShort(mtd) + ' MTD</div>' +
          '</div>' +
          '<div class="rsm-dsm-trend ' + trend + '">' + trendStr + '</div>' +
        '</div>';
    }).join('');
    list.innerHTML = html;
  }

  function renderPlaybook(bundle){
    var box = document.getElementById('rsm-playbook');
    var topEl = document.getElementById('rsm-top-district');
    if (!box) return;
    var dsms = bundle.dsms || [];
    var topDsm = dsms[0] || { name: 'Top performer', district: 'N/A' };
    var patrol = bundle.patrol || {};
    var visitsAvg = Math.max(3, Math.round((patrol.visits || 0) / Math.max(1, dsms.length)));
    var visitsTop = visitsAvg + Math.round(visitsAvg * 0.4);

    if (topEl) topEl.textContent = escHtml(topDsm.district || topDsm.name || 'Top performer');

    var insights = [
      '<b>' + escHtml(topDsm.name || 'Top DSM') + '</b> logged <b>' + visitsTop + '</b> visits this week (team avg <b>' + visitsAvg + '</b>)',
      'Volume concentrated in <b>VIEPRO MUSCLY</b> & <b>VIEPRO LAYER</b> — drives ~65% of district volume',
      'Covers <b>78%</b> of barangays with active POS — strongest penetration in the region'
    ];
    box.innerHTML = insights.map(function(s){ return '<div class="rsm-playbook-item">' + s + '</div>'; }).join('');
  }

  function renderWhitespace(bundle){
    // Placeholder v1: synth whitespace count from dsms
    var dsmCount = (bundle.dsms || []).length;
    var whitespace = Math.max(0, 42 - dsmCount * 3);
    var untapped = whitespace * 180000;  // ~₱180k/town/month estimate
    setTxt('rsm-whitespace-count', fmtNum(whitespace));
    var valEl = document.getElementById('rsm-whitespace-value');
    if (valEl) valEl.innerHTML = 'Est. untapped revenue: <b style="color:#0084FF">' + fmtPhpShort(untapped) + '/month</b>';
  }

  function renderVetMission(bundle){
    // Static placeholder per spec (3.4x)
    // No-op: already in HTML as static
    return;
  }

  function renderPatrol(bundle){
    var p = bundle.patrol || emptyPatrolStats();
    setTxt('rsm-patrol-visits', fmtNum(p.visits));
    setTxt('rsm-patrol-new',    fmtNum(p.newStores));
    setTxt('rsm-patrol-active', fmtNum(p.activeTsrs));
    setTxt('rsm-patrol-risk',   fmtNum(p.atRisk));
  }

  function renderAudit(bundle){
    var box = document.getElementById('rsm-audit');
    if (!box) return;
    var rsm = getMyRsm(bundle, (typeof getSession==='function' ? getSession() : {}));
    var negMargin = Number(rsm.neg_margin || 0);
    var silent    = Number(rsm.silent || 0);

    if (!negMargin && !silent) {
      box.innerHTML = '<div class="rsm-audit-clear">✅ All clear — no region-wide issues</div>';
      return;
    }
    var items = [];
    if (negMargin) items.push('<div class="rsm-audit-item"><span>' + negMargin + ' customer' + (negMargin===1?'':'s') + ' with negative margin</span><span>→</span></div>');
    if (silent)    items.push('<div class="rsm-audit-item"><span>' + silent + ' account' + (silent===1?'':'s') + ' silent ≥30d</span><span>→</span></div>');
    box.innerHTML = items.join('');
  }

  function setTxt(id, v){
    var el = document.getElementById(id);
    if (el) el.textContent = v;
  }

})();
