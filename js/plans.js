/* ══════════════════════════════════════════════════════════════════
   PLANS MULTIPLES (Plan A, Plan B…) — mode planification

   Un plan = l'état propre à une stratégie : pitState (pilote, arrêts, refuel,
   pneus de chaque stint), pneus de départ et nombre de stints manuels.
   Les paramètres de course (durée, temps au tour, conso, pilotes, stock de
   pneus…) restent communs à tous les plans.

   Le plan ACTIF vit dans pitState / _startTyres / _manualStintCount (comme
   avant : tout le reste de l'appli est inchangé). Les autres plans sont
   gardés en mémoire dans _plans et synchronisés via Firebase
   (data.plans + data.activePlan).
══════════════════════════════════════════════════════════════════ */
window._plans = [{ id: 'A', name: 'Plan A', pitState: {}, startTyres: { left: 'none', right: 'none' }, manualCount: 0, pitTotal: null }];
window._activePlanId = 'A';
window._dirtyPlans = false;

function _plansClone(o) { return JSON.parse(JSON.stringify(o || {})); }
function _planActive() { return window._plans.find(p => p.id === window._activePlanId) || window._plans[0]; }

/* Recopie l'état courant dans l'entrée du plan actif */
function plansSnapshot() {
    const p = _planActive();
    if (!p) return;
    p.pitState    = _plansClone(pitState);
    p.startTyres  = Object.assign({ left: 'none', right: 'none' }, window._startTyres);
    p.manualCount = window._manualStintCount || 0;
}

/* Charge un plan dans l'état courant (sans recalcul) */
function _plansLoadIntoState(plan) {
    Object.keys(pitState).forEach(k => delete pitState[k]);
    Object.assign(pitState, _plansClone(plan.pitState));
    window._startTyres = Object.assign({ left: 'none', right: 'none' }, plan.startTyres);
    window._manualStintCount = plan.manualCount || 0;
    const stl = document.getElementById('startTyreLeft');
    const str = document.getElementById('startTyreRight');
    if (stl) { stl.value = window._startTyres.left;  _applyStartTyreSelectStyle('startTyreLeft',  stl.value); }
    if (str) { str.value = window._startTyres.right; _applyStartTyreSelectStyle('startTyreRight', str.value); }
    if (typeof _updateStartTyreLifeInfo === 'function') _updateStartTyreLifeInfo();
    if (typeof _updateManualStintUI === 'function') _updateManualStintUI('planning');
}

/* Recalcul après chargement : savePitState() relirait l'ancienne table → verrou */
function _plansRecalc() {
    const prev = window._applyingRemote;
    window._applyingRemote = true;
    try { calculate(); } finally { window._applyingRemote = prev; }
}

function _plansPush() {
    window._dirtyPlans = true;
    _dirtyPitState = true;
    _dirtyFields.add('_startTyres');
    pushToFirebase(true);
}

function plansSwitch(id) {
    if (id === window._activePlanId || window._liveMode) return;
    const target = window._plans.find(p => p.id === id);
    if (!target) return;
    plansSnapshot();
    window._activePlanId = id;
    _plansLoadIntoState(target);
    _plansRecalc();
    plansRender();
    _plansPush();
}

function _plansNextId() {
    const used = new Set(window._plans.map(p => p.id));
    for (let c = 65; c <= 90; c++) { const id = String.fromCharCode(c); if (!used.has(id)) return id; }
    return 'P' + Date.now();
}

function plansAdd(duplicate) {
    if (window._liveMode) return;
    plansSnapshot();
    const src = _planActive();
    const id = _plansNextId();
    const plan = duplicate
        ? { id, name: `${src.name} (copie)`, pitState: _plansClone(src.pitState), startTyres: _plansClone(src.startTyres), manualCount: src.manualCount }
        : { id, name: 'Plan ' + id, pitState: {}, startTyres: { left: 'none', right: 'none' }, manualCount: 0 };
    window._plans.push(plan);
    plansSwitch(id);
}

window._planUi = null;   // null | 'rename' | 'delete' (saisie dans la barre : prompt()/confirm() ne marchent pas dans l'appli de bureau)

function plansRename(name) {
    const p = _planActive();
    if (name === undefined) { window._planUi = 'rename'; plansRender(); return; }
    window._planUi = null;
    p.name = String(name).trim().slice(0, 40) || p.name;
    plansRender();
    plansSnapshot();
    window._dirtyPlans = true;
    pushToFirebase(false);
}

function plansDelete(confirmed) {
    if (window._plans.length <= 1 || window._liveMode) return;
    if (!confirmed) { window._planUi = 'delete'; plansRender(); return; }
    window._planUi = null;
    const p = _planActive();
    window._plans = window._plans.filter(x => x.id !== p.id);
    const next = window._plans[0];
    window._activePlanId = next.id;
    _plansLoadIntoState(next);
    _plansRecalc();
    plansRender();
    _plansPush();
}

/* Remise à zéro (bouton Reset) : un seul plan vierge */
function plansReset() {
    window._plans = [{ id: 'A', name: 'Plan A', pitState: {}, startTyres: { left: 'none', right: 'none' }, manualCount: 0 }];
    window._activePlanId = 'A';
    plansRender();
}

/* Données distantes : liste des plans + plan actif de l'équipe.
   Appelé avant la fusion de data.pitState dans applyFormData(). */
