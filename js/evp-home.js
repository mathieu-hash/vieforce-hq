// ============================================================================
// EVP MOBILE HOME — Sprint B-EVP Day 1
// Loads existing /api/{dashboard,sales,ar,margin,team} into the EVP page.
// Render fns are defensive — fall back to sane literals if a field is missing,
// so the page never goes blank (Mat's primary device is iPhone; first-paint matters).
// ============================================================================

(function(){
  var EVP_STATE = { loaded: false, data: null };

  // --- Helpers ---------------------------------------------------------------
  function $(id){ return document.getElementById(id); }
  function fmt(v, d){ if(v===undefined||v===null||isNaN(v)) return d; return v; }
  function fmtMT(v){
    if(!v) return '0';
    if(v>=1000) return (v/1000).toFixed(1)+'K';
    return Math.round(v).toString();
  }
  function fmtPHP(v){
    if(!v) return '₱0';
    if(v>=1e9) return '₱'+(v/1e9).toFixed(2)+'B';
    if(v>=1e6) return '₱'+(v/1e6).toFixed(1)+'M';
    if(v>=1e3) return '₱'+(v/1e3).toFixed(1)+'K';
    return '₱'+Math.round(v);
  }
  function fmtClock(){
    var d = new Date();
    var h = d.getHours(), m = String(d.getMinutes()).padStart(2,'0');
    var ampm = h>=12 ? 'PM' : 'AM';
    h = h%12 || 12;
    var mons = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return mons[d.getMonth()]+' '+d.getDate()+', '+h+':'+m+' '+ampm;
  }
  function greetingFor(){
    var h = new Date().getHours();
    if(h<5)  return 'Still up';
    if(h<12) return 'Good morning';
    if(h<18) return 'Good afternoon';
    return 'Good evening';
  }

  // --- Main loader ------------------------------------------------------------
  async function loadEvpHome(){
    var session = (typeof getSession==='function') ? getSession() : null;

    // Greet header (no API needed)
    var firstName = session && session.name ? session.name.split(/\s+/)[0] : 'Mat';
    var greet = $('evp-hdr-time');
    if(greet) greet.textContent = greetingFor()+', '+firstName+' 🌅';
    var sub = $('evp-hdr-sub');
    if(sub) sub.textContent = '● LIVE · '+fmtClock();

    // Fire all 5 API calls in parallel — each is independent for graceful partial render
    var calls;
    // Topbar scope: period + ref_month + region/segment. Prefer the canonical
    // vfApiParams() builder so the EVP page honors the same scope as desktop pages.
    var _p;
    if (typeof vfApiParams === 'function') {
      _p = vfApiParams();
    } else {
      var _pd = (typeof PD !== 'undefined' && PD) ? PD : 'MTD';
      var _rm = (typeof VF_REF_MONTH !== 'undefined' && VF_REF_MONTH && /^\d{4}-\d{2}$/.test(VF_REF_MONTH)) ? VF_REF_MONTH : undefined;
      var _rg = (typeof RG !== 'undefined' && RG) ? RG : 'ALL';
      var _seg = (typeof SEG !== 'undefined' && SEG) ? SEG : 'ALL';
      _p = { period: _pd, region: _rg, segment: _seg };
      if(_rm) _p.ref_month = _rm;
    }
    try{
      calls = await Promise.all([
        (typeof getDashboardData==='function'  ? getDashboardData(_p)  : Promise.resolve(null)).catch(function(e){console.error('[EVP] dash:',e);return null}),
        (typeof getSalesData==='function'      ? getSalesData(_p)      : Promise.resolve(null)).catch(function(e){console.error('[EVP] sales:',e);return null}),
        (typeof getARData==='function'         ? getARData()                       : Promise.resolve(null)).catch(function(e){console.error('[EVP] ar:',e);return null}),
        (typeof getMarginData==='function'     ? getMarginData(_p)     : Promise.resolve(null)).catch(function(e){console.error('[EVP] margin:',e);return null}),
        (typeof getTeamData==='function'       ? getTeamData(_p)                     : Promise.resolve(null)).catch(function(e){console.error('[EVP] team:',e);return null})
      ]);
    } catch(err){
      console.error('[EVP] fatal load error:', err);
      calls = [null,null,null,null,null];
    }
    var dash = calls[0], sales = calls[1], ar = calls[2], margin = calls[3], team = calls[4];
    EVP_STATE.data = { dash: dash, sales: sales, ar: ar, margin: margin, team: team };
    EVP_STATE.loaded = true;

    // Render each section — wrapped in try so one broken card doesn't kill the rest
    try { renderEvpHero(dash); }          catch(e){ console.error('[EVP] hero:',e); }
    try { renderEvpPnl(dash, sales, margin); } catch(e){ console.error('[EVP] pnl:',e); }
    try { renderEvpRegions(dash); }       catch(e){ console.error('[EVP] regions:',e); }
    try { renderEvpRisks(dash, ar, margin); } catch(e){ console.error('[EVP] risks:',e); }
    try { renderEvpOpps(dash, team, margin); } catch(e){ console.error('[EVP] opps:',e); }
    try { renderEvpPerformers(team, dash); } catch(e){ console.error('[EVP] performers:',e); }
  }

  // --- Renderers --------------------------------------------------------------
  function renderEvpHero(d){
    // 2033 journey = YTD MT against 1,000,000 MT
    var ytdMt = (d && d.ytd && d.ytd.volume_mt) || (d && d.volume_ytd_mt) || 0;
    var target = 1000000;
    var progress = (ytdMt/target)*100;

    // Required pace = fraction of year elapsed * 100
    var now = new Date();
    var yearStart = new Date(now.getFullYear(),0,1);
    var yearEnd   = new Date(now.getFullYear(),11,31,23,59,59);
    var requiredPace = ((now - yearStart)/(yearEnd - yearStart))*100;

    var ytdEl = $('evp-ytd-mt');      if(ytdEl) ytdEl.textContent = fmtMT(ytdMt);
    var fillEl = $('evp-journey-fill'); if(fillEl) fillEl.style.width = Math.min(progress,100).toFixed(2)+'%';
    var paceEl = $('evp-journey-pace'); if(paceEl) paceEl.style.left  = Math.min(requiredPace,100).toFixed(2)+'%';
    var pctEl  = $('evp-pace-pct');     if(pctEl)  pctEl.textContent  = progress.toFixed(1)+'% of target';

    var behind = requiredPace - progress;
    var warn = $('evp-pace-warning');
    if(warn){
      if(behind > 2){
        warn.innerHTML = '⚠️ '+behind.toFixed(1)+'% behind 2033 pace · <b>Action required</b>';
        warn.style.color = '#FFC72C';
      } else if(behind > 0){
        warn.textContent = '📊 Slightly behind pace · Monitor closely';
        warn.style.color = '#FFC72C';
      } else {
        warn.textContent = '✅ On or ahead of 2033 pace';
        warn.style.color = '#95C93D';
      }
    }
  }

  function renderEvpPnl(dash, sales, margin){
    // Revenue (MTD) — dashboard.revenue
    var rev = (dash && dash.revenue) || 0;
    var revEl = $('evp-revenue'); if(revEl) revEl.textContent = fmtPHP(rev);

    var revDelta = (dash && dash.delta_pct && dash.delta_pct.revenue) || 0;
    var revLbl = 'vs PP';
    if (typeof CMP === 'string' && CMP === 'vs_ly' && dash && dash.delta_pct_ly && dash.delta_pct_ly.revenue != null && dash.delta_pct_ly.revenue !== undefined) {
      revDelta = dash.delta_pct_ly.revenue;
      revLbl = 'vs LY';
    }
    var revTrendEl = $('evp-revenue-trend');
    if(revTrendEl){
      var arrow = revDelta>=0 ? '↑' : '↓';
      revTrendEl.textContent = arrow+' '+Math.abs(revDelta).toFixed(1)+'% '+revLbl;
      revTrendEl.className = 'evp-pnl-trend '+(revDelta>=0?'up':'down');
    }

    // GM % — margin.national_gp_pct preferred; fallback derived
    var gmPct = (margin && margin.kpis && margin.kpis.natl_gp_pct) || (margin && margin.national_gp_pct) || (margin && margin.summary && margin.summary.gp_pct);
    if(gmPct===undefined || gmPct===null){
      var gm = dash && dash.gross_margin, r = dash && dash.revenue;
      if(gm && r) gmPct = (gm/r)*100;
    }
    var gmPctEl = $('evp-gm-pct'); if(gmPctEl) gmPctEl.textContent = (gmPct!=null) ? gmPct.toFixed(1)+'%' : '—';
    // GM% is a RATE. The available delta (dash.delta_pct.gross_margin) is the
    // period-over-period change of ABSOLUTE peso GM, not of the rate — showing it
    // next to a rate is misleading (can read "↑15%" while the rate is flat). No
    // GM%-basis delta is in the payload, so drop the arrow entirely.
    var gmTrendEl = $('evp-gm-trend');
    if(gmTrendEl){ gmTrendEl.textContent = ''; gmTrendEl.className = 'evp-pnl-trend'; }

    // Volume MT
    var vol = (dash && dash.volume_mt) || 0;
    var volEl = $('evp-volume'); if(volEl) volEl.textContent = fmtMT(vol);

    // GM / Ton
    var gmton = (dash && dash.gmt) || 0;
    var gmtEl = $('evp-gmton'); if(gmtEl) gmtEl.textContent = gmton ? '₱'+Math.round(gmton).toLocaleString() : '—';
  }

  function renderEvpRegions(dash){
    // Live region_performance only — no regional targets exist in SAP, so show
    // the REAL growth metric (vs PP / vs LY per the compare toggle), not a
    // fixed-weight modeled "achievement %".
    var src = (dash && dash.region_performance) || [];
    var useLy = (typeof CMP === 'string' && CMP === 'vs_ly');
    var sub = $('evp-regions-sub'); if(sub) sub.textContent = useLy ? 'Volume vs LY' : 'Volume vs PP';

    var el = $('evp-regions');
    if(!src.length){
      if(el) el.innerHTML = '<div style="padding:12px;text-align:center;color:#65676B;font-size:12px">No regional data for this period</div>';
      return;
    }

    var rows = src.map(function(r){
      var raw = useLy ? r.vs_ly : r.vs_pp;
      if(useLy && (raw == null || raw === '')) raw = r.vs_pp;
      return { name:(r.region||'?').toUpperCase(), volume:r.vol||0, pct:(raw==null||raw==='')?null:Number(raw) };
    });

    var html = rows.map(function(r){
      var pct = r.pct;
      var color = pct==null   ? '#65676B' :
                  pct>=10     ? '#31A24C' :
                  pct>=0      ? '#0084FF' :
                  pct>=-10    ? '#F7B928' : '#FA383E';
      var emoji = pct!=null && pct>=20 ? '🔥 ' : (pct!=null && pct<=-20 ? '🔻 ' : '');
      var w = pct==null ? 0 : Math.min(Math.abs(pct),100);
      var lbl = pct==null ? '—' : (pct>0?'+':'')+pct.toFixed(0)+'%';
      return '<div class="evp-region-row">' +
        '<div class="evp-region-name">'+emoji+r.name+'</div>' +
        '<div class="evp-region-bar"><div class="evp-region-fill" style="width:'+w.toFixed(0)+'%;background:'+color+'"></div></div>' +
        '<div class="evp-region-pct" style="color:'+color+'">'+lbl+'</div>' +
      '</div>';
    }).join('');

    if(el) el.innerHTML = html;
  }

  function renderEvpRisks(dash, ar, margin){
    var risks = [];

    // 1 · AR aging >60d
    var bOld = 0;
    if(ar && ar.buckets){
      var b = ar.buckets;
      bOld = (b.d61_90||0) + (b.d91_120||0) + (b.d121_365||0) + (b.over_1y||0);
    }
    if(bOld > 1000000){
      risks.push({
        title: 'AR aging >60d: ₱'+(bOld/1e6).toFixed(1)+'M',
        detail: 'Review top delinquent customers'
      });
    }

    // 2 · Critical margin customers (negative GP)
    var critCount = (margin && margin.kpis && margin.kpis.critical) ||
                    (margin && margin.hero && margin.hero.critical_count) ||
                    (margin && margin.summary && margin.summary.critical) || 0;
    if(critCount > 0){
      risks.push({
        title: critCount+' customers at negative GP',
        detail: 'Re-price or exit exposure'
      });
    }

    // 3 · Region declining sharply (real vs-LY, fallback vs-PP — no modeled targets)
    var regions = (dash && dash.region_performance) || [];
    for(var i=0;i<regions.length;i++){
      var r = regions[i];
      var hasLy = (r.vs_ly != null && r.vs_ly !== '');
      var raw = hasLy ? Number(r.vs_ly) : ((r.vs_pp != null && r.vs_pp !== '') ? Number(r.vs_pp) : null);
      var lbl = hasLy ? 'vs LY' : 'vs PP';
      if(raw != null && raw < -10 && risks.length < 3){
        risks.push({
          title: r.region+' down '+Math.abs(raw).toFixed(0)+'% '+lbl,
          detail: 'Volume declining — intervention needed'
        });
      }
    }

    // 4 · Pending PO aging (fallback filler if still <3)
    if(risks.length < 3 && dash && dash.pending_po && dash.pending_po.oldest_days > 30){
      risks.push({
        title: 'Oldest open PO '+dash.pending_po.oldest_days+' days old',
        detail: 'Fulfill or cancel stale orders'
      });
    }

    // Final literal fill if still empty
    while(risks.length < 3){
      risks.push({ title:'— no additional risks flagged —', detail:'' });
    }
    risks = risks.slice(0,3);

    var html = risks.map(function(r,i){
      return '<div class="evp-radar-item">' +
        '<div class="evp-radar-num">'+(i+1)+'</div>' +
        '<div><b>'+r.title+'</b>'+(r.detail?' — '+r.detail:'')+'</div>' +
      '</div>';
    }).join('');
    var el = $('evp-risks'); if(el) el.innerHTML = html;
  }

  function renderEvpOpps(dash, team, margin){
    // Real signals only — derived from live region/margin/customer data.
    // (Old hardcoded "white-space / upsell / playbook" bets were fabricated.)
    var opps = [];

    // 1 · Fastest-growing region vs LY
    var regions = (dash && dash.region_performance) || [];
    if(regions.length){
      var best = regions.slice().sort(function(a,b){ return Number(b.vs_ly||0) - Number(a.vs_ly||0); })[0];
      if(best && best.vs_ly != null && Number(best.vs_ly) > 0){
        opps.push({
          title: 'Ride '+best.region+' momentum',
          detail: '+'+Number(best.vs_ly).toFixed(0)+'% vs LY · '+fmtMT(best.vol)+' MT'
        });
      }
    }

    // 2 · Best-GP region (margin KPIs)
    var bestRg = margin && margin.kpis && margin.kpis.best_region;
    if(bestRg && bestRg.name){
      opps.push({
        title: 'Best GP region: '+bestRg.name,
        detail: (bestRg.gp_pct != null) ? Number(bestRg.gp_pct).toFixed(1)+'% GP — replicate mix' : ''
      });
    }

    // 3 · Top customer this period
    if(dash && dash.top_customers && dash.top_customers.length){
      var t = dash.top_customers[0];
      opps.push({
        title: 'Top customer: '+(t.name||t.code),
        detail: fmtMT(t.vol)+' MT · '+fmtPHP(t.revenue)+' — protect & upsell'
      });
    }

    if(!opps.length) opps.push({ title:'— no opportunities computed —', detail:'' });
    opps = opps.slice(0,3);

    var html = opps.map(function(o,i){
      return '<div class="evp-radar-item">' +
        '<div class="evp-radar-num">'+(i+1)+'</div>' +
        '<div><b>'+o.title+'</b>'+(o.detail?' — '+o.detail:'')+'</div>' +
      '</div>';
    }).join('');
    var el = $('evp-opps'); if(el) el.innerHTML = html;
  }

  function renderEvpPerformers(team, dash){
    // Extract from team.rsm_scorecard if present; else fallbacks
    var topRegion = null, topRsm = null;
    if(dash && dash.region_performance && dash.region_performance.length){
      var sorted = dash.region_performance.slice().sort(function(a,b){return (b.vol||0)-(a.vol||0);});
      topRegion = sorted[0];
    }
    if(team && team.rsm_scorecard && team.rsm_scorecard.length){
      var rsmSorted = team.rsm_scorecard.slice().sort(function(a,b){return (b.ytd_vol||0)-(a.ytd_vol||0);});
      topRsm = rsmSorted[0];
    } else if(team && team.rsms && team.rsms.length){
      var rsmSorted2 = team.rsms.slice().sort(function(a,b){return (b.ytd_vol||0)-(a.ytd_vol||0);});
      topRsm = rsmSorted2[0];
    }

    // Top district = best DSM territory across all RSMs (real /api/team rollup)
    var topDsm = null;
    if(team && team.rsms){
      team.rsms.forEach(function(r){
        (r.dsms||[]).forEach(function(d){
          if(!topDsm || (d.ytd_vol||0) > (topDsm.ytd_vol||0)) topDsm = d;
        });
      });
    }
    var topDsmVal = '—';
    if(topDsm){
      topDsmVal = topDsm.name+' · '+fmtMT(topDsm.ytd_vol)+' MT';
      if(topDsm.vs_pp_pct != null){
        topDsmVal += ' ('+(topDsm.vs_pp_pct>0?'+':'')+Number(topDsm.vs_pp_pct).toFixed(0)+'% vs PP)';
      }
    }

    var rows = [
      { label: '🥇 Region', value: topRegion ? (topRegion.region+' ('+fmtMT(topRegion.vol)+' MT MTD)') : '—' },
      { label: '🥇 RSM',    value: topRsm    ? ((topRsm.rsm||topRsm.name)+' · '+fmtMT(topRsm.ytd_vol)+' MT YTD') : '—' },
      { label: '🥇 District', value: topDsmVal }
    ];
    var html = rows.map(function(p){
      return '<div class="evp-performer-row">' +
        '<div class="evp-performer-label">'+p.label+'</div>' +
        '<div class="evp-performer-value">'+p.value+'</div>' +
      '</div>';
    }).join('');
    var el = $('evp-performers'); if(el) el.innerHTML = html;
  }

  // --- More-menu bottom sheet -------------------------------------------------
  // Scroll lock is handled in releaseScrollLock() so there is ONE authoritative
  // reset. Any code path (closeEvpSheet, navTo, page unload, etc.) that may leave
  // body overflow stuck calls releaseScrollLock() to guarantee scrollability.
  function releaseScrollLock(){
    document.body.classList.remove('evp-sheet-open');
    document.body.style.overflow = '';
    document.body.style.position = '';
    document.body.style.top = '';
    document.documentElement.style.overflow = '';
  }
  function openEvpMore(){
    var sheet = $('evp-more-sheet');
    var bd    = $('evp-sheet-backdrop');
    if(sheet) sheet.classList.add('open');
    if(bd)    bd.classList.add('open');
    document.body.classList.add('evp-sheet-open');
  }
  function closeEvpSheet(){
    var sheet = $('evp-more-sheet');
    var bd    = $('evp-sheet-backdrop');
    if(sheet) sheet.classList.remove('open');
    if(bd)    bd.classList.remove('open');
    releaseScrollLock();
  }
  // Belt-and-suspenders: also release on history nav + visibility change
  window.addEventListener('pageshow',         releaseScrollLock);
  window.addEventListener('visibilitychange', releaseScrollLock);

  // --- Bottom-nav active-state sync -------------------------------------------
  // navTo() calls this after every page change. Highlights the matching nav item,
  // or "More" when the current page isn't one of the 4 primary tabs.
  function updateEvpNavActive(pageId){
    var items = document.querySelectorAll('.evp-mobile-nav-global .evp-nav-item');
    if(!items || !items.length) return;
    var primaryMap = { 'pg-evp-home':'pg-evp-home', 'pg-budget':'pg-budget',
                       'pg-margin':'pg-margin',     'pg-team':'pg-team' };
    var tag = primaryMap[pageId] || 'more';
    for(var i=0;i<items.length;i++){
      if(items[i].getAttribute('data-evp-nav') === tag) items[i].classList.add('active');
      else                                              items[i].classList.remove('active');
    }
  }

  // ESC closes the sheet when open
  document.addEventListener('keydown', function(e){
    if(e.key === 'Escape'){ closeEvpSheet(); }
  });

  // Expose globally for onclick handlers + navTo integration
  window.loadEvpHome        = loadEvpHome;
  window.openEvpMore        = openEvpMore;
  window.closeEvpSheet      = closeEvpSheet;
  window.releaseScrollLock  = releaseScrollLock;
  window.updateEvpNavActive = updateEvpNavActive;
  window.EVP_STATE          = EVP_STATE;
})();
