/* ══════════════════════════════════════════════════════════════════
   📈 ÉCART AU 1ER DE LA CATÉGORIE, TOUR PAR TOUR (« race trace »)

   Le programme du pilote note l'heure de séance (ET) de chaque passage sur la
   ligne, pour chaque voiture (data.raceTrace, voir RaceTrace dans
   collector/lmu_telemetry_logger.py). Écart d'une voiture au tour N =
   son ET au tour N − l'ET du premier de SA catégorie à avoir bouclé ce tour.
   Chaque voiture est donc comparée au 1er de sa propre catégorie (Hyper, LMP2, GT3…).

   Les passages reçus sont fusionnés et gardés dans ce navigateur (par session) :
   l'historique survit à un rechargement et aux relais, et la page lit aussi
   ceux publiés par les autres pilotes de l'équipe.
   Programme du pilote trop ancien (pas de raceTrace) : passages déduits des
   changements de tour du classement, à l'heure de la page (approximatif).
══════════════════════════════════════════════════════════════════ */

window._raceTrace = {
    track: null,
    cars: new Map(),        // id -> {id, driver, vclass, laps: Map(tour -> ET)}
    approx: false,          // données déduites du classement (programme du pilote trop ancien)
    seen: new Map(),        // repli : id -> dernier tour vu dans le classement
    sel: { preset: 'near', ids: [] },   // preset : near | top:<classe> | class:<classe> | player | none | custom
    view: { lastN: null, lapFrom: null, lapTo: null, gapMin: null, gapMax: null },
    colors: new Map(),
    hoverLap: null,
    loadedKey: null,
    saveTimer: null,
    fetchedFor: null,
};

const _RT_PALETTE = ['#00d4ff', '#ff6b6b', '#7cff6b', '#c38bff', '#ff9f40', '#ff5fd2',
                     '#4dffd2', '#9aa8ff', '#e8e85a', '#ff8f8f', '#5ad1a0', '#c0c0c0'];
const _RT_PLAYER_COLOR = '#ffd700';

/* ── Mémoire (navigateur, par session d'équipe) ── */
function _rtKey(kind) {
    return `lmuRaceTrace.${kind}.${window._teamId || ''}.${(typeof _sessionId !== 'undefined' && _sessionId) || '_'}`;
}

function _rtLoad() {
    const RT = window._raceTrace;
    const key = _rtKey('data');
    if (RT.loadedKey === key) return;
    RT.loadedKey = key;
    RT.cars = new Map(); RT.seen = new Map(); RT.track = null; RT.approx = false;
    try {
        const d = JSON.parse(localStorage.getItem(key) || 'null');
        if (d && Array.isArray(d.cars)) {
            RT.track = d.track || null;
            RT.approx = !!d.approx;
            _rtMergeRows(d.cars, true);
        }
        const s = JSON.parse(localStorage.getItem(_rtKey('view')) || 'null');
        if (s && s.sel) RT.sel = s.sel;
        if (s && s.view) RT.view = Object.assign(RT.view, s.view);
    } catch (e) { /* mémoire illisible : on repart de zéro */ }
}

function _rtExportRows() {
    const rows = [];
    window._raceTrace.cars.forEach(c => {
        if (!c.laps.size) return;
        const nums = [...c.laps.keys()];
        const first = Math.min(...nums), last = Math.max(...nums);
        const ets = [];
        for (let n = first; n <= last; n++) ets.push(c.laps.has(n) ? c.laps.get(n) : null);
        rows.push([c.id, c.driver || null, c.vclass || null, first, ets]);
    });
    return rows;
}

function _rtSaveSoon() {
    const RT = window._raceTrace;
    if (RT.saveTimer) return;
    RT.saveTimer = setTimeout(() => {
        RT.saveTimer = null;
        try {
            localStorage.setItem(_rtKey('data'), JSON.stringify({ track: RT.track, approx: RT.approx, cars: _rtExportRows(), ts: Date.now() }));
        } catch (e) { /* stockage plein ou indisponible : l'historique reste en mémoire vive */ }
    }, 5000);
}

function _rtSaveView() {
    const RT = window._raceTrace;
    try { localStorage.setItem(_rtKey('view'), JSON.stringify({ sel: RT.sel, view: RT.view })); } catch (e) { /* sans importance */ }
}