function plansApplyRemote(data) {
    // Première réception après l'arrivée dans une session : l'état local est vierge
    // (voir _resetLocalSessionState), il ne doit PAS « faire foi » sur le plan actif.
    const freshJoin = !!window._plansFreshJoin;
    window._plansFreshJoin = false;
    if (!data || !data.plans) { plansRender(); return; }
    const local = _planActive();
    const list = Object.keys(data.plans)
        .map(id => Object.assign({ id }, data.plans[id]))
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .map(p => ({
            id: p.id, name: p.name || ('Plan ' + p.id),
            pitState: p.pitState || {}, startTyres: p.startTyres || { left: 'none', right: 'none' },
            manualCount: p.manualCount || 0,
            pitTotal: (typeof p.pitTotal === 'number') ? p.pitTotal : null
        }));
    if (!list.length) return;
    const newActive = list.some(p => p.id === data.activePlan) ? data.activePlan : list[0].id;
    if (newActive === window._activePlanId && local && !freshJoin) {
        // même plan actif : l'état courant fait foi (il est déjà à jour / en cours d'édition)
        // sauf le nom et le total des arrêts, qui viennent de l'équipe
        const i = list.findIndex(p => p.id === newActive);
        if (window._planUi !== 'rename') local.name = list[i].name;
        if (list[i].pitTotal !== null) local.pitTotal = list[i].pitTotal;
        list[i] = local;
    } else {
        // l'équipe a changé de plan : on remplace entièrement l'état courant
        Object.keys(pitState).forEach(k => delete pitState[k]);
        const act = list.find(p => p.id === newActive);
        window._manualStintCount = act.manualCount || 0;
        if (typeof _updateManualStintUI === 'function') _updateManualStintUI('planning');
    }
    window._plans = list;
    window._activePlanId = newActive;
    plansRender();
}

/* Données à envoyer à Firebase */
function plansCollect() {
    plansSnapshot();
    const out = {};
    window._plans.forEach((p, i) => {
        out[p.id] = { name: p.name, order: i, pitState: _plansClone(p.pitState), startTyres: _plansClone(p.startTyres), manualCount: p.manualCount || 0, pitTotal: p.pitTotal };
    });
    return { plans: out, activePlan: window._activePlanId };
}

function _plansFmtPit(sec) {
    if (typeof sec !== 'number') return '—';
    const m = Math.floor(sec / 60), r = Math.round(sec % 60);
    return `${m > 0 ? m + 'min ' : ''}${r}s`;
}

/* Appelé par calculate() : durée totale des arrêts au stand du plan actif */
function plansSetPitTotal(sec) {
    const p = _planActive();
    if (!p) return;
    p.pitTotal = Math.round(sec);
    const el = document.querySelector(`#planBar [data-pit-for="${p.id}"]`);
    if (el) el.textContent = '⏱ Pit Σ ' + _plansFmtPit(p.pitTotal);
}

function _plansEsc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function plansRender() {
    const bar = document.getElementById('planBar');
    if (!bar) return;
    const act = window._activePlanId;
    let html = '';
    const cur = _planActive();
    if (window._planUi === 'rename') {
        html = `<input type="text" id="planNameInput" class="plan-input" maxlength="40" value="${_plansEsc(cur.name)}">`
             + `<button type="button" class="plan-act" data-act="rename-ok">✔ OK</button>`
             + `<button type="button" class="plan-act" data-act="cancel">Annuler</button>`;
    } else if (window._planUi === 'delete') {
        html = `<span class="plan-confirm">Supprimer « ${_plansEsc(cur.name)} » pour toute l'équipe ?</span>`
             + `<button type="button" class="plan-act plan-del" data-act="del-ok">🗑 Supprimer</button>`
             + `<button type="button" class="plan-act" data-act="cancel">Annuler</button>`;
    } else {
        window._plans.forEach(p => {
            const on = p.id === act;
            html += `<button type="button" class="plan-tab${on ? ' active' : ''}" data-plan="${_plansEsc(p.id)}">${on ? '★ ' : ''}${_plansEsc(p.name)}<span class="plan-pit" data-pit-for="${_plansEsc(p.id)}">⏱ Pit Σ ${_plansFmtPit(p.pitTotal)}</span></button>`;
        });
        html += `<button type="button" class="plan-act" data-act="rename" title="Renommer le plan actif">✎ Modifier</button>`;
        html += `<button type="button" class="plan-act plan-add" data-act="add" title="Nouveau plan vierge (nouvelle timeline et table des stints)">+ Plan</button>`;
        html += `<button type="button" class="plan-act" data-act="dup" title="Dupliquer le plan actif">⧉ Dupliquer</button>`;
        if (window._plans.length > 1)
            html += `<button type="button" class="plan-act plan-del" data-act="del" title="Supprimer le plan actif">🗑 Supprimer</button>`;
    }
    bar.innerHTML = html;
    const inp = document.getElementById('planNameInput');
    if (inp) { inp.focus(); inp.select(); }
}

(function () {
    const bar = document.getElementById('planBar');
    if (!bar) return;
    bar.addEventListener('click', e => {
        const tab = e.target.closest('.plan-tab');
        if (tab) { plansSwitch(tab.dataset.plan); return; }
        const act = e.target.closest('.plan-act');
        if (!act) return;
        if (act.dataset.act === 'add')    plansAdd(false);
        if (act.dataset.act === 'dup')    plansAdd(true);
        if (act.dataset.act === 'rename') plansRename();
        if (act.dataset.act === 'rename-ok') plansRename(document.getElementById('planNameInput').value);
        if (act.dataset.act === 'del')    plansDelete();
        if (act.dataset.act === 'del-ok') plansDelete(true);
        if (act.dataset.act === 'cancel') { window._planUi = null; plansRender(); }
    });
    bar.addEventListener('keydown', e => {
        if (e.target.id !== 'planNameInput') return;
        if (e.key === 'Enter') plansRename(e.target.value);
        if (e.key === 'Escape') { window._planUi = null; plansRender(); }
    });
    plansRender();
})();
