/* ══════════════════════════════════════════════════════════════════
   PLANS MULTIPLES (Plan A, Plan B…) — mode planification

   Un plan = l'état propre à une stratégie : pitState (pilote, arrêts, refuel,
   pneus de chaque stint), pneus de départ et nombre de stints manuels.
   Les paramètres de course (durée, temps au tour, conso, pilotes, stock de
   pneus…) restent communs à tous les plans.

   Le plan AFFICHÉ (window._activePlanId) est PERSONNEL : chaque utilisateur
   regarde et modifie le plan de son choix, sans faire changer celui des autres.
   Il vit dans pitState / _startTyres / _manualStintCount (comme avant : tout le
   reste de l'appli est inchangé).
   Le plan de RÉFÉRENCE de l'équipe (window._refPlanId, Firebase : activePlan)
   est partagé. Le mode Live a ses propres plans, indépendants (voir live-plans.js).

   Firebase : plans/{id} = un enregistrement par plan, écrit seul (jamais tous
   les plans d'un coup, pour ne pas écraser le travail des autres sur un autre
   plan). pitState et _startTyres à la racine de la session recopient le plan
   de référence (lecture par le Live et les anciennes versions).
══════════════════════════════════════════════════════════════════ */
window._plans = [{ id: 'A', name: 'Plan A', pitState: {}, startTyres: { left: 'none', right: 'none' }, manualCount: 0, pitTotal: null }];
window._activePlanId = 'A';      // plan affiché par CET utilisateur
window._refPlanId = 'A';         // plan de référence de l'équipe (Live)
window._dirtyPlans = false;      // (compat)
window._plansDirty = new Set();  // plans à envoyer en entier
window._plansDeleted = new Set(); // plans supprimés à retirer de Firebase
window._dirtyRefPlan = false;    // plan de référence à renvoyer

function _plansClone(o) { return JSON.parse(JSON.stringify(o || {})); }
function _planActive() { return window._plans.find(p => p.id === window._activePlanId) || window._plans[0]; }

/* Mémorise le plan affiché, par session, dans ce navigateur */
function _plansViewKey() {
    return (typeof _sessionId !== 'undefined' && _sessionId) ? `lmuViewPlan.${window._teamId || ''}.${_sessionId}` : null;
}
function _plansStoreView(id) {
    try { const k = _plansViewKey(); if (k) localStorage.setItem(k, id); } catch (e) { /* stockage indisponible */ }
}
function _plansStoredView() {
    try { const k = _plansViewKey(); return k ? localStorage.getItem(k) : null; } catch (e) { return null; }
}