/* ── Fusion des passages ──
   rows : [[id, pilote, catégorie, 1er tour, [ET...]], ...]. Si les heures connues ne
   correspondent pas (autre course sur le même circuit), on repart de zéro. */
function _rtMergeRows(rows, trusted) {
    const RT = window._raceTrace;
    if (!Array.isArray(rows)) return false;
    if (!trusted) {
        let match = 0, conflict = 0;
        rows.forEach(r => {
            const c = Array.isArray(r) && RT.cars.get(r[0]);
            if (!c || !Array.isArray(r[4])) return;
            r[4].forEach((et, i) => {
                const old = c.laps.get(r[3] + i);
                if (et == null || old == null) return;
                if (Math.abs(old - et) <= 3) match++; else conflict++;
            });
        });
        if (conflict > match) { RT.cars = new Map(); RT.seen = new Map(); }
    }
    let added = false;
    rows.forEach(r => {
        if (!Array.isArray(r) || r[0] == null || !Array.isArray(r[4])) return;
        const [id, driver, vclass, first, ets] = r;
        let c = RT.cars.get(id);
        if (!c) { c = { id, driver: null, vclass: null, laps: new Map() }; RT.cars.set(id, c); }
        if (driver) c.driver = driver;
        if (vclass) c.vclass = vclass;
        ets.forEach((et, i) => {
            if (et == null || !isFinite(et)) return;
            const n = first + i;
            if (c.laps.get(n) !== et) { c.laps.set(n, et); added = true; }
        });
    });
    return added;
}

/** Passages publiés par un autre programme (autre pilote de l'équipe). */
function raceTraceMergeExternal(obj) {
    if (!obj || !Array.isArray(obj.cars)) return;
    _rtLoad();
    const RT = window._raceTrace;
    if (RT.approx) { RT.cars = new Map(); RT.approx = false; }
    if (_rtMergeRows(obj.cars, false)) { _rtSaveSoon(); raceTraceRender(); }
}

/** Lit une fois les passages publiés par chaque pilote de l'équipe (stream/{pilote}/trace). */
function raceTraceFetchTeam(force) {
    const RT = window._raceTrace;
    const sid = window._teamTelemetrySessionId;
    if (!sid || !window._firebaseDb || !window._firebaseRef || !window._firebaseGet || typeof teamPath !== 'function') return;
    if (!force && RT.fetchedFor === sid) return;
    RT.fetchedFor = sid;
    const ids = Object.keys((typeof _teamTelemetryData !== 'undefined' && _teamTelemetryData) || {});
    ids.forEach(id => {
        window._firebaseGet(window._firebaseRef(window._firebaseDb, teamPath(`sessions/${sid}/stream/${id}/trace`)))
            .then(snap => {
                const v = snap && snap.val();
                if (!v || typeof v.j !== 'string') return;
                try { raceTraceMergeExternal(JSON.parse(v.j)); } catch (e) { /* nœud illisible : ignoré */ }
            })
            .catch(() => { /* pas de droit ou hors ligne : ignoré */ });
    });
}

/* ── Données live (appelé à chaque mise à jour du classement, ~1/s) ── */
function raceTraceIngest(data) {
    if (!data) return;
    _rtLoad();
    const RT = window._raceTrace;
    const track = data.trackName || null;
    if (track && RT.track && track !== RT.track) { RT.cars = new Map(); RT.seen = new Map(); RT.approx = false; }
    if (track) RT.track = track;
    raceTraceFetchTeam(false);

    const standings = Array.isArray(data.standings) ? data.standings : [];
    let changed = false;
    const rt = data.raceTrace;
    if (rt && Array.isArray(rt.cars) && rt.cars.length) {
        if (RT.approx) { RT.cars = new Map(); RT.approx = false; }
        changed = _rtMergeRows(rt.cars, false);
    } else if (/^Course/.test(data.sessionType || '') && (RT.approx || !RT.cars.size)) {
        // Repli (programme du pilote sans raceTrace) : passage = changement de tour vu dans le classement.
        RT.approx = true;
        const now = Date.now() / 1000;
        standings.forEach(s => {
            if (s.id == null || s.lap == null) return;
            const prev = RT.seen.get(s.id);
            RT.seen.set(s.id, s.lap);
            if (prev == null || s.lap <= prev) return;
            let c = RT.cars.get(s.id);
            if (!c) { c = { id: s.id, driver: null, vclass: null, laps: new Map() }; RT.cars.set(s.id, c); }
            c.laps.set(s.lap, now);
            changed = true;
        });
    }
    // Pilote et catégorie à jour (relais des autres équipages)
    standings.forEach(s => {
        const c = RT.cars.get(s.id);
        if (!c) return;
        if (s.driver) c.driver = s.driver;
        if (s.vclass) c.vclass = s.vclass;
    });
    if (changed) _rtSaveSoon();
    raceTraceRender();
}

