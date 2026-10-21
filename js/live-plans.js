/* ══════════════════════════════════════════════════════════════════
   PLANS DU MODE LIVE — indépendants de ceux de la planification

   Au premier clic sur « Connecter » (ou au premier recalcul live), les plans de la
   planification sont COPIÉS dans le Live. Ensuite les deux listes vivent chacune de leur
   côté : modifier, ajouter ou supprimer un plan en Live ne touche pas à la planification,
   et inversement. Les plans Live sont partagés avec toute la session (Firebase :
   data/livePlans/{id} + data/liveActivePlan, comme les plans de planification) et gardés
   aussi en mémoire dans le navigateur : retrouvés après un rechargement ou une reconnexion.
   Le plan Live affiché (liveActivePlan) est commun à toute l'équipe.

   Le reste de l'appli lit/écrit un seul objet pitState (+ window._startTyres). Il contient
   à tout instant les données du contexte indiqué par window._stateCtx :
     'planning' → plan affiché en planification (window._plans / _activePlanId)
     'live'     → plan affiché en Live          (window._livePlans / _liveActivePlanId)
   _stateUse(ctx) range l'état courant dans son plan puis charge celui de l'autre contexte.
   Chaque point d'entrée (calcul, saisie dans une table, timeline…) l'appelle pour travailler
   sur le bon contexte.
══════════════════════════════════════════════════════════════════ */
window._stateCtx = 'planning';
window._livePlans = [];            // [{ id, name, pitState, startTyres, manualCount, pitTotal }]
window._liveActivePlanId = null;
window._livePlanUi = null;         // null | 'rename' | 'delete' | 'recopy'
window._livePlansDirty = new Set();    // plans Live à envoyer
window._livePlansDeleted = new Set();  // plans Live supprimés à retirer de Firebase
window._dirtyLiveActive = false;       // plan Live affiché à renvoyer

function liveMarkEdited() {
    const p = _liveActive();
    if (p) window._livePlansDirty.add(p.id);
}
function _livePush() { if (typeof pushToFirebase === 'function') pushToFirebase(true); }

function _liveActive() {
    return window._livePlans.find(p => p.id === window._liveActivePlanId) || window._livePlans[0] || null;
}

/* ── Contexte des données ── */
function _stateUse(ctx) {
    if (ctx === window._stateCtx) return;
    if (window._stateCtx === 'live') liveSnapshot(); else plansSnapshot();
    window._stateCtx = ctx;
    if (ctx === 'live') {
        livePlansEnsure();
        _liveLoadIntoState(_liveActive());
    } else {
        _plansLoadIntoState(_planActive());
    }
}

/* Range l'état courant dans le plan Live affiché */
function liveSnapshot() {
    const p = _liveActive();
    if (!p) return;
    p.manualCount = window._manualStintCountLive || 0;
    if (window._stateCtx !== 'live') return;      // sinon pitState appartient à la planification
    p.pitState   = _plansClone(pitState);
    p.startTyres = Object.assign({ left: 'none', right: 'none' }, window._startTyres);
}

function _liveLoadIntoState(plan) {
    Object.keys(pitState).forEach(k => delete pitState[k]);
    if (!plan) return;
    Object.assign(pitState, _plansClone(plan.pitState));
    window._startTyres = Object.assign({ left: 'none', right: 'none' }, plan.startTyres);
    window._manualStintCountLive = plan.manualCount || 0;
    if (typeof _updateManualStintUI === 'function') _updateManualStintUI('live');
}

/* ── Création : copie des plans de la planification ── */
function livePlansEnsure() {
    if (!window._livePlans.length) livePlansCopyFromPlanning();
}

function livePlansCopyFromPlanning() {
    if (window._stateCtx === 'planning') plansSnapshot();
    const src = window._plans;
    window._livePlans.forEach(p => window._livePlansDeleted.add(p.id));
    window._livePlans = src.map(p => ({
        id: p.id, name: p.name,
        pitState: _plansClone(p.pitState),
        startTyres: Object.assign({ left: 'none', right: 'none' }, p.startTyres),
        manualCount: 0,
        pitTotal: (typeof p.pitTotal === 'number') ? p.pitTotal : null
    }));
    window._liveActivePlanId = src.some(p => p.id === window._activePlanId) ? window._activePlanId : src[0].id;
    window._livePlanUi = null;
    window._manualStintCountLive = 0;
    if (window._stateCtx === 'live') _liveLoadIntoState(_liveActive());
    window._livePlans.forEach(p => { window._livePlansDirty.add(p.id); window._livePlansDeleted.delete(p.id); });
    window._dirtyLiveActive = true;
    livePlansPersist();
    livePlansRender();
    _livePush();
}

