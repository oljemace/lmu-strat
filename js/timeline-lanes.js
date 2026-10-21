/* ── Timeline par pilote + gommes (planification uniquement) ──
   • Une ligne par pilote ; chaque stint est un bloc placé sur la ligne de son pilote.
     Glisser un bloc :
       - sur une autre ligne  → change le pilote du stint ;
       - vers un autre créneau → échange les pilotes des deux créneaux.
     Les créneaux (durée de roulage + arrêt) restent FIXES : seule l'affectation des
     pilotes bouge. La durée ne change que si le Refuel est modifié dans la table.
   • Sous les pilotes, deux lignes « Pneus G » / « Pneus D ». On y glisse une gomme depuis
     le stock (icônes rondes au-dessus de la timeline) ; elle se pose au début du créneau le
     plus proche (= arrêt au stand précédent, ou départ de course pour le 1er créneau).
     Sa barre de vie reprend le calcul des anciennes barres (usure/tour → tours max) mais
     est convertie en temps à travers les créneaux, donc alignée sur les stints.
     Une barre se déplace en la glissant, et se retire en la lâchant hors des lignes
     (ou double-clic) : la gomme retourne au stock.
   Source de vérité inchangée : pitState[i].tyreLeft/tyreRight (arrêt après le stint i)
   et window._startTyres (départ) — la table des stints reste synchronisée. */

const LANE_LABEL_W = 150;
const TYRE_ORDER = ['soft', 'medium', 'hard', 'wet'];
const TYRE_UI = {
    soft:   { color: '#dddddd', letter: 'S', name: 'Soft'   },
    medium: { color: '#ffcc00', letter: 'M', name: 'Medium' },
    hard:   { color: '#ff6060', letter: 'H', name: 'Hard'   },
    wet:    { color: '#3399ff', letter: 'W', name: 'Wet'    },
};
let _laneCtxs = { plan: null, live: null };   // contexte du dernier rendu (créneaux, lignes pneus) pour le glisser depuis le stock
const _laneCtxOf = live => _laneCtxs[live ? 'live' : 'plan'];
/* Table des stints liée à la timeline (planification ou live) */
const _laneTbody = live => document.getElementById(live ? 'liveStrategyTableBody' : 'strategyTableBody');
const _laneRow = (i, live) => { const tb = _laneTbody(live); return tb && tb.querySelector(`tr[data-stint-idx="${i}"]`); };
/* Recalcul de la bonne vue. */
function _laneRecalc(live) {
    if (live) { if (typeof recalculateLive === 'function') recalculateLive(true); }
    else calculate();
}
/* Seul le rôle « lecture seule » ne peut pas modifier. Un ingénieur / pilote qui ne conduit pas (live à distance)
   ajuste les stints futurs ; le stint en cours (créneau 0) n'est jamais modifiable en live. */
function _laneReadOnly() { return window._teamRole === 'viewer'; }
const _laneRemote = live => !!(live && typeof liveRemoteReadOnly === 'function' && liveRemoteReadOnly());

function _lanesCommit(live) {
    // Live local : recalculateLive() pousse déjà pitState. Live à distance : il ne pousse rien,
    // on envoie donc la stratégie (pitState) ici, sans toucher à l'état live du pilote.
    if (live && !_laneRemote(live)) return;
    try { _dirtyPitState = true; } catch (e) { /* firebase-sync non chargé */ }
    try { pushToFirebase(true); } catch (e) { /* hors équipe / hors ligne */ }
}

function _lanesApplyDrivers(newDrivers, live) {
    // newDrivers : { stintIdx: driverIdx }
    Object.keys(newDrivers).forEach(k => {
        const i = parseInt(k);
        if (!pitState[i]) pitState[i] = defaultState();
        pitState[i].driver   = newDrivers[k];
        pitState[i]._userSet = true;
        // calculate() relit les contrôles de la table (savePitState) : le menu pilote
        // de la ligne doit donc refléter le changement, sinon il l'écraserait.
        const sel = _laneRow(i, live)?.querySelector('.driver-select');
        if (sel) sel.value = String(newDrivers[k]);
    });
    _laneRecalc(live);
    _lanesCommit(live);
}

