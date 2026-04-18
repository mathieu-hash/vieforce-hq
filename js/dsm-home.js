// VieForce HQ — DSM Mobile Home
// Loader + renderers for #pg-dsm-home. Reads /api/dsm/home (SAP + Patrol).
// Uses helpers from app.html scope: fc, fcn, esc, animateNumber, navTo, PG, DC.

(function(){

  function safe(fn){ try { return fn(); } catch(e){ console.error('[dsm]', e); } }

  // Short PHP format for hero values
  function fmtPhpShort(n){
    var v = Number(n || 0);
    var abs = Math.abs(v);
    if (abs >= 1e9) return '₱' + (v/1e9).toFixed(1) + 'B';
    if (abs >= 1e6) return '₱' + (v/1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return '₱' + Math.round(v/1e3) + 'K';
    return '₱' + Math.round(v);
  }
  function fmtPhp(n){
    if (typeof fc === 'function') return fc(n);
    return '₱' + Number(n||0).toLocaleString('en-PH');
  }
  function fmtNum(n){
    if (typeof fcn === 'function') return fcn(n);
    return Number(n||0).toLocaleString('en-PH');
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

  // Patrol APK URL placeholder — Mat can update once deep link is decided
  window.openPatrolApp = window.openPatrolApp || function(){
    var url = 'https://vieforce-patrol.vercel.app';
    window.open(url, '_blank', 'noopener');
  };
  // "More" sheet open/close
  window.openDsmMore = function(){
    document.getElementById('dsm-sheet-backdrop').classList.add('open');
    document.getElementById('dsm-more-sheet').classList.add('open');
  };
  window.closeDsmSheet = function(){
    document.getElementById('dsm-sheet-backdrop').classList.remove('open');
    document.getElementById('dsm-more-sheet').classList.remove('open');
  };
  // Bottom-nav active-state sync
  window.updateDsmNavActive = function(pageId){
    document.querySelectorAll('.dsm-mobile-nav-global .dsm-nav-item').forEach(function(el){
      var t = el.getAttribute('data-dsm-nav');
      el.classList.toggle('active', t === pageId);
    });
  };

  // ===== Main loader =====
  window.loadDsmHome = async function loadDsmHome(){
    var page = document.getElementById('pg-dsm-home');
    if (!page) return;
    try {
      if (!window.DC) window.DC = {};
      if (!DC['pg-dsm-home']){
        DC['pg-dsm-home'] = await getDsmHome().catch(function(e){
          console.error('[dsm] fetch failed:', e); return null;
        });
      }
      var d = DC['pg-dsm-home'];
      if (!d) {
        renderEmpty('Unable to load DSM data — retry or contact admin.');
        return;
      }
      console.log('[DSM-HOME] rendering:', d.meta, '· tsrs:', (d.tsrs||[]).length, '· dist:', (d.distributors||[]).length);

      safe(function(){ renderHeader(d); });
      safe(function(){ renderHero(d.sales || {}); });
      safe(function(){ renderKPIs(d.kpis || {}); });
      safe(function(){ renderDistributors(d.distributors || []); });
      safe(function(){ renderTsrs(d.tsrs || [], d.meta && d.meta.patrol_available); });
      safe(function(){ renderCoaching(d.coaching || {}); });
      safe(function(){ renderCritical(d.critical || {}); });
      safe(function(){ renderAttention(d); });
    } catch(e){
      console.error('[dsm] loadDsmHome:', e);
      renderEmpty('Unexpected error — see console.');
    }
  };

  function renderEmpty(msg){
    document.getElementById('dsm-hdr-sub').textContent = msg;
  }

  function renderHeader(d){
    var dsm = d.dsm || {};
    document.getElementById('dsm-hdr-name').textContent = dsm.name || 'DSM';
    var sub = [
      'DSM',
      dsm.district || dsm.region || 'National',
      (dsm.tsr_count || 0) + ' TSRs',
      (dsm.distributor_count || 0) + ' distributors'
    ].filter(Boolean).join(' · ');
    document.getElementById('dsm-hdr-sub').textContent = sub;
  }

  function renderHero(s){
    var val   = document.getElementById('dsm-hero-value');
    var trend = document.getElementById('dsm-hero-trend');
    var ach   = document.getElementById('dsm-hero-ach');
    var tgt   = document.getElementById('dsm-hero-target');
    var pct   = document.getElementById('dsm-hero-pct');
    var bar   = document.getElementById('dsm-hero-bar');

    if (val){
      if (typeof animateNumber === 'function'){
        animateNumber(val, s.mtd_revenue || 0, fmtPhpShort);
      } else {
        val.textContent = fmtPhpShort(s.mtd_revenue || 0);
      }
    }
    var vs = Number(s.vs_pp_pct || 0);
    if (trend){
      var arrow = vs >= 0 ? '↑' : '↓';
      trend.className = 'dsm-hero-trend ' + (vs >= 0 ? 'up' : 'down');
      trend.textContent = arrow + ' ' + Math.abs(vs).toFixed(1) + '% vs PP';
    }
    if (ach) ach.textContent = fmtPhpShort(s.mtd_revenue || 0);
    if (tgt) tgt.textContent = s.target ? fmtPhpShort(s.target) + ' target' : 'no target set';
    var pctVal = Math.max(0, Math.min(150, Number(s.target_pct || 0)));
    if (pct) pct.textContent = pctVal.toFixed(0) + '%';
    if (bar) bar.style.width = Math.min(100, pctVal) + '%';
  }

  function renderKPIs(k){
    var dist = document.getElementById('dsm-kpi-dist');
    var tsr  = document.getElementById('dsm-kpi-tsr');
    var ar   = document.getElementById('dsm-kpi-ar');
    var conv = document.getElementById('dsm-kpi-conv');
    if (dist) dist.textContent = fmtNum(k.distributors_count || 0);
    if (tsr)  tsr.textContent  = (k.active_tsrs || 0) + '/' + (k.total_tsrs || 0);
    if (ar)   ar.textContent   = fmtPhpShort(k.ar_overdue_amount || 0);
    if (conv) conv.textContent = fmtNum(k.conversions_mtd || 0);
  }

  function renderDistributors(list){
    var wrap = document.getElementById('dsm-dist-list');
    if (!wrap) return;
    if (!list || !list.length){
      wrap.innerHTML = '<div class="dsm-empty">No distributor sales this period.</div>';
      return;
    }
    wrap.innerHTML = list.map(function(d){
      var volMt = Number(d.mtd_volume_mt || 0);
      var overdue = Number(d.ar_overdue || 0);
      var subCls  = overdue > 0 ? 'dsm-dist-sub overdue' : 'dsm-dist-sub';
      var subText = overdue > 0
        ? 'AR overdue ' + fmtPhpShort(overdue)
        : (volMt ? volMt.toFixed(1) + ' MT' : 'no volume yet');
      return '<div class="dsm-dist-row" onclick="openCust(\''+ escHtml(d.code) +'\')">'
        +   '<div><div class="dsm-dist-name">' + escHtml(d.name || d.code) + '</div>'
        +        '<div class="dsm-dist-meta">' + escHtml(d.code) + '</div></div>'
        +   '<div><div class="dsm-dist-amt">' + fmtPhpShort(d.mtd_revenue || 0) + '</div>'
        +        '<div class="'+ subCls +'">' + subText + '</div></div>'
        + '</div>';
    }).join('');
  }

  function renderTsrs(list, patrolAvailable){
    var wrap = document.getElementById('dsm-tsr-list');
    if (!wrap) return;
    if (!patrolAvailable){
      wrap.innerHTML = '<div class="dsm-empty">Patrol schema not yet migrated for DSM hierarchy.</div>';
      return;
    }
    if (!list || !list.length){
      wrap.innerHTML = '<div class="dsm-empty">No TSRs report to you yet — Patrol admin can assign via <b>manager_id</b>.</div>';
      return;
    }
    wrap.innerHTML = list.map(function(t){
      var isActive = !!t.active_today;
      var avatar = initialsOf(t.name);
      var act = isActive
        ? '<div class="dsm-tsr-action strong">' + t.visits_today + ' today</div>'
        : '<div class="dsm-tsr-action">idle</div>';
      var meta = '<b>' + fmtNum(t.total_stores) + '</b> stores'
              + ' · ' + (isActive ? ('<b>' + t.visits_today + '</b> visits today') : 'no visits today');
      return '<div class="dsm-tsr-row">'
        +   '<div class="dsm-tsr-avatar' + (isActive ? '' : ' idle') + '">'
        +     escHtml(avatar)
        +     '<span class="dsm-tsr-dot"></span>'
        +   '</div>'
        +   '<div class="dsm-tsr-info">'
        +     '<div class="dsm-tsr-name">' + escHtml(t.name || '—') + '</div>'
        +     '<div class="dsm-tsr-meta">' + meta + '</div>'
        +   '</div>'
        +   act
        + '</div>';
    }).join('');
  }

  function renderCoaching(c){
    var wrap = document.getElementById('dsm-coaching-body');
    if (!wrap) return;
    var groups = [
      { key:'urgent',   icon:'🔴', label:'Needs attention',  cls:'urgent'   },
      { key:'positive', icon:'🟢', label:'Recognise',         cls:'positive' },
      { key:'push',     icon:'🔵', label:'Push forward',      cls:'push'     }
    ];
    var html = '';
    groups.forEach(function(g){
      var rows = c[g.key] || [];
      if (!rows.length) return;
      html += '<div class="dsm-coach-group">'
           +    '<div class="dsm-coach-title">' + g.icon + ' ' + g.label + '</div>';
      rows.forEach(function(r){
        html += '<div class="dsm-coach-item ' + g.cls + '">'
             +    '<span class="dsm-coach-name">' + escHtml(r.tsr_name || r.name || '—') + '</span>'
             +    '<span class="dsm-coach-msg">' + escHtml(r.message || '') + '</span>'
             +  '</div>';
      });
      html += '</div>';
    });
    wrap.innerHTML = html || '<div class="dsm-empty">No coaching needed — all TSRs on track.</div>';
  }

  function renderCritical(c){
    var wrap = document.getElementById('dsm-critical-body');
    if (!wrap) return;
    var html = '';
    var any = false;

    // AR overdue (top)
    if ((c.ar_overdue || []).length){
      any = true;
      html += '<div class="dsm-crit-section"><div class="dsm-crit-head">💳 AR overdue</div>';
      c.ar_overdue.forEach(function(r){
        html += '<div class="dsm-crit-row" onclick="openCust(\''+ escHtml(r.code) +'\')">'
             +    '<div class="dsm-crit-name">' + escHtml(r.name) + ' · ' + (r.days_overdue||0) + 'd overdue</div>'
             +    '<div class="dsm-crit-amt">' + fmtPhpShort(r.overdue_amount) + '</div>'
             +  '</div>';
      });
      html += '</div>';
    }
    // Negative-margin customers
    if ((c.negative_margin_customers || []).length){
      any = true;
      html += '<div class="dsm-crit-section"><div class="dsm-crit-head">📉 Negative margin (MTD)</div>';
      c.negative_margin_customers.forEach(function(r){
        html += '<div class="dsm-crit-row warn" onclick="openCust(\''+ escHtml(r.code) +'\')">'
             +    '<div class="dsm-crit-name">' + escHtml(r.name) + ' · GP ' + (r.gp_pct||0).toFixed(1) + '%</div>'
             +    '<div class="dsm-crit-amt warn">' + fmtPhpShort(r.gp) + '</div>'
             +  '</div>';
      });
      html += '</div>';
    }
    // Idle TSRs (patrol)
    if ((c.idle_tsrs || []).length){
      any = true;
      html += '<div class="dsm-crit-section"><div class="dsm-crit-head">🚫 Idle TSRs</div>';
      c.idle_tsrs.forEach(function(t){
        html += '<div class="dsm-crit-row neutral">'
             +    '<div class="dsm-crit-name">' + escHtml(t.name) + ' · ' + (t.total_stores||0) + ' stores</div>'
             +    '<div class="dsm-crit-amt" style="color:#65676B">no visits</div>'
             +  '</div>';
      });
      html += '</div>';
    }
    wrap.innerHTML = any ? html : '<div class="dsm-empty">All clear. Nothing critical today.</div>';
  }

  function renderAttention(d){
    var bar = document.getElementById('dsm-alert');
    if (!bar) return;
    var msgs = [];
    var k = d.kpis || {};
    if ((k.ar_overdue_count || 0) > 0 && k.ar_overdue_amount > 100000)
      msgs.push('💳 ' + k.ar_overdue_count + ' account' + (k.ar_overdue_count===1?'':'s') + ' overdue · ' + fmtPhpShort(k.ar_overdue_amount) + ' exposure');
    if ((k.active_tsrs || 0) === 0 && (k.total_tsrs || 0) > 0)
      msgs.push('🏃 No TSRs have logged visits today yet');
    if ((d.sales || {}).vs_pp_pct < -10)
      msgs.push('📉 Sales down ' + Math.abs(Math.round(d.sales.vs_pp_pct)) + '% vs prior period');
    if (msgs.length){
      bar.style.display = 'flex';
      bar.innerHTML = msgs.map(escHtml).join(' &nbsp; · &nbsp; ');
    } else {
      bar.style.display = 'none';
    }
  }

})();