/* Recopie l'état courant dans l'entrée du plan affiché */
function plansSnapshot() {
    const p = _planActive();
    if (!p || window._stateCtx !== 'planning') return;   // sinon pitState appartient au Live
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

function _plansPush() { pushToFirebase(true); }

/* Changer de plan : ne concerne QUE cet utilisateur (rien n'est envoyé aux autres,
   sauf les modifications en attente sur le plan que l'on quitte). */
function plansSwitch(id) {
    if (id === window._activePlanId || window._liveMode) return;
    const target = window._plans.find(p => p.id === id);
    if (!target) return;
    _stateUse('planning');
    plansSnapshot();
    const old = _planActive();
    const hadEdits = (typeof _dirtyPitState !== 'undefined' && _dirtyPitState)
                  || (typeof _dirtyFields !== 'undefined' && _dirtyFields.has('_startTyres'));
    if (hadEdits && old) {
        // modifications pas encore envoyées : elles appartiennent au plan quitté
        window._plansDirty.add(old.id);
        _dirtyPitState = false;
        _dirtyFields.delete('_startTyres');
    }
    window._activePlanId = id;
    _plansLoadIntoState(target);
    _plansRecalc();
    plansRender();
    _plansStoreView(id);
    if (hadEdits) _plansPush();
}

function _plansNextId() {
    const used = new Set(window._plans.map(p => p.id));
    for (let c = 65; c <= 90; c++) { const id = String.fromCharCode(c); if (!used.has(id)) return id; }
    return 'P' + Date.now();
}

function plansAdd(duplicate) {
    if (window._liveMode) return;
    _stateUse('planning');
    plansSnapshot();
    const src = _planActive();
    const id = _plansNextId();
    const plan = duplicate
        ? { id, name: `${src.name} (copie)`, pitState: _plansClone(src.pitState), startTyres: _plansClone(src.startTyres), manualCount: src.manualCount }
        : { id, name: 'Plan ' + id, pitState: {}, startTyres: { left: 'none', right: 'none' }, manualCount: 0 };
    window._plans.push(plan);
    window._plansDirty.add(id);
    plansSwitch(id);
    _plansPush();
}

window._planUi = null;   // null | 'rename' | 'delete' (saisie dans la barre : prompt()/confirm() ne marchent pas dans l'appli de bureau)

function plansRename(name) {
    const p = _planActive();
    if (name === undefined) { window._planUi = 'rename'; plansRender(); return; }
    window._planUi = null;
    p.name = String(name).trim().slice(0, 40) || p.name;
    plansRender();
    plansSnapshot();
    window._plansDirty.add(p.id);
    pushToFirebase(false);
}

function plansDelete(confirmed) {
    if (window._plans.length <= 1 || window._liveMode) return;
    if (!confirmed) { window._planUi = 'delete'; plansRender(); return; }
    window._planUi = null;
    _stateUse('planning');
    const p = _planActive();
    window._plans = window._plans.filter(x => x.id !== p.id);
    window._plansDirty.delete(p.id);
    window._plansDeleted.add(p.id);
    if (p.id === window._refPlanId) {            // le plan de référence disparaît : le premier le remplace
        window._refPlanId = window._plans[0].id;
        window._dirtyRefPlan = true;
    }
    const next = window._plans.find(x => x.id === window._refPlanId) || window._plans[0];
    window._activePlanId = next.id;
    _plansLoadIntoState(next);
    _plansRecalc();
    plansRender();
    _plansStoreView(next.id);
    _plansPush();
}

/* Le plan affiché devient le plan de référence de l'équipe (celui du Live) */
function plansSetReference() {
    if (window._liveMode || window._activePlanId === window._refPlanId) return;
    _stateUse('planning');
    plansSnapshot();
    window._refPlanId = window._activePlanId;
    window._dirtyRefPlan = true;
    window._plansDirty.add(window._refPlanId);
    plansRender();
    _plansPush();
}

/* Au lancement du Live : le plan affiché devient la référence que tout le monde suit */
function plansPinReference() {
    if (window._activePlanId === window._refPlanId) return;
    window._refPlanId = window._activePlanId;
    window._dirtyRefPlan = true;
    plansRender();
}

/* Remise à zéro (bouton Reset) : un seul plan vierge */
function plansReset() {
    window._plans = [{ id: 'A', name: 'Plan A', pitState: {}, startTyres: { left: 'none', right: 'none' }, manualCount: 0 }];
    window._activePlanId = 'A';
    window._refPlanId = 'A';
    window._plansDirty = new Set();
    window._plansDeleted = new Set();
    window._dirtyRefPlan = false;
    plansRender();
}

/* Données distantes : liste des plans + plan de référence de l'équipe.
   Le plan affiché reste celui de l'utilisateur ; il change seulement à l'arrivée
   dans la session (dernier plan vu, sinon la référence), en Live (tout le monde suit
   la référence) ou si un autre l'a supprimé.
   Appelé avant la fusion de pitState dans applyFormData(). */
function plansApplyRemote(data) {
    // Première réception après l'arrivée dans une session : l'état local est vierge
    // (voir _resetLocalSessionState), il ne doit PAS « faire foi » sur le plan affiché.
    const freshJoin = !!window._plansFreshJoin;
    window._plansFreshJoin = false;
    if (!data || !data.plans) { plansRender(); return; }
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

    const ref = list.some(p => p.id === data.activePlan) ? data.activePlan : list[0].id;
    // Le plan de référence est recopié à la racine : c'est la version la plus à jour (anciennes sessions)
    const refRec = list.find(p => p.id === ref);
    if (data.pitState) refRec.pitState = data.pitState;
    if (data._startTyres) refRec.startTyres = data._startTyres;
    window._refPlanId = ref;

    const prevViewed = window._activePlanId;
    let viewed = prevViewed;
    if (freshJoin) {
        const stored = _plansStoredView();
        viewed = list.some(p => p.id === stored) ? stored : ref;
    }
    if (!list.some(p => p.id === viewed)) viewed = ref;
    const changed = freshJoin || viewed !== prevViewed;

    const i = list.findIndex(p => p.id === viewed);
    const local = _planActive();
    if (!changed && local && local.id === viewed) {
        // même plan affiché : l'état courant fait foi (il est déjà à jour / en cours d'édition)
        // sauf le nom et le total des arrêts, qui viennent de l'équipe
        if (window._planUi !== 'rename') local.name = list[i].name;
        if (list[i].pitTotal !== null) local.pitTotal = list[i].pitTotal;
        list[i] = local;
    }
    window._plans = list;
    window._activePlanId = viewed;
    if (changed) _plansLoadIntoState(list[i]);
    plansRender();
}

/* Version distante du plan AFFICHÉ (pour la fusion dans applyFormData) :
   la racine de la session pour le plan de référence, plans/{id} sinon. */
function plansRemoteViewState(data) {
    const id = window._activePlanId;
    if (!data.plans || id === window._refPlanId) return { pitState: data.pitState, startTyres: data._startTyres };
    const r = data.plans[id];
    return { pitState: r && r.pitState, startTyres: r && r.startTyres };
}

function _plansRecord(p, i) {
    return { name: p.name, order: i, pitState: _plansClone(p.pitState), startTyres: _plansClone(p.startTyres), manualCount: p.manualCount || 0, pitTotal: p.pitTotal };
}

/* Session complète (création d'une session) */
function plansCollect() {
    _stateUse('planning');
    plansSnapshot();
    const out = {};
    window._plans.forEach((p, i) => { out[p.id] = _plansRecord(p, i); });
    return { plans: out, activePlan: window._refPlanId };
}

/* Mise à jour PARTIELLE pour Firebase : uniquement le plan affiché s'il a changé,
   les plans marqués (nouveau, renommé…), les suppressions et la référence. */
function plansPartial(flags) {
    _stateUse('planning');
    plansSnapshot();
    const ids = new Set(window._plansDirty);
    if (flags && (flags.pit || flags.tyres)) ids.add(window._activePlanId);
    const out = {};
    window._plans.forEach((p, i) => {
        if (!ids.has(p.id)) return;
        out[`plans/${p.id}`] = _plansRecord(p, i);
        if (p.id === window._refPlanId) { out.pitState = _plansClone(p.pitState); out._startTyres = _plansClone(p.startTyres); }
    });
    const del = new Set(window._plansDeleted);
    del.forEach(id => { out[`plans/${id}`] = null; });
    const ref = !!window._dirtyRefPlan;
    if (ref) {
        out.activePlan = window._refPlanId;
        const rp = window._plans.find(p => p.id === window._refPlanId);
        if (rp) { out.pitState = _plansClone(rp.pitState); out._startTyres = _plansClone(rp.startTyres); }
    }
    return { updates: out, ids, del, ref };
}

/* Envoi réussi : on retire ce qui vient de partir */
function plansPushed(pp) {
    if (!pp) return;
    pp.ids.forEach(id => window._plansDirty.delete(id));
    pp.del.forEach(id => window._plansDeleted.delete(id));
    if (pp.ref) window._dirtyRefPlan = false;
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
            const on = p.id === act, isRef = p.id === window._refPlanId;
            html += `<button type="button" class="plan-tab${on ? ' active' : ''}" data-plan="${_plansEsc(p.id)}" title="${isRef ? 'Plan de référence de l\'équipe (utilisé en Live)' : 'Afficher ce plan (n\'affecte que vous)'}">${isRef ? '★ ' : ''}${_plansEsc(p.name)}<span class="plan-pit" data-pit-for="${_plansEsc(p.id)}">⏱ Pit Σ ${_plansFmtPit(p.pitTotal)}</span></button>`;
        });
        if (act !== window._refPlanId)
            html += `<button type="button" class="plan-act" data-act="ref" title="Définir ce plan comme plan de référence de l'équipe (celui du Live)">★ Référence</button>`;
        html += `<button type="button" class="plan-act" data-act="rename" title="Renommer le plan affiché">✎ Modifier</button>`;
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
        if (act.dataset.act === 'ref')    plansSetReference();
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