/* Gommes posées sur un côté : [{slot, compound}] (slot 0 = départ, slot j = arrêt après le stint j-1) */
function _laneFitments(side, nSlots, live) {
    const out = [];
    let c0 = (window._startTyres || {})[side] || 'none';
    // Live : les gommes actuellement montées sont celles de la voiture
    if (live && window._liveModeActive && window._liveTyreState)
        c0 = (side === 'left' ? window._liveTyreState.compoundLeft : window._liveTyreState.compoundRight) || 'none';
    if (c0 !== 'none') out.push({ slot: 0, compound: c0 });
    for (let j = 1; j < nSlots; j++) {
        const ps = pitState[j - 1];
        if (!ps || !ps.stop) continue;
        const c = side === 'left' ? ps.tyreLeft : ps.tyreRight;
        if (c && c !== 'none') out.push({ slot: j, compound: c });
    }
    return out;
}

/* ops : [{side, slot, compound}] ; compound 'none' = retirer. Un seul recalcul à la fin. */
function _tyresApply(ops, live) {
    let startChanged = false;
    ops.forEach(op => {
        const c = op.compound;
        if (op.slot === 0 && live) {
            return;   // live : les gommes montées ne se changent pas depuis la timeline
        } else if (op.slot === 0) {
            window._startTyres = Object.assign({ left: 'none', right: 'none' }, window._startTyres, { [op.side]: c });
            const sel = document.getElementById(op.side === 'left' ? 'startTyreLeft' : 'startTyreRight');
            if (sel) sel.value = c;
            startChanged = true;
        } else {
            const i = op.slot - 1;
            if (!pitState[i]) pitState[i] = defaultState();
            const ps = pitState[i];
            const tr = _laneRow(i, live);
            if (c !== 'none') {
                ps.stop = true;   // une gomme n'est posée que si l'arrêt a lieu
                const cb = tr && tr.querySelector('.stop-check');
                if (cb) cb.checked = true;
            }
            ps[op.side === 'left' ? 'tyreLeft' : 'tyreRight'] = c;
            ps[op.side] = c !== 'none';
            ps._userSet = true;
            // savePitState() relit la table : y refléter le choix (voir _lanesApplyDrivers)
            const sel = tr && tr.querySelector(`.tyre-compound-select[data-side="${op.side}"]`);
            if (sel) sel.value = c;
        }
    });
    if (startChanged) {
        _applyStartTyreSelectStyle('startTyreLeft',  window._startTyres.left);
        _applyStartTyreSelectStyle('startTyreRight', window._startTyres.right);
        _updateStartTyreLifeInfo();
        try { _dirtyFields.add('_startTyres'); } catch (e) { /* ignore */ }
    }
    _laneRecalc(live);
    if (!live) updateTyreGauge();
    _lanesCommit(live);
}

/* Stock global (toutes gommes confondues) : restant = « Stock de pneus neufs » − 2 pneus par gomme posée. */
function _updateTyreStock(fitL, fitR, live) {
    const rem = document.getElementById(live ? 'liveTyreStockRemaining' : 'tyreStockRemaining');
    if (!rem) return;
    const liveBudget = document.getElementById('liveTyreBudget')?.value;
    // Live : le stock est la valeur du champ « Stock pneus restant » (vide = inconnu)
    if (live && (liveBudget === '' || liveBudget == null)) {
        rem.textContent = '-'; rem.style.color = 'var(--text)'; rem.title = 'Renseigner « Stock pneus restant »';
        const t0 = document.getElementById('liveTyreStockTotal'); if (t0) t0.textContent = '-';
        return;
    }
    const total = live ? (parseInt(liveBudget) || 0) : (parseInt(document.getElementById('tyreBudget')?.value) || 0);
    // Live : la gomme déjà montée (créneau 0) n'est plus dans le stock
    const n = f => f.filter(x => !(live && x.slot === 0)).length;
    const used = 2 * (n(fitL) + n(fitR));
    const left = total - used;
    rem.textContent = left;
    rem.style.color = left < 0 ? '#ff4444' : left === 0 ? '#ffaa00' : 'var(--text)';
    rem.title = left < 0 ? `${-left} pneu(x) à réutiliser !` : `${used} utilisé(s) sur ${total}`;
    const t = document.getElementById(live ? 'liveTyreStockTotal' : 'tyreStockTotal');
    if (t) t.textContent = total;
}