/* ── Calcul des écarts ── */
function _rtStandings() { return Array.isArray(window._liveStandingsFull) ? window._liveStandingsFull : []; }

function _rtClassOf(c) {
    const s = _rtStandings().find(d => d.id === c.id);
    return (s && s.vclass) || c.vclass || '—';
}

function _rtPlayerId() {
    const me = _rtStandings().find(d => d.isPlayer);
    return me ? me.id : null;
}

/** id -> [[tour, écart s], ...] pour toutes les voitures (écart au 1er de sa catégorie). */
function _rtComputeGaps() {
    const RT = window._raceTrace;
    const refByClass = new Map();
    RT.cars.forEach(c => {
        const cls = _rtClassOf(c);
        let ref = refByClass.get(cls);
        if (!ref) { ref = new Map(); refByClass.set(cls, ref); }
        c.laps.forEach((et, n) => {
            if (n < 1) return;
            const r = ref.get(n);
            if (r == null || et < r) ref.set(n, et);
        });
    });
    const out = new Map();
    RT.cars.forEach(c => {
        const ref = refByClass.get(_rtClassOf(c));
        const pts = [];
        [...c.laps.keys()].sort((a, b) => a - b).forEach(n => {
            if (n < 1) return;
            pts.push([n, c.laps.get(n) - ref.get(n)]);
        });
        out.set(c.id, pts);
    });
    return out;
}

/* ── Sélection des pilotes ── */
function _rtClassesInOrder() {
    const seen = [];
    _rtStandings().forEach(s => { const k = s.vclass || '—'; if (!seen.includes(k)) seen.push(k); });
    window._raceTrace.cars.forEach(c => { const k = _rtClassOf(c); if (!seen.includes(k)) seen.push(k); });
    return seen;
}

/** Voitures de la catégorie, dans l'ordre du classement (puis celles sorties du classement). */
function _rtClassCars(cls) {
    const ids = _rtStandings().filter(s => (s.vclass || '—') === cls).sort((a, b) => (a.place || 999) - (b.place || 999)).map(s => s.id);
    window._raceTrace.cars.forEach(c => { if (_rtClassOf(c) === cls && !ids.includes(c.id)) ids.push(c.id); });
    return ids;
}

function _rtSelectedIds() {
    const RT = window._raceTrace;
    const p = RT.sel.preset || 'near';
    const me = _rtPlayerId();
    const myCls = me != null ? ((_rtStandings().find(d => d.id === me) || {}).vclass || '—') : null;
    if (p === 'custom') return (RT.sel.ids || []).slice();
    if (p === 'none') return [];
    if (p === 'player') return me != null ? [me] : [];
    if (p.startsWith('top:')) return _rtClassCars(p.slice(4)).slice(0, 5);
    if (p.startsWith('class:')) return _rtClassCars(p.slice(6));
    // near : notre voiture, 3 devant et 3 derrière dans sa catégorie
    if (me == null) return _rtClassCars(_rtClassesInOrder()[0] || '—').slice(0, 5);
    const list = _rtClassCars(myCls);
    const i = list.indexOf(me);
    return list.slice(Math.max(0, i - 3), i + 4);
}

function raceTraceSetPreset(preset) {
    const RT = window._raceTrace;
    RT.sel = { preset, ids: [] };
    _rtSaveView();
    raceTraceRender(true);
}

function raceTraceToggleCar(id) {
    const RT = window._raceTrace;
    const ids = _rtSelectedIds();
    const i = ids.indexOf(id);
    if (i >= 0) ids.splice(i, 1); else ids.push(id);
    RT.sel = { preset: 'custom', ids };
    _rtSaveView();
    raceTraceRender(true);
}

