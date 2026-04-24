// VieForce HQ — Team Hierarchy Manager
// /pg-admin-team.html
//
// Vanilla ES5-ish (matches js/api.js / js/auth.js style in this repo — no
// bundler). Auth.js loads first and exposes requireAuth/hasRole/getSession.

(function () {
  'use strict';

  // API_BASE must match js/api.js. Duplicated here so this page doesn't depend
  // on the rest of the dashboard JS bundle.
  var API_BASE = 'https://vieforce-hq-api-1057619753074.asia-southeast1.run.app/api';

  var ROLE_OPTIONS = [
    { v: '',          label: '(not set)' },
    { v: 'tsr',       label: 'TSR' },
    { v: 'dsm',       label: 'DSM' },
    { v: 'rsm',       label: 'RSM' },
    { v: 'director',  label: 'Director' },
    { v: 'exec',      label: 'Exec' },
    { v: 'ceo',       label: 'CEO' },
    { v: 'exclude',   label: '— Exclude' }
  ];

  // ── State ───────────────────────────────────────────────────────────────
  var state = {
    session: null,
    reps: [],            // raw rows from /api/admin/sap-reps
    managers: [],        // supabase_managers
    editsBySlp: {},      // slp_code → { role, manager_id, phone }
    statusBySlp: {},     // slp_code → 'mapped' | 'unsaved' | 'saving' | 'error' | 'not_mapped'
    errorBySlp: {},      // slp_code → error message string
    filter: 'all'
  };

  // ── DOM ─────────────────────────────────────────────────────────────────
  var $ = function (id) { return document.getElementById(id); };
  var bodyEl, tableEl, loadingEl, errorEl, errorMsgEl, toastEl, saveAllBtn, unsavedCountEl, filterChipsEl;

  // ── Auth + init ─────────────────────────────────────────────────────────
  function init() {
    state.session = requireAuth();
    if (!state.session) return;

    var allowed = ['exec', 'ceo', 'admin'];
    if (allowed.indexOf(state.session.role) === -1) {
      // Redirect to dashboard with a toast — this page is admin-only.
      alert('Admin access required — redirecting to dashboard.');
      window.location.href = '/app.html';
      return;
    }

    $('userBadge').textContent = state.session.name + ' · ' + (state.session.role || '').toUpperCase();
    $('logoutBtn').addEventListener('click', function () { logout(); });

    bodyEl        = $('repsBody');
    tableEl       = $('repsTable');
    loadingEl     = $('loadingState');
    errorEl       = $('errorState');
    errorMsgEl    = $('errorMsg');
    toastEl       = $('toast');
    saveAllBtn    = $('saveAllBtn');
    unsavedCountEl = $('unsavedCount');
    filterChipsEl = $('filterChips');

    $('retryBtn').addEventListener('click', loadReps);
    saveAllBtn.addEventListener('click', saveAll);

    // Filter chip wiring
    filterChipsEl.addEventListener('click', function (e) {
      var btn = e.target.closest('.chip');
      if (!btn) return;
      var chips = filterChipsEl.querySelectorAll('.chip');
      for (var i = 0; i < chips.length; i++) chips[i].classList.remove('active');
      btn.classList.add('active');
      state.filter = btn.dataset.filter;
      renderRows();
    });

    // beforeunload guard — warn when any row has unsaved changes
    window.addEventListener('beforeunload', function (e) {
      var unsaved = countUnsaved();
      if (unsaved > 0) {
        e.preventDefault();
        e.returnValue = 'You have ' + unsaved + ' unsaved row(s). Leave anyway?';
        return e.returnValue;
      }
    });

    loadReps();
  }

  // ── API helpers ─────────────────────────────────────────────────────────
  function apiHeaders() {
    return {
      'Content-Type': 'application/json',
      'x-session-id': state.session ? state.session.id : ''
    };
  }
  function apiGet(endpoint) {
    return fetch(API_BASE + '/' + endpoint, { headers: apiHeaders(), cache: 'no-store' })
      .then(handleRes);
  }
  function apiPost(endpoint, body) {
    return fetch(API_BASE + '/' + endpoint, {
      method: 'POST', headers: apiHeaders(), body: JSON.stringify(body || {})
    }).then(handleRes);
  }
  function apiDelete(endpoint, body) {
    return fetch(API_BASE + '/' + endpoint, {
      method: 'DELETE', headers: apiHeaders(), body: JSON.stringify(body || {})
    }).then(handleRes);
  }
  function handleRes(res) {
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    return res.text().then(function (txt) {
      var data = null;
      try { data = txt ? JSON.parse(txt) : null; } catch (_) {}
      if (!res.ok) {
        var msg = (data && data.error) ? data.error : ('HTTP ' + res.status);
        var err = new Error(msg);
        err.status = res.status;
        err.detail = data && data.detail;
        throw err;
      }
      return data;
    });
  }

  // ── Load ────────────────────────────────────────────────────────────────
  function loadReps() {
    loadingEl.classList.remove('hidden');
    errorEl.classList.add('hidden');
    tableEl.classList.add('hidden');

    apiGet('admin/sap-reps').then(function (data) {
      state.reps = (data && data.reps) || [];
      state.managers = (data && data.supabase_managers) || [];
      state.editsBySlp = {};
      state.errorBySlp = {};
      // Initialize statuses
      state.statusBySlp = {};
      for (var i = 0; i < state.reps.length; i++) {
        var r = state.reps[i];
        state.statusBySlp[r.slp_code] = r.linked_supabase_user ? 'mapped' : 'not_mapped';
      }
      updateStats();
      renderRows();
      loadingEl.classList.add('hidden');
      tableEl.classList.remove('hidden');
    }).catch(function (err) {
      console.error('[pg-admin-team] load failed', err);
      loadingEl.classList.add('hidden');
      errorMsgEl.textContent = 'Failed to load SAP reps: ' + err.message;
      errorEl.classList.remove('hidden');
    });
  }

  // ── Derived data ────────────────────────────────────────────────────────
  function inferDefaultRole(rep) {
    // Rules (per spec):
    //   - SlpCode appears as someone's U_rsm (rep manages people)    → RSM
    //   - U_rsm points to Director (3)                                → RSM
    //   - U_rsm points to a non-Director                              → DSM
    //   - otherwise                                                   → ''
    var appearsAsManager = false;
    for (var i = 0; i < state.reps.length; i++) {
      if (state.reps[i].u_rsm === rep.slp_code && state.reps[i].slp_code !== rep.slp_code) {
        appearsAsManager = true; break;
      }
    }
    if (appearsAsManager) return 'rsm';
    if (rep.u_rsm === 3) return 'rsm';
    if (rep.u_rsm != null) return 'dsm';
    return '';
  }

  function inferDefaultManager(rep) {
    // Pre-select the Supabase user whose sap_slpcode === rep.u_rsm
    if (rep.u_rsm == null) return '';
    var match = state.managers.find(function (m) { return Number(m.sap_slpcode) === rep.u_rsm; });
    return match ? match.id : '';
  }

  function getEditedRow(rep) {
    var slp = rep.slp_code;
    var edit = state.editsBySlp[slp] || {};
    var linked = rep.linked_supabase_user;
    var role = edit.role !== undefined ? edit.role
             : (linked ? linked.role : inferDefaultRole(rep));
    var manager_id = edit.manager_id !== undefined ? edit.manager_id
                    : (linked ? (linked.manager_id || '') : inferDefaultManager(rep));
    var phone = edit.phone !== undefined ? edit.phone
              : (linked ? linked.phone : rep.provisional_phone);
    var name  = (linked && linked.name) || titleCase(rep.slp_name);
    return { role: role, manager_id: manager_id, phone: phone, name: name };
  }

  function titleCase(s) {
    if (!s) return '';
    return String(s).toLowerCase().replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); });
  }

  function markEdit(slp, field, value) {
    state.editsBySlp[slp] = state.editsBySlp[slp] || {};
    state.editsBySlp[slp][field] = value;
    if (state.statusBySlp[slp] !== 'saving') {
      state.statusBySlp[slp] = 'unsaved';
    }
    delete state.errorBySlp[slp];
    updateStats();
    // Re-render only the affected row status pill + action buttons
    updateRowStatus(slp);
  }

  // ── Render ──────────────────────────────────────────────────────────────
  function updateStats() {
    var mapped = 0, unmapped = 0, unsaved = 0;
    for (var i = 0; i < state.reps.length; i++) {
      var st = state.statusBySlp[state.reps[i].slp_code];
      if (st === 'mapped') mapped++;
      else if (st === 'unsaved') unsaved++;
      else unmapped++;
    }
    $('statMapped').textContent = mapped;
    $('statUnmapped').textContent = unmapped;
    $('statTotal').textContent = state.reps.length;
    unsavedCountEl.textContent = unsaved > 0 ? (unsaved + ' unsaved') : '';
    saveAllBtn.disabled = unsaved === 0;
  }

  function countUnsaved() {
    var n = 0;
    for (var slp in state.statusBySlp) {
      if (state.statusBySlp[slp] === 'unsaved') n++;
    }
    return n;
  }

  function repPassesFilter(rep) {
    var st = state.statusBySlp[rep.slp_code];
    switch (state.filter) {
      case 'mapped':   return st === 'mapped';
      case 'unmapped': return st === 'not_mapped';
      case 'vacant':   return rep.is_vacant;
      case 'unsaved':  return st === 'unsaved';
      case 'all':
      default:         return true;
    }
  }

  function renderRows() {
    bodyEl.innerHTML = '';
    for (var i = 0; i < state.reps.length; i++) {
      var rep = state.reps[i];
      if (!repPassesFilter(rep)) continue;
      bodyEl.appendChild(buildRow(rep));
    }
  }

  function buildRow(rep) {
    var edited = getEditedRow(rep);
    var tr = document.createElement('tr');
    tr.dataset.slp = rep.slp_code;
    if (rep.is_vacant) tr.classList.add('vacant');
    if (state.statusBySlp[rep.slp_code] === 'unsaved') tr.classList.add('unsaved');

    // SlpCode
    var tdSlp = document.createElement('td');
    tdSlp.className = 'cell-slp';
    tdSlp.textContent = rep.slp_code;
    tr.appendChild(tdSlp);

    // Name (editable)
    var tdName = document.createElement('td');
    tdName.className = 'cell-name';
    var inName = document.createElement('input');
    inName.type = 'text'; inName.value = edited.name;
    inName.addEventListener('input', function () { markEdit(rep.slp_code, 'name', inName.value); });
    tdName.appendChild(inName);
    tr.appendChild(tdName);

    // SAP Manager (read-only)
    var tdMgr = document.createElement('td');
    tdMgr.className = 'cell-sap-mgr';
    tdMgr.textContent = rep.memo || '—';
    tr.appendChild(tdMgr);

    // Role
    var tdRole = document.createElement('td');
    var selRole = document.createElement('select');
    for (var j = 0; j < ROLE_OPTIONS.length; j++) {
      var op = document.createElement('option');
      op.value = ROLE_OPTIONS[j].v;
      op.textContent = ROLE_OPTIONS[j].label;
      if (edited.role === ROLE_OPTIONS[j].v) op.selected = true;
      selRole.appendChild(op);
    }
    selRole.addEventListener('change', function () { markEdit(rep.slp_code, 'role', selRole.value); });
    tdRole.appendChild(selRole);
    tr.appendChild(tdRole);

    // Manager (Supabase)
    var tdSupMgr = document.createElement('td');
    var selMgr = document.createElement('select');
    var blank = document.createElement('option');
    blank.value = ''; blank.textContent = '(none)';
    selMgr.appendChild(blank);
    for (var k = 0; k < state.managers.length; k++) {
      var m = state.managers[k];
      var op2 = document.createElement('option');
      op2.value = m.id;
      op2.textContent = m.name + ' · ' + (m.role || '').toUpperCase();
      if (edited.manager_id === m.id) op2.selected = true;
      selMgr.appendChild(op2);
    }
    selMgr.addEventListener('change', function () { markEdit(rep.slp_code, 'manager_id', selMgr.value || null); });
    tdSupMgr.appendChild(selMgr);
    tr.appendChild(tdSupMgr);

    // Phone
    var tdPhone = document.createElement('td');
    var inPhone = document.createElement('input');
    inPhone.type = 'text'; inPhone.className = 'cell-phone';
    inPhone.value = edited.phone || rep.provisional_phone;
    inPhone.addEventListener('input', function () { markEdit(rep.slp_code, 'phone', inPhone.value); });
    tdPhone.appendChild(inPhone);
    tr.appendChild(tdPhone);

    // Status
    var tdStatus = document.createElement('td');
    tdStatus.className = 'cell-status';
    tdStatus.appendChild(buildStatusPill(rep.slp_code));
    tr.appendChild(tdStatus);

    // Actions
    var tdActions = document.createElement('td');
    tdActions.className = 'cell-actions';
    tdActions.appendChild(buildActions(rep));
    tr.appendChild(tdActions);

    return tr;
  }

  function buildStatusPill(slp) {
    var st = state.statusBySlp[slp] || 'not_mapped';
    var pill = document.createElement('span');
    pill.className = 'status-pill ' + st.replace('_', '-');
    var labels = {
      not_mapped: 'Not mapped',
      mapped: 'Mapped',
      unsaved: 'Unsaved',
      saving: 'Saving…',
      error: 'Error'
    };
    pill.textContent = labels[st] || st;
    if (st === 'error' && state.errorBySlp[slp]) pill.title = state.errorBySlp[slp];
    return pill;
  }

  function buildActions(rep) {
    var wrap = document.createDocumentFragment();
    var st = state.statusBySlp[rep.slp_code];
    var linked = rep.linked_supabase_user;

    var saveBtn = document.createElement('button');
    saveBtn.className = 'btn-row save';
    saveBtn.textContent = 'Save';
    saveBtn.disabled = st !== 'unsaved' && st !== 'error';
    saveBtn.addEventListener('click', function () { saveRow(rep); });
    wrap.appendChild(saveBtn);

    if (linked) {
      var pinBtn = document.createElement('button');
      pinBtn.className = 'btn-row pin';
      pinBtn.textContent = 'Reset PIN';
      pinBtn.addEventListener('click', function () { confirmResetPin(rep); });
      wrap.appendChild(pinBtn);

      var canRemove = linked.id !== state.session.id && linked.role !== 'ceo';
      if (canRemove) {
        var rmBtn = document.createElement('button');
        rmBtn.className = 'btn-row remove';
        rmBtn.textContent = 'Remove';
        rmBtn.addEventListener('click', function () { confirmRemove(rep); });
        wrap.appendChild(rmBtn);
      }
    }

    return wrap;
  }

  function updateRowStatus(slp) {
    var row = bodyEl.querySelector('tr[data-slp="' + slp + '"]');
    if (!row) return;
    // Refresh unsaved-row accent
    if (state.statusBySlp[slp] === 'unsaved') row.classList.add('unsaved');
    else row.classList.remove('unsaved');
    // Rebuild status + actions cells
    var cells = row.children;
    var statusCell = cells[cells.length - 2];
    var actionsCell = cells[cells.length - 1];
    statusCell.innerHTML = '';
    statusCell.appendChild(buildStatusPill(slp));
    actionsCell.innerHTML = '';
    var rep = findRep(slp);
    if (rep) actionsCell.appendChild(buildActions(rep));
  }

  function findRep(slp) {
    for (var i = 0; i < state.reps.length; i++) if (state.reps[i].slp_code == slp) return state.reps[i];
    return null;
  }

  // ── Save (per-row + batch) ──────────────────────────────────────────────
  function saveRow(rep) {
    var edited = getEditedRow(rep);
    if (!edited.role) { toast('Pick a role first', 'err'); return Promise.resolve({ ok: false }); }
    if (!edited.phone || !/^\d{11}$/.test(edited.phone)) { toast('Phone must be 11 digits', 'err'); return Promise.resolve({ ok: false }); }

    state.statusBySlp[rep.slp_code] = 'saving';
    updateRowStatus(rep.slp_code);

    var body = {
      slp_code: rep.slp_code,
      name: edited.name,
      role: edited.role,
      manager_id: edited.manager_id || null,
      phone: edited.phone,
      create_auth_user: true
    };

    return apiPost('admin/upsert-user', body).then(function (resp) {
      if (resp.action === 'deleted') {
        // Row was excluded; remove from reps list visually
        rep.linked_supabase_user = null;
      } else if (resp.user) {
        rep.linked_supabase_user = resp.user;
      }
      delete state.editsBySlp[rep.slp_code];
      state.statusBySlp[rep.slp_code] = resp.action === 'deleted' ? 'not_mapped' : 'mapped';
      delete state.errorBySlp[rep.slp_code];
      if (resp.user && resp.action !== 'deleted') {
        // Make the newly-saved user available as a manager option immediately
        if (['rsm','director','exec','ceo'].indexOf(resp.user.role) !== -1) {
          var already = state.managers.some(function (m) { return m.id === resp.user.id; });
          if (!already) state.managers.push({
            id: resp.user.id, name: resp.user.name, role: resp.user.role, sap_slpcode: resp.user.sap_slpcode
          });
        }
      }
      updateStats();
      renderRows();
      toast('✓ ' + edited.name + ' · ' + (resp.action || 'saved'), 'ok');
      return { ok: true };
    }).catch(function (err) {
      console.error('[pg-admin-team] save failed', err);
      state.statusBySlp[rep.slp_code] = 'error';
      state.errorBySlp[rep.slp_code] = err.message + (err.detail ? (' — ' + err.detail) : '');
      updateRowStatus(rep.slp_code);
      updateStats();
      toast('✗ ' + (err.message || 'Save failed'), 'err');
      return { ok: false };
    });
  }

  function saveAll() {
    var slps = Object.keys(state.statusBySlp).filter(function (s) { return state.statusBySlp[s] === 'unsaved'; });
    if (!slps.length) return;
    var total = slps.length, done = 0, ok = 0;
    saveAllBtn.disabled = true;
    saveAllBtn.textContent = 'Saving 1 of ' + total + '…';

    // Sequential — simpler rollback semantics, avoids rate limits on auth.admin.
    function next() {
      if (!slps.length) {
        saveAllBtn.textContent = 'Save All';
        toast('Saved ' + ok + ' of ' + total + (ok < total ? ' (check errors)' : ''), ok === total ? 'ok' : 'err');
        updateStats();
        return;
      }
      var slp = slps.shift();
      var rep = findRep(slp);
      done++;
      saveAllBtn.textContent = 'Saving ' + done + ' of ' + total + '…';
      saveRow(rep).then(function (r) {
        if (r && r.ok) ok++;
        next();
      });
    }
    next();
  }

  // ── Reset PIN / Remove ──────────────────────────────────────────────────
  function confirmResetPin(rep) {
    var linked = rep.linked_supabase_user;
    if (!linked) return;
    openConfirm(
      'Reset PIN',
      'Reset PIN for ' + linked.name + ' to 1234? They can log in with phone ' + linked.phone + '.',
      function () {
        apiPost('admin/reset-pin', { user_id: linked.id, new_pin: '1234' })
          .then(function () { toast('✓ PIN reset for ' + linked.name, 'ok'); })
          .catch(function (err) { toast('✗ ' + err.message, 'err'); });
      }
    );
  }

  function confirmRemove(rep) {
    var linked = rep.linked_supabase_user;
    if (!linked) return;
    openConfirm(
      'Remove user',
      'Permanently remove ' + linked.name + ' (' + linked.phone + ')? This deletes both the auth and public user rows.',
      function () {
        apiDelete('admin/remove-user', { user_id: linked.id })
          .then(function () {
            rep.linked_supabase_user = null;
            state.statusBySlp[rep.slp_code] = 'not_mapped';
            delete state.editsBySlp[rep.slp_code];
            // Drop from managers dropdown
            state.managers = state.managers.filter(function (m) { return m.id !== linked.id; });
            updateStats();
            renderRows();
            toast('✓ ' + linked.name + ' removed', 'ok');
          })
          .catch(function (err) { toast('✗ ' + err.message, 'err'); });
      }
    );
  }

  // ── Modal + toast ───────────────────────────────────────────────────────
  function openConfirm(title, body, onOk) {
    $('confirmTitle').textContent = title;
    $('confirmBody').textContent = body;
    var modal = $('confirmModal');
    modal.classList.remove('hidden');
    var okBtn = $('confirmOk');
    var cancelBtn = $('confirmCancel');
    function close() {
      modal.classList.add('hidden');
      okBtn.removeEventListener('click', okHandler);
      cancelBtn.removeEventListener('click', close);
    }
    function okHandler() { close(); onOk(); }
    okBtn.addEventListener('click', okHandler);
    cancelBtn.addEventListener('click', close);
  }

  var toastTimer = null;
  function toast(msg, kind) {
    toastEl.textContent = msg;
    toastEl.className = 'toast ' + (kind || 'ok');
    toastEl.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.add('hidden'); }, 3200);
  }

  // ── Boot ────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