/* Glisser une gomme (depuis le stock ou une barre déjà posée) vers une ligne G / D. */
function _startTyreDrag(ev, info) {
    if (ev.button !== 0 || !_laneCtxOf(info.live) || _laneReadOnly()) return;
    ev.preventDefault();
    const ui = TYRE_UI[info.compound];
    const ghost = document.createElement('div');
    ghost.className = 'tyre-stock-icon';
    ghost.style.cssText = `--tc:${ui.color};position:fixed;left:0;top:0;pointer-events:none;z-index:9999;opacity:0.9;`
        + `transform:translate(${ev.clientX - 20}px,${ev.clientY - 20}px);`;
    ghost.textContent = ui.letter;
    document.body.appendChild(ghost);
    if (info.srcEl) info.srcEl.style.opacity = '0.3';
    const grab = info.srcEl ? ev.clientX - info.srcEl.getBoundingClientRect().left : 0;

    const locate = (cx, cy) => {
        const ctx = _laneCtxOf(info.live);
        let side = null;
        ['left', 'right'].forEach(sd => {
            const r = ctx.rows[sd].getBoundingClientRect();
            if (cy >= r.top - 6 && cy <= r.bottom + 6 && cx >= r.left - 20 && cx <= r.right + 20) side = sd;
        });
        if (!side) return null;
        const r = ctx.rows[side].getBoundingClientRect();
        const refX = info.srcEl ? cx - grab : cx;   // barre déplacée : on aligne son bord gauche
        const sec = Math.min(Math.max((refX - r.left) / r.width, 0), 1) * ctx.total;
        const cand = ctx.slots.filter(s => !(info.live && s.idx === 0));   // live : créneau 0 = gommes montées
        if (!cand.length) return null;
        let best = cand[0];
        cand.forEach(s => { if (Math.abs(s.start - sec) < Math.abs(best.start - sec)) best = s; });
        return { side, slot: best.idx, start: best.start };
    };
    const showMarker = t => {
        ['left', 'right'].forEach(sd => {
            const m = _laneCtxOf(info.live).rows[sd].querySelector('.tyre-drop-marker');
            if (!m) return;
            if (t && t.side === sd) { m.style.display = 'block'; m.style.left = `${t.start / _laneCtxOf(info.live).total * 100}%`; m.style.background = ui.color; }
            else m.style.display = 'none';
        });
    };
    const move = e => {
        ghost.style.transform = `translate(${e.clientX - 20}px,${e.clientY - 20}px)`;
        showMarker(locate(e.clientX, e.clientY));
    };
    const finish = e => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', finish);
        document.removeEventListener('pointercancel', finish);
        ghost.remove();
        showMarker(null);
        const t = e.type === 'pointercancel' ? null : locate(e.clientX, e.clientY);
        const ops = [];
        if (info.fromSide) ops.push({ side: info.fromSide, slot: info.fromSlot, compound: 'none' });
        if (t) ops.push({ side: t.side, slot: t.slot, compound: info.compound });
        // Rien à faire : pose depuis le stock hors ligne, ou barre lâchée là où elle était
        if (!ops.length || (t && info.fromSide === t.side && info.fromSlot === t.slot)) {
            if (info.srcEl) info.srcEl.style.opacity = '';
            return;
        }
        _tyresApply(ops, info.live);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
}

/* Icônes du stock : branchées une seule fois (le contexte de rendu est relu au moment du glisser). */
(function initTyreStock() {
    document.querySelectorAll('#tyreStockStrip .tyre-stock-icon[data-compound], #liveTyreStockStrip .tyre-stock-icon[data-compound]').forEach(icon => {
        const live = !!icon.closest('#liveTyreStockStrip');
        icon.addEventListener('pointerdown', ev => _startTyreDrag(ev, { compound: icon.dataset.compound, live }));
    });
})();