function _rtColorOf(id, isPlayer) {
    if (isPlayer) return _RT_PLAYER_COLOR;
    const RT = window._raceTrace;
    if (!RT.colors.has(id)) {
        const used = new Set(RT.colors.values());
        const free = _RT_PALETTE.find(c => !used.has(c)) || _RT_PALETTE[RT.colors.size % _RT_PALETTE.length];
        RT.colors.set(id, free);
    }
    return RT.colors.get(id);
}

/* ── Axes ── */
function raceTraceSetLastN(n) {
    const v = window._raceTrace.view;
    v.lastN = n; v.lapFrom = null; v.lapTo = null;
    _rtSaveView();
    raceTraceRender(true);
}

function raceTraceSetGapMax(sec) {
    const v = window._raceTrace.view;
    v.gapMin = sec == null ? null : 0;
    v.gapMax = sec;
    _rtSaveView();
    raceTraceRender(true);
}

function _rtReadInputs() {
    const v = window._raceTrace.view;
    const num = id => { const el = document.getElementById(id); const x = el ? parseFloat(el.value) : NaN; return isFinite(x) ? x : null; };
    v.lapFrom = num('rtLapFrom'); v.lapTo = num('rtLapTo');
    v.gapMin = num('rtGapMin'); v.gapMax = num('rtGapMax');
    if (v.lapFrom != null || v.lapTo != null) v.lastN = null;
    _rtSaveView();
    raceTraceRender(true);
}

