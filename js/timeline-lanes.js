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
let _laneCtx = null;   // contexte du dernier rendu (créneaux, lignes pneus) pour le glisser depuis le stock

function _lanesCommit() {
    try { _dirtyPitState = true; } catch (e) { /* firebase-sync non chargé */ }
    try { pushToFirebase(true); } catch (e) { /* hors équipe / hors ligne */ }
}

function _lanesApplyDrivers(newDrivers) {
    // newDrivers : { stintIdx: driverIdx }
    Object.keys(newDrivers).forEach(k => {
        const i = parseInt(k);
        if (!pitState[i]) pitState[i] = defaultState();
        pitState[i].driver   = newDrivers[k];
        pitState[i]._userSet = true;
        // calculate() relit les contrôles de la table (savePitState) : le menu pilote
        // de la ligne doit donc refléter le changement, sinon il l'écraserait.
        const sel = document.querySelector(`tr[data-stint-idx="${i}"] .driver-select`);
        if (sel) sel.value = String(newDrivers[k]);
    });
    calculate();
    _lanesCommit();
}

/* Gommes posées sur un côté : [{slot, compound}] (slot 0 = départ, slot j = arrêt après le stint j-1) */
function _laneFitments(side, nSlots) {
    const out = [];
    const c0 = (window._startTyres || {})[side] || 'none';
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
function _tyresApply(ops) {
    let startChanged = false;
    ops.forEach(op => {
        const c = op.compound;
        if (op.slot === 0) {
            window._startTyres = Object.assign({ left: 'none', right: 'none' }, window._startTyres, { [op.side]: c });
            const sel = document.getElementById(op.side === 'left' ? 'startTyreLeft' : 'startTyreRight');
            if (sel) sel.value = c;
            startChanged = true;
        } else {
            const i = op.slot - 1;
            if (!pitState[i]) pitState[i] = defaultState();
            const ps = pitState[i];
            const tr = document.querySelector(`tr[data-stint-idx="${i}"]`);
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
    calculate();
    updateTyreGauge();
    _lanesCommit();
}

/* Stock global (toutes gommes confondues) : restant = « Stock de pneus neufs » − 2 pneus par gomme posée. */
function _updateTyreStock(fitL, fitR) {
    const rem = document.getElementById('tyreStockRemaining');
    if (!rem) return;
    const total = parseInt(document.getElementById('tyreBudget')?.value) || 0;
    const used = 2 * (fitL.length + fitR.length);
    const left = total - used;
    rem.textContent = left;
    rem.style.color = left < 0 ? '#ff4444' : left === 0 ? '#ffaa00' : '#fff';
    rem.title = left < 0 ? `${-left} pneu(x) à réutiliser !` : `${used} utilisé(s) sur ${total}`;
    const t = document.getElementById('tyreStockTotal');
    if (t) t.textContent = total;
}

/* Glisser une gomme (depuis le stock ou une barre déjà posée) vers une ligne G / D. */
function _startTyreDrag(ev, info) {
    if (ev.button !== 0 || !_laneCtx) return;
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
        const ctx = _laneCtx;
        let side = null;
        ['left', 'right'].forEach(sd => {
            const r = ctx.rows[sd].getBoundingClientRect();
            if (cy >= r.top - 6 && cy <= r.bottom + 6 && cx >= r.left - 20 && cx <= r.right + 20) side = sd;
        });
        if (!side) return null;
        const r = ctx.rows[side].getBoundingClientRect();
        const refX = info.srcEl ? cx - grab : cx;   // barre déplacée : on aligne son bord gauche
        const sec = Math.min(Math.max((refX - r.left) / r.width, 0), 1) * ctx.total;
        let best = ctx.slots[0];
        ctx.slots.forEach(s => { if (Math.abs(s.start - sec) < Math.abs(best.start - sec)) best = s; });
        return { side, slot: best.idx, start: best.start };
    };
    const showMarker = t => {
        ['left', 'right'].forEach(sd => {
            const m = _laneCtx.rows[sd].querySelector('.tyre-drop-marker');
            if (!m) return;
            if (t && t.side === sd) { m.style.display = 'block'; m.style.left = `${t.start / _laneCtx.total * 100}%`; m.style.background = ui.color; }
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
        _tyresApply(ops);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
}

/* Icônes du stock : branchées une seule fois (le contexte de rendu est relu au moment du glisser). */
(function initTyreStock() {
    document.querySelectorAll('#tyreStockStrip .tyre-stock-icon[data-compound]').forEach(icon => {
        icon.addEventListener('pointerdown', ev => _startTyreDrag(ev, { compound: icon.dataset.compound }));
    });
})();

function renderDriverLanes(wrapper, stints, lapTime, realStart, totalRealSec) {
    _laneCtx = null;
    if (!(totalRealSec > 0) || !stints.length) return;

    // Créneaux : début de roulage, durée de roulage et tours cumulés de chaque stint.
    const slots = [];
    let cum = 0, cumLaps = 0;
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
            g.style.cssText = `position:absolute;left:${i / NT * 100}%;top:0;bottom:0;width:1px;background:rgba(255,255,255,0.06);pointer-events:none;`;
            track.appendChild(g);
        }
        if (nowPct >= 0 && nowPct <= 100) {
            const n = document.createElement('div');
            n.style.cssText = `position:absolute;left:${nowPct}%;top:0;bottom:0;width:2px;background:#fff;box-shadow:0 0 6px rgba(255,255,255,0.7);pointer-events:none;z-index:3;`;
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
            `<div style="display:flex;align-items:center;gap:6px;color:#fff;font-weight:bold;font-size:0.85em;white-space:nowrap;">`
            + `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${color};flex:none;"></span>`
            + `<span style="overflow:hidden;text-overflow:ellipsis;">${esc(name)}</span></div>`
            + `<div style="color:#999;font-size:0.72em;padding-left:15px;">${fmtH(sec)} · ${mine.length} stint${mine.length > 1 ? 's' : ''}</div>`,
            44);
        track.dataset.lane = d;

        mine.forEach(s => {
            const blk = document.createElement('div');
            blk.dataset.slot = s.idx;
            const fg = (parseInt(color.slice(1, 3), 16) * 0.299 + parseInt(color.slice(3, 5), 16) * 0.587 + parseInt(color.slice(5, 7), 16) * 0.114) > 128 ? '#000' : '#fff';
            blk.style.cssText = `position:absolute;top:4px;bottom:4px;left:${s.start / totalRealSec * 100}%;width:calc(${s.drive / totalRealSec * 100}% - 2px);`
                + `background:linear-gradient(135deg,${color},${color}bb);color:${fg};border:1px solid rgba(255,255,255,0.25);border-radius:5px;`
                + `display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:0.78em;overflow:hidden;white-space:nowrap;cursor:grab;touch-action:none;z-index:1;`;
            blk.textContent = s.drive / totalRealSec > 0.02 ? fmtM(s.drive) : '';
            blk.title = `Stint ${s.idx + 1} — ${stints[s.idx].tours.toFixed(1)} tours (${fmtM(s.drive)}) · ${formatClock(realStart + s.start)}`;
            attachDrag(blk, s, track);
            track.appendChild(blk);
        });
        tracks.push({ driver: d, el: track });
    });

    /* ── Lignes pneus G / D ── */
    const fitL = _laneFitments('left',  slots.length);
    const fitR = _laneFitments('right', slots.length);
    const lapsToTime = L => {
        for (const s of slots) if (L <= s.lapsBefore + s.tours) return s.start + Math.max(0, L - s.lapsBefore) * lapTime;
        return totalRealSec;
    };
    const tyreRows = {};
    [['left', '🔵 Pneus G', fitL], ['right', '🟠 Pneus D', fitR]].forEach(([side, title, fits]) => {
        const track = makeRow(`<div style="color:#ccc;font-weight:bold;font-size:0.8em;white-space:nowrap;">${title}</div>`, 28);
        track.dataset.tyreSide = side;
        track.style.border = '1px dashed rgba(255,255,255,0.12)';
        const marker = document.createElement('div');
        marker.className = 'tyre-drop-marker';
        marker.style.cssText = 'display:none;position:absolute;top:-2px;bottom:-2px;width:3px;border-radius:2px;pointer-events:none;z-index:4;';
        track.appendChild(marker);

        fits.forEach((f, k) => {
            const slot = slots[f.slot];
            const ui = TYRE_UI[f.compound] || { color: '#aaa', letter: '?', name: f.compound };
            const wear = getSideWearTheoretical(side, f.compound);
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
            seg.textContent = maxLaps > 0 ? `${ui.letter} · ${maxLaps.toFixed(1)}t` : `${ui.letter} · ?`;
            seg.title = `${ui.name} ${side === 'left' ? 'Gauche' : 'Droit'} — `
                + (maxLaps > 0 ? `${maxLaps.toFixed(1)} tours (${(maxLaps * lapTime / 60).toFixed(0)} min), posé à ${formatClock(realStart + slot.start)}`
                               : 'durée inconnue (renseigner l\'usure %/tour de cette gomme)')
                + (worn ? ' — USÉE avant le prochain changement' : '')
                + '\nGlisser : déplacer · hors des lignes ou double-clic : retirer';
            seg.addEventListener('pointerdown', ev => _startTyreDrag(ev, { compound: f.compound, fromSide: side, fromSlot: f.slot, srcEl: seg }));
            seg.addEventListener('dblclick', () => _tyresApply([{ side, slot: f.slot, compound: 'none' }]));
            track.appendChild(seg);
        });
        tyreRows[side] = track;
    });

    _laneCtx = { rows: tyreRows, slots, total: totalRealSec };
    _updateTyreStock(fitL, fitR);

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
                tracks.forEach(t => { t.el.style.background = (t === tg.track) ? 'rgba(0,255,136,0.12)' : 'rgba(0,0,0,0.25)'; });
            };
            const up = e => {
                blk.removeEventListener('pointermove', move);
                blk.removeEventListener('pointerup', up);
                blk.removeEventListener('pointercancel', cancel);
                if (!moved) { blk.style.cursor = 'grab'; return; }
                const tg = target(e.clientX, e.clientY);
                if (!tg.track) { calculate(); return; }   // lâché hors des lignes : annule
                const srcIdx = slot.idx, dstIdx = tg.slot.idx;
                const srcDriver = driverOf(srcIdx);
                const upd = {};
                if (dstIdx !== srcIdx) upd[srcIdx] = driverOf(dstIdx);   // le pilote déplacé prend la place…
                upd[dstIdx] = tg.track.driver;                           // …et la ligne visée reçoit le créneau
                if (dstIdx === srcIdx && tg.track.driver === srcDriver) { calculate(); return; }
                _lanesApplyDrivers(upd);
            };
            const cancel = () => {
                blk.removeEventListener('pointermove', move);
                blk.removeEventListener('pointerup', up);
                blk.removeEventListener('pointercancel', cancel);
                calculate();
            };
            blk.addEventListener('pointermove', move);
            blk.addEventListener('pointerup', up);
            blk.addEventListener('pointercancel', cancel);
        });
    }

    wrapper.appendChild(box);
}