/* Clic sur « Connecter » : première fois = copie ; ensuite on garde les plans Live existants */
function livePlansOnConnect() {
    if (!window._livePlans.length) livePlansCopyFromPlanning();
    else livePlansRender();
}

/* ── Mémoire (navigateur) ── */
function _livePlansKey() {
    return `lmuLivePlans.${window._teamId || ''}.${(typeof _sessionId !== 'undefined' && _sessionId) || '_'}`;
}

function livePlansPersist() {
    liveSnapshot();
    try {
        localStorage.setItem(_livePlansKey(), JSON.stringify({
            plans: window._livePlans, active: window._liveActivePlanId, ts: Date.now()
        }));
    } catch (e) { /* stockage indisponible : les plans restent en mémoire vive */ }
}

let _livePersistTimer = null;
function livePlansPersistSoon() {
    if (_livePersistTimer) return;                 // pas de réarmement : le Live recalcule plusieurs fois par seconde
    _livePersistTimer = setTimeout(() => { _livePersistTimer = null; livePlansPersist(); }, 500);
}

/* Arrivée dans une session : on oublie ceux de la précédente */
function livePlansResetMemory() {
    window._livePlans = [];
    window._liveActivePlanId = null;
    window._livePlanUi = null;
    window._manualStintCountLive = 0;
    window._livePlansDirty.clear(); window._livePlansDeleted.clear(); window._dirtyLiveActive = false;
    livePlansRender();
}

function livePlansRestore() {
    livePlansResetMemory();
    try {
        const raw = localStorage.getItem(_livePlansKey());
        const d = raw && JSON.parse(raw);
        if (d && Array.isArray(d.plans) && d.plans.length) {
            window._livePlans = d.plans.map(p => ({
                id: String(p.id), name: String(p.name || ('Plan ' + p.id)),
                pitState: p.pitState || {}, startTyres: p.startTyres || { left: 'none', right: 'none' },
                manualCount: p.manualCount || 0,
                pitTotal: (typeof p.pitTotal === 'number') ? p.pitTotal : null
            }));
            window._liveActivePlanId = window._livePlans.some(p => p.id === d.active) ? d.active : window._livePlans[0].id;
            window._manualStintCountLive = _liveActive().manualCount || 0;
        }
    } catch (e) { /* mémoire illisible : on repartira d'une copie de la planification */ }
    livePlansRender();
}

/* ── Actions ── */
function _liveStructChanged() {
    if (window._stateCtx === 'live') _liveLoadIntoState(_liveActive());
    else window._manualStintCountLive = (_liveActive() && _liveActive().manualCount) || 0;
    livePlansPersist();
    livePlansRender();
    if (window._liveModeActive && typeof recalculateLive === 'function') recalculateLive(true);
    _livePush();
}

function livePlansSwitch(id) {
    if (id === window._liveActivePlanId || !window._livePlans.some(p => p.id === id)) return;
    liveSnapshot();
    window._liveActivePlanId = id;
    window._dirtyLiveActive = true;
    _liveStructChanged();
}

function _liveNextId() {
    const used = new Set(window._livePlans.map(p => p.id));
    for (let c = 65; c <= 90; c++) { const id = String.fromCharCode(c); if (!used.has(id)) return id; }
    return 'P' + Date.now();
}

function livePlansAdd(duplicate) {
    if (!window._livePlans.length) return;
    liveSnapshot();
    const src = _liveActive();
    const id = _liveNextId();
    window._livePlans.push(duplicate
        ? { id, name: `${src.name} (copie)`, pitState: _plansClone(src.pitState), startTyres: _plansClone(src.startTyres), manualCount: src.manualCount || 0, pitTotal: src.pitTotal }
        : { id, name: 'Plan ' + id, pitState: {}, startTyres: { left: 'none', right: 'none' }, manualCount: 0, pitTotal: null });
    window._liveActivePlanId = id;
    window._livePlansDirty.add(id);
    window._dirtyLiveActive = true;
    _liveStructChanged();
}

function livePlansRename(name) {
    const p = _liveActive();
    if (!p) return;
    if (name === undefined) { window._livePlanUi = 'rename'; livePlansRender(); return; }
    window._livePlanUi = null;
    p.name = String(name).trim().slice(0, 40) || p.name;
    window._livePlansDirty.add(p.id);
    livePlansPersist();
    livePlansRender();
    _livePush();
}