function _rtNiceStep(span, target) {
    const raw = span / Math.max(1, target);
    const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const m = raw / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

function _rtFmtGap(g) {
    if (g == null || !isFinite(g)) return '—';
    if (g >= 60) { const m = Math.floor(g / 60); return `+${m}:${(g - m * 60).toFixed(1).padStart(4, '0')}`; }
    return `+${g.toFixed(1)} s`;
}

function _rtShortName(c) {
    const n = ((c && c.driver) || '').trim();
    return n ? n.split(/\s+/).slice(-1)[0] : ('#' + (c ? c.id : '?'));
}

/* ── Rendu ── */
function raceTraceRender(force) {
    const canvas = document.getElementById('raceTraceCanvas');
    if (!canvas) return;
    if (!force && typeof _liveIsOnScreen === 'function' && !_liveIsOnScreen(canvas)) return;
    _rtLoad();
    const RT = window._raceTrace;
    const me = _rtPlayerId();
    const ids = _rtSelectedIds();
    const gaps = _rtComputeGaps();

    _rtRenderControls(ids);

    // Canvas net sur écran haute densité, largeur du conteneur
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.max(300, canvas.clientWidth || 900);
    const cssH = Math.max(220, canvas.clientHeight || 420);
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const series = ids.map(id => ({ id, car: RT.cars.get(id), pts: gaps.get(id) || [] })).filter(s => s.pts.length);
    const note = document.getElementById('raceTraceNote');
    if (note) {
        note.textContent = RT.approx
            ? '⚠️ Programme du pilote à mettre à jour : écarts approximatifs (à quelques secondes près), à partir de l\'ouverture de la page.'
            : '';
    }
    if (!series.length) {
        ctx.fillStyle = '#888';
        ctx.font = '13px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(RT.cars.size
            ? 'Aucun tour à afficher pour les pilotes choisis.'
            : 'Le graphique se remplit pendant la course, à chaque passage des voitures sur la ligne.', cssW / 2, cssH / 2);
        _rtHideTip();
        return;
    }

    // Plage des tours
    let maxLap = 1, minLap = Infinity;
    series.forEach(s => { minLap = Math.min(minLap, s.pts[0][0]); maxLap = Math.max(maxLap, s.pts[s.pts.length - 1][0]); });
    const v = RT.view;
    let x0, x1;
    if (v.lastN) { x1 = maxLap; x0 = Math.max(minLap, maxLap - v.lastN + 1); }
    else { x0 = v.lapFrom != null ? v.lapFrom : minLap; x1 = v.lapTo != null ? v.lapTo : maxLap; }
    if (x1 <= x0) x1 = x0 + 1;

    // Plage des écarts (auto : max des tours visibles)
    let gMax = 0;
    series.forEach(s => s.pts.forEach(([n, g]) => { if (n >= x0 && n <= x1 && g > gMax) gMax = g; }));
    let y0 = v.gapMin != null ? v.gapMin : 0;
    let y1 = v.gapMax != null ? v.gapMax : Math.max(5, gMax * 1.05);
    if (y1 <= y0) y1 = y0 + 1;

    const pad = { l: 64, r: 96, t: 12, b: 30 };
    const pw = cssW - pad.l - pad.r, ph = cssH - pad.t - pad.b;
    const X = n => pad.l + (n - x0) / (x1 - x0) * pw;
    const Y = g => pad.t + (g - y0) / (y1 - y0) * ph;      // 0 en haut : le 1er de catégorie est en haut
    RT._geom = { x0, x1, pad, pw, ph, X, cssW };

    // Grille + axes
    ctx.font = '11px sans-serif';
    ctx.lineWidth = 1;
    const yStep = _rtNiceStep(y1 - y0, 6);
    for (let g = Math.ceil(y0 / yStep) * yStep; g <= y1 + 1e-9; g += yStep) {
        const y = Y(g);
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + pw, y); ctx.stroke();
        ctx.fillStyle = '#9aa';
        ctx.textAlign = 'right';
        ctx.fillText(g === 0 ? '1er' : _rtFmtGap(g), pad.l - 6, y + 4);
    }
    const xStep = Math.max(1, Math.round(_rtNiceStep(x1 - x0, 10)));
    for (let n = Math.ceil(x0 / xStep) * xStep; n <= x1; n += xStep) {
        const x = X(n);
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ph); ctx.stroke();
        ctx.fillStyle = '#9aa';
        ctx.textAlign = 'center';
        ctx.fillText('T' + n, x, pad.t + ph + 16);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.strokeRect(pad.l, pad.t, pw, ph);

    // Courbes (notre voiture en dernier, au-dessus)
    series.sort((a, b) => (a.id === me ? 1 : 0) - (b.id === me ? 1 : 0));
    const ends = [];
    ctx.save();
    ctx.beginPath(); ctx.rect(pad.l, pad.t, pw, ph); ctx.clip();
    const fewLaps = (x1 - x0) <= 40;
    series.forEach(s => {
        const isMe = s.id === me;
        const color = _rtColorOf(s.id, isMe);
        ctx.strokeStyle = color;
        ctx.lineWidth = isMe ? 3 : 1.8;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        let prevN = null, last = null;
        s.pts.forEach(([n, g]) => {
            if (n < x0 - 1 || n > x1 + 1) { prevN = null; return; }
            const x = X(n), y = Y(g);
            if (prevN === n - 1) ctx.lineTo(x, y); else ctx.moveTo(x, y);
            prevN = n;
            if (n <= x1) last = [x, y, g];
        });
        ctx.stroke();
        if (fewLaps) {
            ctx.fillStyle = color;
            s.pts.forEach(([n, g]) => {
                if (n < x0 || n > x1) return;
                ctx.beginPath(); ctx.arc(X(n), Y(g), isMe ? 3 : 2, 0, Math.PI * 2); ctx.fill();
            });
        }
        if (last) ends.push({ y: last[1], g: last[2], color, label: (isMe ? '★ ' : '') + _rtShortName(s.car), isMe });
    });
    // Repère du tour survolé
    if (RT.hoverLap != null && RT.hoverLap >= x0 && RT.hoverLap <= x1) {
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(X(RT.hoverLap), pad.t); ctx.lineTo(X(RT.hoverLap), pad.t + ph); ctx.stroke();
        ctx.setLineDash([]);
    }
    ctx.restore();

    // Noms en bout de courbe, sans chevauchement
    ends.sort((a, b) => a.y - b.y);
    let minY = pad.t + 6;
    ends.forEach(e => {
        e.ly = Math.min(Math.max(e.y, minY), pad.t + ph + 4);
        minY = e.ly + 13;
    });
    ctx.textAlign = 'left';
    ends.forEach(e => {
        ctx.font = e.isMe ? 'bold 11px sans-serif' : '11px sans-serif';
        ctx.fillStyle = e.color;
        ctx.fillText(e.label, pad.l + pw + 6, e.ly + 4);
    });

    _rtUpdateTip(series, gaps, me);
}