function renderDriverLanes(wrapper, stints, lapTime, realStart, totalRealSec, live) {
    live = !!live;
    _laneCtxs[live ? 'live' : 'plan'] = null;
    if (!(totalRealSec > 0) || !stints.length) return;

    // Créneaux : début de roulage, durée de roulage et tours cumulés de chaque stint.
    // Live : le premier stint commence « maintenant » (même ancrage que calculate()).
    const slots = [];
    let cum = 0, cumLaps = 0;
    if (live) {
        let n = window._liveNowSec || 0;
        if (realStart + totalRealSec > 86400 && n < realStart && n < 43200) n += 86400;
        cum = Math.max(0, n - realStart);
    }
    stints.forEach((stint, idx) => {
        const drive = stint.tours * lapTime;
        const pit   = idx < stints.length - 1 ? getPitDuration(idx) : 0;
        slots.push({ idx, start: cum, drive, end: cum + drive + pit, lapsBefore: cumLaps, tours: stint.tours });
        cum += drive + pit;
        cumLaps += stint.tours;
    });
    const driverOf = i => (pitState[i] || defaultState()).driver ?? -1;

    // Lignes : tous les pilotes déclarés + "Non assigné" si nécessaire.
    const lanes = [];
    for (let d = 0; d < getDriverCount(); d++) lanes.push(d);
    if (slots.some(s => driverOf(s.idx) < 0 || driverOf(s.idx) >= getDriverCount())) lanes.push(-1);

    const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    const fmtH = s => `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
    const fmtM = s => `${Math.round(s / 60)}m`;
    const NT = 8;
    const tyreEnds = [];   // fins de vie des gommes (aimantation lors du redimensionnement d'un stint)
    const evLap  = parseFloat(document.getElementById(live ? 'evPerLapReal' : 'evPerLap')?.value) || 0;
    const evTank = Math.min(100, parseFloat(document.getElementById('evRefuelPerStint')?.value) || 100);

    // Ligne « maintenant » (même normalisation que l'axe réel de buildTimeline)
    const _d = new Date();
    let nowSec = _d.getHours() * 3600 + _d.getMinutes() * 60 + _d.getSeconds();
    if (realStart + totalRealSec > 86400 && nowSec < realStart) nowSec += 86400;
    const nowPct = (nowSec - realStart) / totalRealSec * 100;

    const box = document.createElement('div');
    box.className = 'driver-lanes';
    box.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin:4px 0;user-select:none;';

    const decorate = track => {
        for (let i = 1; i < NT; i++) {
            const g = document.createElement('div');
            g.style.cssText = `position:absolute;left:${i / NT * 100}%;top:0;bottom:0;width:1px;background:rgba(var(--fg-rgb),0.06);pointer-events:none;`;
            track.appendChild(g);
        }
        if (nowPct >= 0 && nowPct <= 100) {
            const n = document.createElement('div');
            n.style.cssText = `position:absolute;left:${nowPct}%;top:0;bottom:0;width:2px;background:var(--text);box-shadow:0 0 6px rgba(var(--fg-rgb),0.7);pointer-events:none;z-index:3;`;
            track.appendChild(n);
        }
    };
    const makeRow = (labelHtml, trackHeight) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;';
        const lbl = document.createElement('div');
        lbl.style.cssText = `width:${LANE_LABEL_W}px;flex:none;padding-right:8px;overflow:hidden;`;
        lbl.innerHTML = labelHtml;
        row.appendChild(lbl);
        const track = document.createElement('div');
        track.style.cssText = `position:relative;flex:1;height:${trackHeight}px;background:rgba(0,0,0,0.25);border-radius:6px;transition:background 0.15s;`;
        decorate(track);
        row.appendChild(track);
        box.appendChild(row);
        return track;
    };

    /* ── Lignes pilotes ── */
    const tracks = [];   // { driver, el }
    lanes.forEach(d => {
        const mine = slots.filter(s => driverOf(s.idx) === d || (d === -1 && driverOf(s.idx) >= getDriverCount()));
        const sec = mine.reduce((a, s) => a + s.drive, 0);
        const color = d >= 0 ? getDriverColor(d) : '#777';
        const name  = d >= 0 ? getDriverName(d) : 'Non assigné';

        const track = makeRow(
            `<div style="display:flex;align-items:center;gap:6px;color:var(--text);font-weight:bold;font-size:0.85em;white-space:nowrap;">`
            + `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${color};flex:none;"></span>`
            + `<span style="overflow:hidden;text-overflow:ellipsis;">${esc(name)}</span></div>`
            + `<div style="color:var(--text-3);font-size:0.72em;padding-left:15px;">${fmtH(sec)} · ${mine.length} stint${mine.length > 1 ? 's' : ''}</div>`,
            44);
        track.dataset.lane = d;

        mine.forEach(s => {
            const blk = document.createElement('div');
            blk.dataset.slot = s.idx;
            const fg = (parseInt(color.slice(1, 3), 16) * 0.299 + parseInt(color.slice(3, 5), 16) * 0.587 + parseInt(color.slice(5, 7), 16) * 0.114) > 128 ? '#000' : '#fff';
            blk.style.cssText = `position:absolute;top:4px;bottom:4px;left:${s.start / totalRealSec * 100}%;width:calc(${s.drive / totalRealSec * 100}% - 2px);`
                + `background:linear-gradient(135deg,${color},${color}bb);color:${fg};border:1px solid rgba(255,255,255,0.25);border-radius:5px;`
                + `display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1.15;font-weight:bold;font-size:0.78em;overflow:hidden;white-space:nowrap;cursor:grab;touch-action:none;z-index:1;`;
            // Refuel : recharge de l'arrêt qui précède le stint (1er stint : VE au départ)
            const pvPs = s.idx > 0 ? pitState[s.idx - 1] : null;
            const rfVal = s.idx === 0 ? stints[0].evDebut : (pvPs && pvPs.stop && pvPs.refuel ? (pvPs.refuelPct || 0) : 0);
            if (s.drive / totalRealSec > 0.02) {
                const d1 = document.createElement('span'); d1.className = 'stint-dur'; d1.textContent = fmtM(s.drive);
                const d2 = document.createElement('span'); d2.style.cssText = 'font-size:0.82em;font-weight:600;opacity:0.85;'; d2.textContent = `⛽${+rfVal.toFixed(1)}%`;
                blk.appendChild(d1); blk.appendChild(d2);
            }
            blk.dataset.refuel = rfVal;
            blk.title = `Stint ${s.idx + 1} — ${stints[s.idx].tours.toFixed(1)} tours (${fmtM(s.drive)}) · ${formatClock(realStart + s.start)}`
                + `\n⛽ ${s.idx === 0 ? 'VE au départ' : 'Refuel à l\'arrêt précédent'} : ${+rfVal.toFixed(1)} %`;
            if (!_laneReadOnly() && !(live && s.idx === 0)) attachDrag(blk, s, track);   // live : stint en cours figé
            if (canResize(s.idx)) attachResize(blk, s, track);
            track.appendChild(blk);
        });
        tracks.push({ driver: d, el: track });
    });

    /* ── Lignes pneus G / D ── */
    const fitL = _laneFitments('left',  slots.length, live);
    const fitR = _laneFitments('right', slots.length, live);
    const lapsToTime = L => {
        for (const s of slots) if (L <= s.lapsBefore + s.tours) return s.start + Math.max(0, L - s.lapsBefore) * lapTime;
        return totalRealSec;
    };
    const tyreRows = {};
    [['left', '🔵 Pneus G', fitL], ['right', '🟠 Pneus D', fitR]].forEach(([side, title, fits]) => {
        const track = makeRow(`<div style="color:var(--text-2);font-weight:bold;font-size:0.8em;white-space:nowrap;">${title}</div>`, 28);
        track.dataset.tyreSide = side;
        track.style.border = '1px dashed rgba(var(--fg-rgb),0.12)';
        const marker = document.createElement('div');
        marker.className = 'tyre-drop-marker';
        marker.style.cssText = 'display:none;position:absolute;top:-2px;bottom:-2px;width:3px;border-radius:2px;pointer-events:none;z-index:4;';
        track.appendChild(marker);

        fits.forEach((f, k) => {
            const slot = slots[f.slot];
            const ui = TYRE_UI[f.compound] || { color: '#aaa', letter: '?', name: f.compound };
            // Live : gomme montée = usure mesurée + vie restante ; gommes futures = usure mesurée de ce composé
            // (mémoire de session), sinon théorique, sinon base circuits, sinon inconnue
            const wear = (live && window._liveModeActive)
                ? (f.slot === 0 ? getSideWear(side, f.compound, 0) : getLiveWearRate(side, f.compound))
                : getSideWearTheoretical(side, f.compound);
            const maxLaps = wear > 0 ? getTyreMaxLaps(wear) : 0;
            const nextStart = k + 1 < fits.length ? slots[fits[k + 1].slot].start : totalRealSec;
            const lifeEnd = maxLaps > 0 ? lapsToTime(slot.lapsBefore + maxLaps) : nextStart;
            const endT = Math.min(lifeEnd, nextStart, totalRealSec);
            if (endT <= slot.start) return;
            const worn = maxLaps > 0 && lifeEnd < nextStart - 1;   // usée avant le prochain changement

            const seg = document.createElement('div');
            seg.style.cssText = `position:absolute;top:3px;bottom:3px;left:${slot.start / totalRealSec * 100}%;`
                + `width:calc(${(endT - slot.start) / totalRealSec * 100}% - 2px);background:${maxLaps > 0 ? ui.color : 'repeating-linear-gradient(45deg,' + ui.color + '88,' + ui.color + '88 6px,transparent 6px,transparent 12px)'};`
                + `color:#000;font-weight:bold;font-size:0.7em;border-radius:4px;display:flex;align-items:center;padding:0 6px;overflow:hidden;white-space:nowrap;`
                + `cursor:grab;touch-action:none;z-index:2;${worn ? 'outline:2px solid #ff3333;' : ''}`
                + (maxLaps > 0 && maxLaps < slot.tours ? 'animation:tyre-blink 0.9s infinite;' : '');
            const toursStint = evLap > 0 ? evTank / evLap : 0;   // tours d'un stint plein
            const nStints = (maxLaps > 0 && toursStint > 0) ? maxLaps / toursStint : 0;
            const unknownMounted = live && !(maxLaps > 0);
            seg.textContent = maxLaps > 0 ? `${ui.letter} · ${maxLaps.toFixed(1)}t${nStints > 0 ? ` · ${nStints.toFixed(1)} st` : ''}`
                : (unknownMounted ? `${ui.letter} · roulez 3 tours minimum pour afficher la durée de vie` : `${ui.letter} · ?`);
            if (maxLaps > 0 && lifeEnd < totalRealSec) tyreEnds.push({ slot: f.slot, t: lifeEnd });
            seg.title = `${ui.name} ${side === 'left' ? 'Gauche' : 'Droit'} — `
                + (maxLaps > 0 ? `${maxLaps.toFixed(1)} tours${nStints > 0 ? ` = ${nStints.toFixed(1)} stints` : ''} (${(maxLaps * lapTime / 60).toFixed(0)} min), posé à ${formatClock(realStart + slot.start)}`
                               : (unknownMounted ? 'durée de vie inconnue : effectuer au minimum 3 tours (ou renseigner l\'usure %/tour / la base circuits)' : 'durée inconnue (renseigner l\'usure %/tour de cette gomme)'))
                + (worn ? ' — USÉE avant le prochain changement' : '')
                + ((live && f.slot === 0) ? ' (gomme montée)' : '\nGlisser : déplacer · hors des lignes ou double-clic : retirer');
            if (!(live && f.slot === 0) && !_laneReadOnly()) {   // live : gommes montées non modifiables
                seg.addEventListener('pointerdown', ev => _startTyreDrag(ev, { compound: f.compound, fromSide: side, fromSlot: f.slot, srcEl: seg, live }));
                seg.addEventListener('dblclick', () => _tyresApply([{ side, slot: f.slot, compound: 'none' }], live));
            } else seg.style.cursor = 'default';
            track.appendChild(seg);
        });
        tyreRows[side] = track;
    });

    _laneCtxs[live ? 'live' : 'plan'] = { rows: tyreRows, slots, total: totalRealSec };
    _updateTyreStock(fitL, fitR, live);

    /* ── Durée d'un stint : étirer le bord droit du bloc ──
       Même logique de calcul qu'avant : la durée d'un stint est bornée par l'énergie (VE) au moment
       où il démarre = VE restante à l'arrivée au stand + refuel de l'arrêt précédent (max 100 %).
       Étirer le bloc règle donc le refuel de l'arrêt qui le précède (stint 1 en planification : la VE de départ).
       Le dernier stint absorbe le temps restant : il n'est pas étirable. En live le stint en cours est figé. */
    function canResize(idx) {
        return evLap > 0 && idx < stints.length - 1 && !(live && idx === 0) && !_laneReadOnly();   // live : stint en cours figé
    }
    function resizeLimits(idx) {
        // durée de roulage min / max (secondes) du stint idx
        let minS = 0;
        if (idx > 0) { const pv = stints[idx - 1]; minS = Math.max(0, pv.evDebut - pv.tours * evLap) + 0.1; }
        const minT = Math.max(1, minS / evLap), maxT = evTank / evLap;
        return { min: Math.min(minT, maxT) * lapTime, max: maxT * lapTime };
    }
    function applyResize(idx, newDrive) {
        const lim = resizeLimits(idx);
        const T = Math.min(Math.max(newDrive, lim.min), lim.max) / lapTime;
        const newS = Math.min(evTank, Math.round(T * evLap * 10) / 10);   // VE au départ de ce stint
        if (idx === 0) {                                                   // 1er stint : VE de départ
            const el = document.getElementById('evRemaining');
            if (!el || +el.value === newS) return false;
            el.value = newS;
            try { _dirtyFields.add('evRemaining'); } catch (e) { /* ignore */ }
        } else {
            const pv = stints[idx - 1];
            const evFin = Math.max(0, pv.evDebut - pv.tours * evLap);
            const r = Math.min(100 - evFin, Math.max(0.1, Math.round((newS - evFin) * 10) / 10));
            if (!pitState[idx - 1]) pitState[idx - 1] = defaultState();
            const ps = pitState[idx - 1];
            if (ps.stop && ps.refuel && ps.refuelPct === r) return false;
            ps.stop = true; ps.refuel = true; ps.refuelPct = r; ps._userSet = true;
            const tr = _laneRow(idx - 1, live);
            const cb = tr && tr.querySelector('.stop-check'); if (cb) cb.checked = true;
            const inp = tr && tr.querySelector('.refuel-pct-input'); if (inp) inp.value = r;
        }
        return true;
    }
    function attachResize(blk, slot, track) {
        const h = document.createElement('div');
        h.style.cssText = 'position:absolute;right:0;top:0;bottom:0;width:8px;cursor:ew-resize;background:rgba(0,0,0,0.3);border-radius:0 5px 5px 0;touch-action:none;';
        h.title = 'Étirer pour régler la durée du stint (refuel de l\'arrêt précédent, max ' + evTank + ' % de VE)';
        blk.appendChild(h);
        h.addEventListener('pointerdown', ev => {
            if (ev.button !== 0) return;
            ev.preventDefault(); ev.stopPropagation();
            h.setPointerCapture(ev.pointerId);
            const x0 = ev.clientX, trackW = track.getBoundingClientRect().width || 1, lim = resizeLimits(slot.idx);
            let drive = slot.drive;
            const lbl = blk.querySelector('.stint-dur');
            // Aimantation : la fin du stint se cale sur la fin de vie d'une gomme posée au plus tard sur ce stint
            const cand = tyreEnds.filter(te => te.slot <= slot.idx).map(te => te.t - slot.start)
                .filter(d => d >= lim.min && d <= lim.max);
            const snapSec = 12 / trackW * totalRealSec;   // ~12 px
            const guide = Object.values(tyreRows).map(tr => {
                const g = document.createElement('div');
                g.style.cssText = 'display:none;position:absolute;top:-2px;bottom:-2px;width:2px;background:var(--accent);box-shadow:0 0 6px var(--accent);pointer-events:none;z-index:6;';
                tr.appendChild(g); return g;
            });
            const move = e => {
                drive = Math.min(Math.max(slot.drive + (e.clientX - x0) / trackW * totalRealSec, lim.min), lim.max);
                let snapped = null;
                cand.forEach(d => { if (Math.abs(d - drive) < snapSec && (snapped === null || Math.abs(d - drive) < Math.abs(snapped - drive))) snapped = d; });
                if (snapped !== null) drive = snapped;
                blk.style.width = `calc(${drive / totalRealSec * 100}% - 2px)`;
                blk.style.zIndex = 20;
                blk.style.outline = snapped !== null ? '2px solid var(--accent)' : '';
                guide.forEach(g => { g.style.display = snapped !== null ? 'block' : 'none'; g.style.left = `${(slot.start + drive) / totalRealSec * 100}%`; });
                if (lbl) lbl.textContent = fmtM(drive);
            };
            const done = e => {
                h.removeEventListener('pointermove', move);
                h.removeEventListener('pointerup', done);
                h.removeEventListener('pointercancel', done);
                guide.forEach(g => g.remove());
                blk.style.outline = '';
                if (e.type === 'pointercancel' || Math.abs(drive - slot.drive) < 1 || !applyResize(slot.idx, drive)) { _laneRecalc(live); return; }
                _laneRecalc(live);
                _lanesCommit(live);
            };
            h.addEventListener('pointermove', move);
            h.addEventListener('pointerup', done);
            h.addEventListener('pointercancel', done);
        });
    }

    function attachDrag(blk, slot, homeTrack) {
        blk.addEventListener('pointerdown', ev => {
            if (ev.button !== 0) return;
            ev.preventDefault();
            blk.setPointerCapture(ev.pointerId);
            const x0 = ev.clientX, y0 = ev.clientY;
            let moved = false;
            blk.style.cursor = 'grabbing';

            const target = (cx, cy) => {
                const t = tracks.find(t => { const r = t.el.getBoundingClientRect(); return cy >= r.top && cy <= r.bottom; });
                const r = homeTrack.getBoundingClientRect();
                const sec = Math.min(Math.max((cx - r.left) / r.width, 0), 0.99999) * totalRealSec;
                const sl = slots.find(s => sec >= s.start && sec < s.end) || slots[slots.length - 1];
                return { track: t, slot: sl };
            };
            const move = e => {
                const dx = e.clientX - x0, dy = e.clientY - y0;
                if (!moved && Math.hypot(dx, dy) < 4) return;
                moved = true;
                blk.style.transform = `translate(${dx}px,${dy}px)`;
                blk.style.zIndex = 20;
                blk.style.opacity = '0.85';
                blk.style.boxShadow = '0 6px 18px rgba(0,0,0,0.6)';
                const tg = target(e.clientX, e.clientY);
                tracks.forEach(t => { t.el.style.background = (t === tg.track) ? 'rgba(var(--accent-rgb),0.12)' : 'rgba(0,0,0,0.25)'; });
            };
            const up = e => {
                blk.removeEventListener('pointermove', move);
                blk.removeEventListener('pointerup', up);
                blk.removeEventListener('pointercancel', cancel);
                if (!moved) { blk.style.cursor = 'grab'; return; }
                const tg = target(e.clientX, e.clientY);
                if (!tg.track || (live && tg.slot.idx === 0)) { _laneRecalc(live); return; }   // lâché hors des lignes : annule
                const srcIdx = slot.idx, dstIdx = tg.slot.idx;
                const srcDriver = driverOf(srcIdx);
                const upd = {};
                if (dstIdx !== srcIdx) upd[srcIdx] = driverOf(dstIdx);   // le pilote déplacé prend la place…
                upd[dstIdx] = tg.track.driver;                           // …et la ligne visée reçoit le créneau
                if (dstIdx === srcIdx && tg.track.driver === srcDriver) { _laneRecalc(live); return; }
                _lanesApplyDrivers(upd, live);
            };
            const cancel = () => {
                blk.removeEventListener('pointermove', move);
                blk.removeEventListener('pointerup', up);
                blk.removeEventListener('pointercancel', cancel);
                _laneRecalc(live);
            };
            blk.addEventListener('pointermove', move);
            blk.addEventListener('pointerup', up);
            blk.addEventListener('pointercancel', cancel);
        });
    }

    wrapper.appendChild(box);
}