function livePlansDelete(confirmed) {
    if (window._livePlans.length <= 1) return;
    if (!confirmed) { window._livePlanUi = 'delete'; livePlansRender(); return; }
    window._livePlanUi = null;
    const cur = _liveActive();
    window._livePlans = window._livePlans.filter(p => p.id !== cur.id);
    window._livePlansDirty.delete(cur.id);
    window._livePlansDeleted.add(cur.id);
    window._liveActivePlanId = window._livePlans[0].id;
    window._dirtyLiveActive = true;
    _liveStructChanged();
}

function livePlansRecopy(confirmed) {
    if (!confirmed) { window._livePlanUi = 'recopy'; livePlansRender(); return; }
    livePlansCopyFromPlanning();
    _liveStructChanged();
}

/* ── Firebase ── */
function _liveRecord(p, i) {
    return { name: p.name, order: i, pitState: _plansClone(p.pitState), startTyres: _plansClone(p.startTyres),
             manualCount: p.manualCount || 0, pitTotal: (typeof p.pitTotal === 'number') ? p.pitTotal : null };
}

/* Mise à jour PARTIELLE : plans modifiés, supprimés, plan affiché */
function livePlansPartial() {
    liveSnapshot();
    const out = {};
    const ids = new Set(window._livePlansDirty);
    window._livePlans.forEach((p, i) => { if (ids.has(p.id)) out[`livePlans/${p.id}`] = _liveRecord(p, i); });
    const del = new Set();
    window._livePlansDeleted.forEach(id => {
        if (!window._livePlans.some(p => p.id === id)) { out[`livePlans/${id}`] = null; del.add(id); }
    });
    const act = !!window._dirtyLiveActive;
    if (act && window._liveActivePlanId) out.liveActivePlan = window._liveActivePlanId;
    return { updates: out, ids, del, act };
}

function livePlansPushed(pp) {
    if (!pp) return;
    pp.ids.forEach(id => window._livePlansDirty.delete(id));
    pp.del.forEach(id => window._livePlansDeleted.delete(id));
    if (pp.act) window._dirtyLiveActive = false;
}

/* Données distantes (avant le recalcul d'applyFormData). Renvoie vrai s'il faut envoyer
   nos plans Live en mémoire parce que la session n'en a pas encore. */
function livePlansApplyRemote(data) {
    const remote = data && data.livePlans;
    if (!remote) {
        if (!window._livePlans.length) return false;
        window._livePlans.forEach(p => window._livePlansDirty.add(p.id));
        window._dirtyLiveActive = true;
        return true;
    }
    const list = Object.keys(remote)
        .map(id => Object.assign({ id }, remote[id]))
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .map(p => ({
            id: p.id, name: p.name || ('Plan ' + p.id),
            pitState: p.pitState || {}, startTyres: p.startTyres || { left: 'none', right: 'none' },
            manualCount: p.manualCount || 0,
            pitTotal: (typeof p.pitTotal === 'number') ? p.pitTotal : null
        }));
    if (!list.length) return false;
    const local = new Map(window._livePlans.map(p => [p.id, p]));
    const editing = !!document.querySelector('#liveStrategyTableBody [data-local-editing="true"]');
    const act = window._liveActivePlanId;
    // nos modifications pas encore envoyées (ou une saisie en cours) priment sur la version distante
    const merged = list.map(p => {
        const l = local.get(p.id);
        return (l && (window._livePlansDirty.has(p.id) || (editing && p.id === act))) ? l : p;
    });
    window._livePlans.forEach(l => {
        if (window._livePlansDirty.has(l.id) && !merged.some(p => p.id === l.id)) merged.push(l);
    });
    window._livePlans = merged.filter(p => !window._livePlansDeleted.has(p.id));
    if (!window._livePlans.length) return false;
    if (!window._dirtyLiveActive && data.liveActivePlan && window._livePlans.some(p => p.id === data.liveActivePlan))
        window._liveActivePlanId = data.liveActivePlan;
    if (!window._livePlans.some(p => p.id === window._liveActivePlanId)) window._liveActivePlanId = window._livePlans[0].id;
    window._manualStintCountLive = (_liveActive() && _liveActive().manualCount) || 0;
    window._livePlanUi = (window._livePlanUi === 'rename') ? 'rename' : null;
    livePlansPersist();
    livePlansRender();
    return false;
}

/* Appelé par calculate() après un calcul Live : durée totale des arrêts du plan Live affiché */
function liveSetPitTotal(sec) {
    const p = _liveActive();
    if (!p) return;
    p.pitTotal = Math.round(sec);
    document.querySelectorAll(`#planBarLive [data-lpit-for="${p.id}"]`)
        .forEach(el => { el.textContent = '⏱ Pit Σ ' + _plansFmtPit(p.pitTotal); });
}