/* ── Infobulle du tour survolé ── */
function _rtHideTip() {
    const tip = document.getElementById('raceTraceTip');
    if (tip) tip.style.display = 'none';
}

function _rtUpdateTip(series, gaps, me) {
    const RT = window._raceTrace;
    const tip = document.getElementById('raceTraceTip');
    const G = RT._geom;
    if (!tip || !G || RT.hoverLap == null || RT.hoverLap < G.x0 || RT.hoverLap > G.x1) { _rtHideTip(); return; }
    const n = RT.hoverLap;
    const rows = series.map(s => {
        const p = s.pts.find(q => q[0] === n);
        return p ? { s, g: p[1] } : null;
    }).filter(Boolean).sort((a, b) => a.g - b.g);
    if (!rows.length) { _rtHideTip(); return; }
    const esc = typeof _teamTelemetryEscapeHtml === 'function' ? _teamTelemetryEscapeHtml : (x => String(x));
    tip.innerHTML = `<div class="rt-tip-title">Tour ${n}</div>` + rows.map(r => {
        const isMe = r.s.id === me;
        return `<div class="rt-tip-row${isMe ? ' me' : ''}"><span class="rt-dot" style="background:${_rtColorOf(r.s.id, isMe)}"></span>`
             + `<span class="rt-tip-name">${esc((r.s.car && r.s.car.driver) || '#' + r.s.id)}</span>`
             + `<span class="rt-tip-cls">${esc(r.s.car ? _rtClassOf(r.s.car) : '')}</span>`
             + `<span>${r.g < 0.05 ? '1er' : _rtFmtGap(r.g)}</span></div>`;
    }).join('');
    tip.style.display = 'block';
    const x = G.X(n);
    const wrapW = tip.parentElement.clientWidth;
    const tw = tip.offsetWidth;
    tip.style.left = (x + 14 + tw > wrapW ? Math.max(0, x - 14 - tw) : x + 14) + 'px';
}

/* ── Barre de filtres (pilotes) ── */
function _rtRenderControls(selIds) {
    const RT = window._raceTrace;
    const bar = document.getElementById('raceTracePresets');
    const picker = document.getElementById('raceTracePicker');
    const count = document.getElementById('raceTracePickCount');
    if (!bar || !picker) return;
    const esc = typeof _teamTelemetryEscapeHtml === 'function' ? _teamTelemetryEscapeHtml : (x => String(x));
    const p = RT.sel.preset || 'near';
    const classes = _rtClassesInOrder();
    const btn = (preset, label, title) =>
        `<button type="button" class="rt-btn${p === preset ? ' active' : ''}" data-rt-preset="${esc(preset)}" title="${esc(title)}">${esc(label)}</button>`;
    let html = btn('near', '⭐ Autour de nous', 'Notre voiture, 3 devant et 3 derrière dans notre catégorie')
             + btn('player', '⭐ Seul', 'Seulement notre voiture');
    classes.forEach(cls => {
        const col = (typeof _liveClassColor === 'function' && _liveClassColor(cls)) || '#aaa';
        html += `<span class="rt-cls" style="--cls:${col}">`
              + btn('top:' + cls, `Top 5 ${cls}`, `Les 5 premiers de la catégorie ${cls}`)
              + btn('class:' + cls, `Tous`, `Toute la catégorie ${cls}`)
              + '</span>';
    });
    html += btn('none', 'Aucun', 'Retirer tous les pilotes');
    if (bar.dataset.html !== html) { bar.innerHTML = html; bar.dataset.html = html; }

    // Choix pilote par pilote, groupé par catégorie
    const me = _rtPlayerId();
    const sel = new Set(selIds);
    let ph = '';
    classes.forEach(cls => {
        const col = (typeof _liveClassColor === 'function' && _liveClassColor(cls)) || '#aaa';
        ph += `<div class="rt-pick-group"><span class="rt-pick-cls" style="color:${col}">${esc(cls)}</span>`;
        _rtClassCars(cls).forEach(id => {
            const s = _rtStandings().find(d => d.id === id);
            const c = RT.cars.get(id);
            const name = (s && s.driver) || (c && c.driver) || ('#' + id);
            const on = sel.has(id);
            const isMe = id === me;
            const style = on ? ` style="border-color:${_rtColorOf(id, isMe)};color:${_rtColorOf(id, isMe)}"` : '';
            ph += `<button type="button" class="rt-chip${on ? ' on' : ''}" data-rt-car="${esc(id)}"${style}>`
                + `${s && s.place ? 'P' + s.place + ' ' : ''}${isMe ? '⭐ ' : ''}${esc(name)}</button>`;
        });
        ph += '</div>';
    });
    if (picker.dataset.html !== ph) { picker.innerHTML = ph; picker.dataset.html = ph; }
    if (count) count.textContent = `${sel.size} pilote${sel.size > 1 ? 's' : ''} affiché${sel.size > 1 ? 's' : ''}`;

    // Champs des axes : reflètent la vue sauf pendant la saisie
    const v = RT.view;
    [['rtLapFrom', v.lapFrom], ['rtLapTo', v.lapTo], ['rtGapMin', v.gapMin], ['rtGapMax', v.gapMax]].forEach(([id, val]) => {
        const el = document.getElementById(id);
        if (el && document.activeElement !== el) el.value = val == null ? '' : val;
    });
    document.querySelectorAll('[data-rt-lastn]').forEach(b => {
        const n = b.dataset.rtLastn === 'all' ? null : parseInt(b.dataset.rtLastn, 10);
        b.classList.toggle('active', (v.lastN || null) === n && (n != null || (v.lapFrom == null && v.lapTo == null)));
    });
    document.querySelectorAll('[data-rt-gapmax]').forEach(b => {
        const g = b.dataset.rtGapmax === 'auto' ? null : parseFloat(b.dataset.rtGapmax);
        b.classList.toggle('active', g == null ? (v.gapMax == null && v.gapMin == null) : (v.gapMax === g && !v.gapMin));
    });
}

