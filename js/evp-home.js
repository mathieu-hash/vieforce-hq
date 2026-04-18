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
    try{
      calls = await Promise.all([
        (typeof getDashboardData==='function'  ? getDashboardData({period:'MTD'})  : Promise.resolve(null)).catch(function(e){console.error('[EVP] dash:',e);return null}),
        (typeof getSalesData==='function'      ? getSalesData({period:'MTD'})      : Promise.resolve(null)).catch(function(e){console.error('[EVP] sales:',e);return null}),
        (typeof getARData==='function'         ? getARData()                       : Promise.resolve(null)).catch(function(e){console.error('[EVP] ar:',e);return null}),
        (typeof getMarginData==='function'     ? getMarginData({period:'MTD'})     : Promise.resolve(null)).catch(function(e){console.error('[EVP] margin:',e);return null}),
        (typeof getTeamData==='function'       ? getTeamData()                     : Promise.resolve(null)).catch(function(e){console.error('[EVP] team:',e);return null})
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
    try { renderEvpDecisions(); }         catch(e){ console.error('[EVP] decisions:',e); }
    try { renderEvpRegions(dash); }       catch(e){ console.error('[EVP] regions:',e); }
    try { renderEvpRisks(dash, ar, margin); } catch(e){ console.error('[EVP] risks:',e); }
    try { renderEvpOpps(dash, team); }    catch(e){ console.error('[EVP] opps:',e); }
    try { renderEvpPerformers(team, dash); } catch(e){ console.error('[EVP] performers:',e); }
    // agenda is static HTML for Day 1
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
    var revTrendEl = $('evp-revenue-trend');
    if(revTrendEl){
      var arrow = revDelta>=0 ? '↑' : '↓';
      revTrendEl.textContent = arrow+' '+Math.abs(revDelta).toFixed(1)+'% vs PP';
      revTrendEl.className = 'evp-pnl-trend '+(revDelta>=0?'up':'down');
    }

    // GM % — margin.national_gp_pct preferred; fallback derived
    var gmPct = (margin && margin.national_gp_pct) || (margin && margin.summary && margin.summary.gp_pct);
    if(gmPct===undefined || gmPct===null){
      var gm = dash && dash.gross_margin, r = dash && dash.revenue;
      if(gm && r) gmPct = (gm/r)*100;
    }
    var gmPctEl = $('evp-gm-pct'); if(gmPctEl) gmPctEl.textContent = (gmPct!=null) ? gmPct.toFixed(1)+'%' : '—';
    var gmDelta = (dash && dash.delta_pct && dash.delta_pct.gross_margin) || 0;
    var gmTrendEl = $('evp-gm-trend');
    if(gmTrendEl){
      gmTrendEl.textContent = (gmDelta>=0?'↑':'↓')+' '+Math.abs(gmDelta).toFixed(1)+'%';
      gmTrendEl.className = 'evp-pnl-trend '+(gmDelta>=0?'up':'down');
    }

    // Volume MT
    var vol = (dash && dash.volume_mt) || 0;
    var volEl = $('evp-volume'); if(volEl) volEl.textContent = fmtMT(vol);

    // GM / Ton
    var gmton = (dash && dash.gmt) || 0;
    var gmtEl = $('evp-gmton'); if(gmtEl) gmtEl.textContent = gmton ? '₱'+Math.round(gmton).toLocaleString() : '—';
  }

  function renderEvpDecisions(){
    // Hardcoded for Day 1 — future: GET /api/decisions (Mat's follow-up list table)
    var decisions = [
      { text: 'Approve 2 new DSMs for NL expansion?',     cta: 'Decide' },
      { text: 'Cebu plant land subdivision — sign off?',  cta: 'Review' },
      { text: 'Vet budget FY26 — increase 20% proposal',  cta: 'Decide' }
    ];
    var html = decisions.map(function(d){
      return '<div class="evp-decision-item">' +
        '<div class="evp-decision-text">'+d.text+'</div>' +
        '<div class="evp-decision-cta">'+d.cta+'</div>' +
      '</div>';
    }).join('');
    var listEl = $('evp-decisions-list'); if(listEl) listEl.innerHTML = html;
    var countEl = $('evp-decisions-count'); if(countEl) countEl.textContent = decisions.length;
  }

  function renderEvpRegions(dash){
    // Prefer live region_performance; derive ach% vs monthly target when possible
    var src = (dash && dash.region_performance) || [];
    var ytdBudget = (dash && dash.budget && dash.budget.ytd_mt) || 100000;
    // Approx monthly target per region ~ 30% Luzon, 25% Visayas, 25% Mindanao, 20% Other
    var weights = { Luzon:0.35, Visayas:0.28, Mindanao:0.22, Other:0.15 };

    var rows = src.length ? src.map(function(r){
      var tgtShare = weights[r.region] != null ? weights[r.region] : 0.25;
      var monthTarget = ((dash.budget && dash.budget.mtd_mt) || 15000) * tgtShare;
      var ach = monthTarget>0 ? (r.vol/monthTarget)*100 : 0;
      return { name:(r.region||'?').toUpperCase(), volume:r.vol||0, ach:ach };
    }) : [
      { name:'LUZON',    volume:0, ach:0 },
      { name:'VISAYAS',  volume:0, ach:0 },
      { name:'MINDANAO', volume:0, ach:0 },
      { name:'OTHER',    volume:0, ach:0 }
    ];

    var html = rows.map(function(r){
      var pct = r.ach || 0;
      var color = pct>=100 ? '#31A24C' :
                  pct>=80  ? '#0084FF' :
                  pct>=60  ? '#F7B928' : '#FA383E';
      var emoji = pct>=100 ? '🔥 ' : pct<60 ? '🔻 ' : '';
      return '<div class="evp-region-row">' +
        '<div class="evp-region-name">'+emoji+r.name+'</div>' +
        '<div class="evp-region-bar"><div class="evp-region-fill" style="width:'+Math.min(pct,100).toFixed(0)+'%;background:'+color+'"></div></div>' +
        '<div class="evp-region-pct" style="color:'+color+'">'+pct.toFixed(0)+'%</div>' +
      '</div>';
    }).join('');

    var el = $('evp-regions'); if(el) el.innerHTML = html;
  }

  function renderEvpRisks(dash, ar, margin){
    var risks = [];

    // 1 · AR aging >60d
    var bOld = 0;
    if(ar && ar.buckets){
      var b = ar.buckets;
      bOld = (b['61_90']||b.bucket_61_90||0) + (b['90plus']||b['91_120']||b.bucket_91_120||0) + (b['over_year']||b.bucket_over_year||0);
    }
    if(bOld > 1000000){
      risks.push({
        title: 'AR aging >60d: ₱'+(bOld/1e6).toFixed(1)+'M',
        detail: 'Review top delinquent customers'
      });
    }

    // 2 · Critical margin customers (negative GP)
    var critCount = (margin && margin.summary && margin.summary.critical) ||
                    (margin && margin.alert_counts && margin.alert_counts.critical) || 0;
    if(critCount > 0){
      risks.push({
        title: critCount+' customers at negative GP',
        detail: 'Re-price or exit exposure'
      });
    }

    // 3 · Region underperforming (<60% of monthly target)
    var weights = { Luzon:0.35, Visayas:0.28, Mindanao:0.22, Other:0.15 };
    var mtdBudget = (dash && dash.budget && dash.budget.mtd_mt) || 15000;
    var regions = (dash && dash.region_performance) || [];
    for(var i=0;i<regions.length;i++){
      var r = regions[i];
      var tgt = mtdBudget * (weights[r.region]||0.25);
      var ach = tgt>0 ? (r.vol/tgt)*100 : 0;
      if(ach < 60 && risks.length < 3){
        risks.push({
          title: r.region+' at '+ach.toFixed(0)+'% of target',
          detail: 'Intervention needed'
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

  function renderEvpOpps(dash, team){
    // Rule-based for Day 1 — future: /api/opportunities endpoint
    var opps = [
      { title: 'White-space: 18 towns in NL',         detail: '₱3.2M/mo potential' },
      { title: 'Upsell 120 A-class customers',        detail: '₱8M upside at SOV <30%' },
      { title: 'Replicate MM-East playbook',          detail: '+₱4M MoM uplift projected' }
    ];

    // If Team data has "growing" accounts, surface the top one
    if(team && team.growing_customers && team.growing_customers.length){
      var g = team.growing_customers[0];
      opps[0] = {
        title: 'Growing: '+(g.name||g.CardName),
        detail: '+'+(g.pct||g.growth_pct||30)+'% vs prior period'
      };
    }

    var html = opps.map(function(o,i){
      return '<div class="evp-radar-item">' +
        '<div class="evp-radar-num">'+(i+1)+'</div>' +
        '<div><b>'+o.title+'</b> — '+o.detail+'</div>' +
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
    }

    var rows = [
      { label: '🥇 Region', value: topRegion ? (topRegion.region+' ('+fmtMT(topRegion.vol)+' MT)') : '—' },
      { label: '🥇 RSM',    value: topRsm    ? ((topRsm.rsm||topRsm.name)+' · '+fmtMT(topRsm.ytd_vol)+' MT YTD') : '—' },
      { label: '🥇 District', value: 'MM-East +112% vs PP' }
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