/* ── Barre des plans Live ── */
function livePlansRender() {
    const bar = document.getElementById('planBarLive');
    if (!bar) return;
    const label = '<span class="plan-live-label">📋 Plans Live :</span>';
    const cur = _liveActive();
    let html;
    if (!cur) {
        html = label
             + '<span class="plan-live-label">aucun — ils sont copiés depuis la planification au clic sur « Connecter »</span>'
             + '<button type="button" class="plan-act" data-lact="recopy-ok" title="Copier maintenant les plans de la planification dans le Live">📋 Copier les plans</button>';
    } else if (window._livePlanUi === 'rename') {
        html = label
             + `<input type="text" id="livePlanNameInput" class="plan-input" maxlength="40" value="${_plansEsc(cur.name)}">`
             + '<button type="button" class="plan-act" data-lact="rename-ok">✔ OK</button>'
             + '<button type="button" class="plan-act" data-lact="cancel">Annuler</button>';
    } else if (window._livePlanUi === 'delete') {
        html = label
             + `<span class="plan-confirm">Supprimer « ${_plansEsc(cur.name)} » du Live ?</span>`
             + '<button type="button" class="plan-act plan-del" data-lact="del-ok">🗑 Supprimer</button>'
             + '<button type="button" class="plan-act" data-lact="cancel">Annuler</button>';
    } else if (window._livePlanUi === 'recopy') {
        html = label
             + '<span class="plan-confirm">Remplacer tous les plans Live par une copie de la planification ?</span>'
             + '<button type="button" class="plan-act plan-del" data-lact="recopy-ok">↻ Remplacer</button>'
             + '<button type="button" class="plan-act" data-lact="cancel">Annuler</button>';
    } else {
        html = label;
        window._livePlans.forEach(p => {
            const on = p.id === cur.id;
            html += `<button type="button" class="plan-tab${on ? ' active' : ''}" data-lplan="${_plansEsc(p.id)}" title="Afficher ce plan dans le Live (sans effet sur la planification)">${_plansEsc(p.name)}<span class="plan-pit" data-lpit-for="${_plansEsc(p.id)}">⏱ Pit Σ ${_plansFmtPit(p.pitTotal)}</span></button>`;
        });
        html += '<button type="button" class="plan-act" data-lact="rename" title="Renommer le plan Live affiché">✎ Modifier</button>';
        html += '<button type="button" class="plan-act plan-add" data-lact="add" title="Nouveau plan Live vierge">+ Plan</button>';
        html += '<button type="button" class="plan-act" data-lact="dup" title="Dupliquer le plan Live affiché">⧉ Dupliquer</button>';
        if (window._livePlans.length > 1)
            html += '<button type="button" class="plan-act plan-del" data-lact="del" title="Supprimer le plan Live affiché">🗑 Supprimer</button>';
        html += '<button type="button" class="plan-act" data-lact="recopy" title="Remplacer les plans Live par une nouvelle copie de la planification">↻ Recopier la planification</button>';
    }
    bar.innerHTML = html;
    const inp = document.getElementById('livePlanNameInput');
    if (inp) { inp.focus(); inp.select(); }
}

(function () {
    const bar = document.getElementById('planBarLive');
    if (!bar) return;
    bar.addEventListener('click', e => {
        const tab = e.target.closest('.plan-tab');
        if (tab) { livePlansSwitch(tab.dataset.lplan); return; }
        const act = e.target.closest('.plan-act');
        if (!act) return;
        const a = act.dataset.lact;
        if (a === 'add')       livePlansAdd(false);
        if (a === 'dup')       livePlansAdd(true);
        if (a === 'rename')    livePlansRename();
        if (a === 'rename-ok') livePlansRename(document.getElementById('livePlanNameInput').value);
        if (a === 'del')       livePlansDelete();
        if (a === 'del-ok')    livePlansDelete(true);
        if (a === 'recopy')    livePlansRecopy();
        if (a === 'recopy-ok') livePlansRecopy(true);
        if (a === 'cancel')    { window._livePlanUi = null; livePlansRender(); }
    });
    bar.addEventListener('keydown', e => {
        if (e.target.id !== 'livePlanNameInput') return;
        if (e.key === 'Enter') livePlansRename(e.target.value);
        if (e.key === 'Escape') { window._livePlanUi = null; livePlansRender(); }
    });
    livePlansRender();
})();