/* ── Événements ── */
(function () {
    const root = document.getElementById('raceTraceSection');
    if (!root) return;
    root.addEventListener('click', e => {
        const pre = e.target.closest('[data-rt-preset]');
        if (pre) { raceTraceSetPreset(pre.dataset.rtPreset); return; }
        const chip = e.target.closest('[data-rt-car]');
        if (chip) {
            const raw = chip.dataset.rtCar;
            raceTraceToggleCar(isNaN(Number(raw)) ? raw : Number(raw));
            return;
        }
        const ln = e.target.closest('[data-rt-lastn]');
        if (ln) { raceTraceSetLastN(ln.dataset.rtLastn === 'all' ? null : parseInt(ln.dataset.rtLastn, 10)); return; }
        const gm = e.target.closest('[data-rt-gapmax]');
        if (gm) { raceTraceSetGapMax(gm.dataset.rtGapmax === 'auto' ? null : parseFloat(gm.dataset.rtGapmax)); }
    });
    root.addEventListener('change', e => { if (e.target.matches('.rt-axis input')) _rtReadInputs(); });
    root.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('.rt-axis input')) _rtReadInputs(); });

    const canvas = document.getElementById('raceTraceCanvas');
    canvas.addEventListener('mousemove', e => {
        const G = window._raceTrace._geom;
        if (!G) return;
        const r = canvas.getBoundingClientRect();
        const x = e.clientX - r.left;
        const n = Math.round(G.x0 + (x - G.pad.l) / G.pw * (G.x1 - G.x0));
        const lap = (x < G.pad.l || x > G.pad.l + G.pw) ? null : Math.min(G.x1, Math.max(G.x0, n));
        if (lap !== window._raceTrace.hoverLap) { window._raceTrace.hoverLap = lap; raceTraceRender(true); }
    });
    canvas.addEventListener('mouseleave', () => { window._raceTrace.hoverLap = null; raceTraceRender(true); });
    if (typeof ResizeObserver === 'function') {
        let lastW = 0;
        new ResizeObserver(() => {
            if (canvas.clientWidth && canvas.clientWidth !== lastW) { lastW = canvas.clientWidth; raceTraceRender(true); }
        }).observe(canvas);
    }
    const det = root.closest('details');
    if (det) det.addEventListener('toggle', () => { if (det.open) raceTraceRender(true); });
})();
