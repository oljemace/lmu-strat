/* ══════════════════════════════════════════════
   ONGLET RYTHME — comparaison du rythme et de l'usure entre pilotes
   Sources acceptées (glisser-déposer ou sélection de fichiers) :
   • XML de résultats LMU (UserData\Log\Results\*.xml) : temps au tour, secteurs,
     gommes, passages aux stands, relais (<Swap>). L'usure et le carburant n'y figurent
     que pour les sessions HORS LIGNE : les XML « Multiplayer » ne les contiennent pas.
   • JSON du connecteur (dossier « telemetrie ») : usure par tour et par pneu, temps au tour.
     Le pilote n'y est pas enregistré : on le demande à l'import.
   • Envois automatiques du connecteur (collector/lmu_pace_upload.py, à sa fermeture) : lus en direct sous
     teams/{équipe}/paceIndex (liste légère) puis paceData (tours, chargés seulement pour le circuit affiché).
   Les fichiers importés à la main restent dans ce navigateur (localStorage) : ils ne sont pas partagés.
   ══════════════════════════════════════════════ */

const PACE_STORE_KEY = 'lmuPace.v1';
const PACE_COMPOUND_COLORS = {
    soft: '#e8322b', medium: '#ffd12e', hard: '#f2f2f2', wet: '#2f80ed', inter: '#3cb44b',
};
const PACE_DRIVER_COLORS = ['#3fb6ff', '#ff7a45', '#7bd88f', '#c77dff', '#ffd43b', '#ff5c8a', '#4dd4c6', '#a0a0ff', '#e6a15c', '#9be15d'];
const PACE_CORNERS = ['FL', 'FR', 'RL', 'RR'];
const PACE_CORNER_COLORS = { FL: '#4dabf7', FR: '#ff922b', RL: '#38d9a9', RR: '#f06595' };
const PACE_NO_TRACK = 'Circuit non précisé';

let _pace = {
    files: [],           // [{ id, name, kind, track, session, enabled, laps: [...] }]
    selected: [],        // noms de pilotes cochés
    cls: '',             // filtre de catégorie ('' = toutes)
    track: '',           // circuit affiché (on ne mélange jamais deux circuits)
    threshold: 4,        // % au-dessus du meilleur tour du pilote pour compter un tour « rythme »
    jsonDriver: '',      // nom donné aux fichiers JSON du connecteur
    search: '',
    selectionTouched: false,
    teamDisabled: {},    // envois de l'équipe décochés (id -> true)
    trackOverride: {},   // circuit corrigé à la main pour un envoi de l'équipe (id -> circuit)
};

/* ── Envois de l'équipe (Firebase) ── */
const _paceTeam = { teamId: null, unsub: null, index: {}, laps: new Map(), loading: new Set(), error: '' };

function paceTeamSync() {
    const teamId = window._teamId;
    if (!window._firebaseReady || !teamId || typeof teamPath !== 'function') return;
    if (_paceTeam.teamId === teamId) return;
    if (_paceTeam.unsub) { try { _paceTeam.unsub(); } catch (e) { /* déjà détaché */ } }
    Object.assign(_paceTeam, { teamId, index: {}, laps: new Map(), loading: new Set(), error: '' });
    const ref = window._firebaseRef(window._firebaseDb, teamPath('paceIndex'));
    _paceTeam.unsub = window._firebaseOnValue(ref, snap => {
        _paceTeam.index = snap.val() || {};
        _paceTeam.error = '';
        renderPaceTab();
    }, err => {
        _paceTeam.error = 'Lecture des envois de l\'équipe impossible : ' + (err?.message || err);
        renderPaceTab();
    });
}

/** Les envois de l'équipe vus comme des fichiers (tours vides tant qu'ils ne sont pas chargés). */
function paceTeamFiles() {
    const out = [];
    for (const [uid, runs] of Object.entries(_paceTeam.index || {})) {
        for (const [runId, m] of Object.entries(runs || {})) {
            if (!m || typeof m !== 'object') continue;
            const id = `team|${uid}|${runId}`;
            out.push({
                id, uid, runId,
                name: m.recordedAt || runId,
                kind: 'team',
                track: _pace.trackOverride[id] || m.track || PACE_NO_TRACK,
                session: `${m.driver || '?'}${m.car ? ' · ' + m.car : ''}`,
                car: m.car || '',
                recordedAt: m.recordedAt || '',
                ts: m.ts || 0,
                lapTotal: m.laps || 0,
                driver: m.driver || '',
                enabled: !_pace.teamDisabled[id],
                laps: _paceTeam.laps.get(id) || [],
            });
        }
    }
    return out.sort((a, b) => b.ts - a.ts);
}

function paceAllFiles() { return _pace.files.concat(paceTeamFiles()); }

/** Charge les tours des envois visibles (circuit affiché, cochés) qui ne le sont pas encore. */
function paceTeamLoadVisible(teamFiles) {
    for (const f of teamFiles) {
        if (!f.enabled || f.track !== _pace.track || _paceTeam.laps.has(f.id) || _paceTeam.loading.has(f.id)) continue;
        _paceTeam.loading.add(f.id);
        const ref = window._firebaseRef(window._firebaseDb, teamPath(`paceData/${f.uid}/${f.runId}`));
        window._firebaseGet(ref).then(snap => {
            _paceTeam.laps.set(f.id, paceParseTeamLaps(snap.val(), f));
        }).catch(err => {
            console.warn('[rythme] envoi illisible', f.id, err);
            _paceTeam.laps.set(f.id, []);
        }).finally(() => {
            _paceTeam.loading.delete(f.id);
            renderPaceTab();
        });
    }
}

/** paceData/{uid}/{run} = {ts, j} ; j = [{n, t, p, w:[FL,FR,RL,RR], c, f, v}] (voir lmu_pace_upload._compact_lap). */
function paceParseTeamLaps(node, f) {
    let arr = [];
    try { arr = JSON.parse(node?.j || '[]'); } catch (e) { return []; }
    return (Array.isArray(arr) ? arr : []).map(l => {
        const w = Array.isArray(l.w) && l.w.length === 4 && l.w.every(v => Number.isFinite(v) && v >= 0) && !l.p
            ? { FL: l.w[0], FR: l.w[1], RL: l.w[2], RR: l.w[3] } : null;
        return {
            driver: f.driver, team: f.car, carNum: '', car: f.car, cls: '',
            num: l.n, et: null,
            time: Number.isFinite(l.t) && l.t > 0 ? l.t : null,
            s1: null, s2: null, s3: null,
            pit: !!l.p,
            compound: paceCompoundKey(l.c),
            wear: w,
        };
    });
}

function paceDeleteTeamRun(id) {
    const f = paceTeamFiles().find(x => x.id === id);
    if (!f || !confirm(`Supprimer pour toute l'équipe l'envoi « ${f.session} » (${f.track}) ?`)) return;
    const del = sub => window._firebaseRemove(window._firebaseRef(window._firebaseDb, teamPath(`${sub}/${f.uid}/${f.runId}`)));
    del('paceIndex').then(() => del('paceData')).catch(err => alert('Suppression refusée : ' + (err?.message || err)));
}

/* ── Persistance locale ── */
function paceSave() {
    try { localStorage.setItem(PACE_STORE_KEY, JSON.stringify(_pace)); }
    catch (e) { console.warn('[rythme] sauvegarde locale impossible', e); }
}
function paceLoad() {
    try {
        const raw = localStorage.getItem(PACE_STORE_KEY);
        if (raw) Object.assign(_pace, JSON.parse(raw));
    } catch (e) { /* stockage indisponible : on repart de zéro */ }
}

/* ── Petits utilitaires ── */
function paceEsc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function paceNum(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
}
function paceFmtLap(s) {
    if (s == null || !Number.isFinite(s)) return '—';
    const m = Math.floor(s / 60);
    const rest = s - m * 60;
    return m > 0 ? `${m}:${rest.toFixed(3).padStart(6, '0')}` : rest.toFixed(3);
}
function paceCompoundKey(c) {
    const k = String(c || '').toLowerCase();
    if (k.includes('soft')) return 'soft';
    if (k.includes('med')) return 'medium';
    if (k.includes('hard')) return 'hard';
    if (k.includes('inter')) return 'inter';
    if (k.includes('wet') || k.includes('rain')) return 'wet';
    return '';
}
function paceCompoundLabel(k) {
    return { soft: 'Soft', medium: 'Medium', hard: 'Hard', wet: 'Pluie', inter: 'Inter' }[k] || 'Inconnue';
}
function paceMean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function paceSd(a) {
    if (a.length < 2) return 0;
    const m = paceMean(a);
    return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
function paceQuantile(sorted, q) {
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function paceShortName(name) {
    const parts = String(name).trim().split(/\s+/);
    if (parts.length < 2) return name;
    return `${parts[0][0]}. ${parts.slice(1).join(' ')}`;
}

/* ══════════ LECTURE DES FICHIERS ══════════ */

/** XML de résultats LMU / rFactor 2 → une entrée par session contenant des pilotes. */
function paceParseXml(text, fileName) {
    // Le DOCTYPE déclare une entité interne : on l'enlève, inutile ici.
    const doc = new DOMParser().parseFromString(text.replace(/<!DOCTYPE[\s\S]*?\]>/, ''), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('XML illisible');
    const rr = doc.getElementsByTagName('RaceResults')[0];
    if (!rr) throw new Error('pas un fichier de résultats LMU');
    const txt = (el, tag) => el.getElementsByTagName(tag)[0]?.textContent?.trim() || '';
    const track = txt(rr, 'TrackVenue') || txt(rr, 'TrackCourse') || 'Circuit inconnu';
    const setting = txt(rr, 'Setting');
    const out = [];

    for (const sess of Array.from(rr.children)) {
        const drivers = Array.from(sess.children).filter(c => c.tagName === 'Driver');
        if (!drivers.length) continue;
        const laps = [];
        for (const d of drivers) {
            const kids = Array.from(d.children);
            const get = tag => kids.find(c => c.tagName === tag)?.textContent?.trim() || '';
            const name = get('Name');
            const team = get('TeamName');
            const carNum = get('CarNumber');
            const car = get('CarType') || get('VehName');
            const cls = get('CarClass');
            const swaps = kids.filter(c => c.tagName === 'Swap').map(s => ({
                start: parseInt(s.getAttribute('startLap'), 10),
                end: parseInt(s.getAttribute('endLap'), 10),
                name: s.textContent.trim(),
            }));
            let prevWear = null;
            for (const l of kids.filter(c => c.tagName === 'Lap')) {
                const a = n => l.getAttribute(n);
                const num = parseInt(a('num'), 10);
                const swap = swaps.find(s => num >= s.start && num <= s.end);
                // Usure : l'XML donne la fraction RESTANTE de chaque pneu (1 = neuf).
                let wear = null;
                const cur = a('twfl') != null ? {
                    FL: paceNum(a('twfl')), FR: paceNum(a('twfr')), RL: paceNum(a('twrl')), RR: paceNum(a('twrr')),
                } : null;
                if (cur && prevWear) {
                    const delta = {};
                    let changed = false;
                    for (const k of PACE_CORNERS) {
                        delta[k] = (prevWear[k] - cur[k]) * 100;
                        if (delta[k] < -0.05) changed = true;   // pneu neuf monté : pas un tour d'usure
                    }
                    if (!changed) wear = delta;
                }
                if (cur) prevWear = cur;
                laps.push({
                    driver: swap?.name || name,
                    team, carNum, car, cls,
                    num,
                    et: paceNum(a('et')),
                    time: paceNum(l.textContent),
                    s1: paceNum(a('s1')), s2: paceNum(a('s2')), s3: paceNum(a('s3')),
                    pit: a('pit') === '1',
                    compound: paceCompoundKey((a('fcompound') || '').split(',')[1]),
                    wear,
                });
            }
        }
        out.push({
            id: `${fileName}|${sess.tagName}`,
            name: fileName,
            kind: 'xml',
            track,
            session: `${sess.tagName}${setting ? ' · ' + setting : ''}`,
            enabled: true,
            laps,
        });
    }
    if (!out.length) throw new Error('aucun pilote dans ce fichier');
    return out;
}

/** JSON du connecteur (collector/lmu_telemetry_logger.py) → une entrée. */
function paceParseJson(obj, fileName, driverName) {
    if (!obj || !Array.isArray(obj.laps)) throw new Error('pas un fichier de télémétrie du connecteur');
    const driver = (obj.driver || driverName || '').trim();
    if (!driver) throw new Error('indique le nom du pilote avant d\'importer un JSON');
    const laps = obj.laps.filter(l => l && l.num > 0).map(l => {
        const w = l.wear || null;
        const valid = w && !l.pit && PACE_CORNERS.every(k => Number.isFinite(w[k]) && w[k] >= 0);
        return {
            driver,
            team: '', carNum: '', car: l.car || obj.car || '', cls: '',
            num: l.num,
            et: null,
            time: Number.isFinite(l.lapTime) && l.lapTime > 0 ? l.lapTime : null,
            s1: null, s2: null, s3: null,
            pit: !!l.pit,
            compound: paceCompoundKey(l.leftCompound),
            wear: valid ? { FL: w.FL, FR: w.FR, RL: w.RL, RR: w.RR } : null,
        };
    });
    return [{
        id: `${fileName}|json|${driver}`,
        name: fileName,
        kind: 'json',
        // Le connecteur n'enregistre pas le circuit : on prend celui affiché, modifiable dans la liste des fichiers.
        track: obj.track || _pace.track || PACE_NO_TRACK,
        session: `Connecteur · ${driver}`,
        enabled: true,
        laps,
    }];
}

async function paceImportFiles(fileList) {
    const status = document.getElementById('paceImportStatus');
    const msgs = [];
    for (const f of Array.from(fileList || [])) {
        try {
            const text = await f.text();
            let entries;
            if (/\.json$/i.test(f.name) || text.trim().startsWith('{')) {
                const nameInput = document.getElementById('paceJsonDriver');
                _pace.jsonDriver = (nameInput?.value || _pace.jsonDriver || '').trim();
                entries = paceParseJson(JSON.parse(text), f.name, _pace.jsonDriver);
            } else {
                entries = paceParseXml(text, f.name);
            }
            for (const e of entries) {
                _pace.files = _pace.files.filter(x => x.id !== e.id);   // réimport = remplacement
                _pace.files.push(e);
                if (e.kind === 'xml') _pace.track = e.track;           // on affiche le circuit du dernier XML importé
            }
            msgs.push(`✅ ${f.name}`);
        } catch (err) {
            msgs.push(`❌ ${f.name} : ${err.message}`);
        }
    }
    if (status) status.innerHTML = msgs.map(paceEsc).join('<br>');
    paceSave();
    renderPaceTab();
}

function paceRemoveFile(id) {
    _pace.files = _pace.files.filter(f => f.id !== id);
    paceSave();
    renderPaceTab();
}
function paceToggleFile(id, on) {
    if (id.startsWith('team|')) {
        if (on) delete _pace.teamDisabled[id]; else _pace.teamDisabled[id] = true;
        paceSave();
        renderPaceTab();
        return;
    }
    const f = _pace.files.find(x => x.id === id);
    if (f) f.enabled = on;
    paceSave();
    renderPaceTab();
}
function paceSetFileTrack(id, track) {
    if (id.startsWith('team|')) {
        _pace.trackOverride[id] = track;   // correction locale : l'envoi d'origine n'est pas modifié
        paceSave();
        renderPaceTab();
        return;
    }
    const f = _pace.files.find(x => x.id === id);
    if (f) f.track = track;
    paceSave();
    renderPaceTab();
}
function paceSetTrack(v) { _pace.track = v; paceSave(); renderPaceTab(); }
function paceTracks() {
    return Array.from(new Set(paceAllFiles().map(f => f.track))).sort((a, b) => a.localeCompare(b));
}
function paceClearAll() {
    if (!confirm('Retirer tous les fichiers importés de cet onglet ?')) return;
    _pace.files = [];
    _pace.selected = [];
    _pace.selectionTouched = false;
    paceSave();
    renderPaceTab();
}

/* ══════════ AGRÉGATION ══════════ */

/** Regroupe les tours par pilote (doublons retirés : deux coéquipiers peuvent importer le XML d'une même course). */
function paceBuildDrivers() {
    const drivers = new Map();
    const seen = new Set();
    for (const f of paceAllFiles()) {
        if (!f.enabled || f.track !== _pace.track) continue;
        for (const l of f.laps) {
            if (_pace.cls && l.cls && l.cls !== _pace.cls) continue;
            const key = l.et != null
                ? `${f.track}|${f.session}|${l.driver}|${l.num}|${Math.round(l.et)}`
                : `${f.id}|${l.driver}|${l.num}`;
            if (seen.has(key)) continue;
            seen.add(key);
            let d = drivers.get(l.driver);
            if (!d) {
                d = { name: l.driver, group: '', xml: [], json: [] };
                drivers.set(l.driver, d);
            }
            // Une même équipe peut aligner plusieurs voitures sous le même numéro (Hyper + GT3) : la catégorie fait partie du groupe.
            if (!d.group && (l.team || l.carNum)) d.group = `${l.carNum ? '#' + l.carNum + ' ' : ''}${l.team}${l.cls ? ' · ' + l.cls : ''}`.trim();
            (f.kind === 'xml' ? d.xml : d.json).push(l);
        }
    }
    for (const d of drivers.values()) {
        if (!d.group) d.group = 'Télémétrie connecteur';
        const all = d.xml.concat(d.json);
        // Temps : le XML fait foi (secteurs, gommes) ; les JSON ne servent que s'il n'y a pas de XML.
        const src = d.xml.some(l => l.time) ? d.xml : d.json;
        d.timed = src.filter(l => l.time && !l.pit);
        d.best = d.timed.length ? Math.min(...d.timed.map(l => l.time)) : null;
        d.wearLaps = all.filter(l => l.wear && !l.pit);
        d.lapCount = all.length;
    }
    return drivers;
}

/** Statistiques d'un pilote sur ses tours « rythme » (≤ meilleur tour + seuil). */
function paceStats(d) {
    const limit = d.best != null ? d.best * (1 + _pace.threshold / 100) : 0;
    const push = d.timed.filter(l => l.time <= limit);
    const times = push.map(l => l.time).sort((a, b) => a - b);
    const wear = {};
    for (const k of PACE_CORNERS) wear[k] = paceMean(d.wearLaps.map(l => l.wear[k]));
    return {
        push, times,
        mean: paceMean(times),
        median: paceQuantile(times, 0.5),
        sd: paceSd(times),
        q1: paceQuantile(times, 0.25),
        q3: paceQuantile(times, 0.75),
        best: d.best,
        wear,
        wearN: d.wearLaps.length,
    };
}

/* ══════════ RENDU ══════════ */

function renderPaceTab() {
    const root = document.getElementById('tab-pace');
    if (!root) return;
    paceTeamSync();
    const teamFiles = paceTeamFiles();
    const tracks = paceTracks();
    // Circuit par défaut : celui de l'envoi d'équipe le plus récent, sinon le dernier de la liste.
    if (!tracks.includes(_pace.track)) _pace.track = teamFiles[0]?.track || tracks[tracks.length - 1] || '';
    paceTeamLoadVisible(teamFiles);
    const drivers = paceBuildDrivers();
    const classes = new Set();
    paceAllFiles().forEach(f => f.enabled && f.track === _pace.track && f.laps.forEach(l => l.cls && classes.add(l.cls)));
    if (_pace.cls && !classes.has(_pace.cls)) _pace.cls = '';

    // Sélection par défaut (tant que l'utilisateur n'a rien coché lui-même, elle suit les données) :
    // les pilotes de l'équipe qui ont envoyé des tours sur ce circuit ; à défaut, l'équipage qui a
    // le plus de tours avec usure (= sa propre voiture), sinon le premier.
    const hadSelection = _pace.selected.length > 0;
    _pace.selected = _pace.selected.filter(n => drivers.has(n));
    if (hadSelection && !_pace.selected.length) _pace.selectionTouched = false;   // pilotes retirés : on repropose un choix
    const teamNames = Array.from(new Set(teamFiles.filter(f => f.enabled && f.track === _pace.track).map(f => f.driver)))
        .filter(n => drivers.has(n));
    if (!_pace.selectionTouched && teamNames.length) {
        _pace.selected = teamNames;
    } else if (!_pace.selected.length && !_pace.selectionTouched && drivers.size) {
        const groups = paceGroups(drivers);
        const pick = groups.slice().sort((a, b) =>
            b.drivers.reduce((s, d) => s + d.wearLaps.length, 0) - a.drivers.reduce((s, d) => s + d.wearLaps.length, 0))[0];
        _pace.selected = pick.drivers.filter(d => d.timed.length || d.wearLaps.length).map(d => d.name);
    }

    paceRenderFiles();
    paceRenderTeamFiles(teamFiles);
    paceRenderFilters(classes, tracks);
    paceRenderDriverList(drivers);
    paceRenderCharts(drivers);
}

function paceGroups(drivers) {
    const map = new Map();
    for (const d of drivers.values()) {
        if (!map.has(d.group)) map.set(d.group, { name: d.group, drivers: [] });
        map.get(d.group).drivers.push(d);
    }
    const groups = Array.from(map.values());
    groups.forEach(g => g.best = Math.min(...g.drivers.map(d => d.best ?? Infinity)));
    return groups.sort((a, b) => a.best - b.best);
}

function paceRenderFiles() {
    const el = document.getElementById('paceFileList');
    if (!el) return;
    if (!_pace.files.length) {
        el.innerHTML = '<div class="pace-muted">Aucun fichier importé.</div>';
        return;
    }
    el.innerHTML = _pace.files.map(f => `
        <label class="pace-file" title="${paceEsc(f.name)}">
            <input type="checkbox" ${f.enabled ? 'checked' : ''} onchange="paceToggleFile(${paceEsc(JSON.stringify(f.id))}, this.checked)">
            <span class="pace-file-main">
                <span>${paceEsc(f.track)}</span>
                <span class="pace-muted">${paceEsc(f.session)} · ${f.laps.length} tours</span>
                ${f.kind === 'json' ? `<select class="pace-file-track" onclick="event.stopPropagation()" onchange="paceSetFileTrack(${paceEsc(JSON.stringify(f.id))}, this.value)" title="Circuit de ce fichier">
                    ${Array.from(new Set(paceTracks().concat(PACE_NO_TRACK))).map(t => `<option value="${paceEsc(t)}" ${t === f.track ? 'selected' : ''}>${paceEsc(t)}</option>`).join('')}
                </select>` : ''}
            </span>
            <button type="button" class="pace-x" title="Retirer" onclick="event.preventDefault();paceRemoveFile(${paceEsc(JSON.stringify(f.id))})">✕</button>
        </label>`).join('');
}

function paceRenderTeamFiles(teamFiles) {
    const el = document.getElementById('paceTeamList');
    if (!el) return;
    if (_paceTeam.error) { el.innerHTML = `<div class="pace-muted">${paceEsc(_paceTeam.error)}</div>`; return; }
    if (!window._teamId) { el.innerHTML = '<div class="pace-muted">Connecte-toi à ton équipe pour voir ses envois.</div>'; return; }
    if (!teamFiles.length) {
        el.innerHTML = '<div class="pace-muted">Aucun envoi pour l\'instant. Le connecteur envoie les tours enregistrés quand on le ferme.</div>';
        return;
    }
    const me = window._firebaseAuth?.currentUser?.uid;
    const admin = window._teamRole === 'admin';
    const tracks = Array.from(new Set(paceTracks().concat(PACE_NO_TRACK)));
    el.innerHTML = teamFiles.map(f => {
        const state = _paceTeam.loading.has(f.id) ? ' · chargement…' : '';
        const date = f.recordedAt ? f.recordedAt.replace('T', ' ').slice(0, 16) : '';
        return `
        <label class="pace-file" title="${paceEsc(f.name)}">
            <input type="checkbox" ${f.enabled ? 'checked' : ''} onchange="paceToggleFile(${paceEsc(JSON.stringify(f.id))}, this.checked)">
            <span class="pace-file-main">
                <span>${paceEsc(f.session)}</span>
                <span class="pace-muted">${paceEsc(date)} · ${f.lapTotal} tours${state}</span>
                <select class="pace-file-track" onclick="event.stopPropagation()" onchange="paceSetFileTrack(${paceEsc(JSON.stringify(f.id))}, this.value)" title="Circuit de cet envoi">
                    ${tracks.map(t => `<option value="${paceEsc(t)}" ${t === f.track ? 'selected' : ''}>${paceEsc(t)}</option>`).join('')}
                </select>
            </span>
            ${(admin || f.uid === me) ? `<button type="button" class="pace-x" title="Supprimer pour toute l'équipe" onclick="event.preventDefault();paceDeleteTeamRun(${paceEsc(JSON.stringify(f.id))})">✕</button>` : ''}
        </label>`;
    }).join('');
}

function paceRenderFilters(classes, tracks) {
    const ts = document.getElementById('paceTrackSelect');
    if (ts) {
        ts.innerHTML = tracks.length ? tracks.map(t => `<option value="${paceEsc(t)}" ${t === _pace.track ? 'selected' : ''}>${paceEsc(t)}</option>`).join('')
            : '<option value="">—</option>';
    }
    const sel = document.getElementById('paceClassSelect');
    if (sel) {
        sel.innerHTML = '<option value="">Toutes</option>' +
            Array.from(classes).sort().map(c => `<option value="${paceEsc(c)}" ${c === _pace.cls ? 'selected' : ''}>${paceEsc(c)}</option>`).join('');
    }
    const th = document.getElementById('paceThreshold');
    const thv = document.getElementById('paceThresholdValue');
    if (th) th.value = _pace.threshold;
    if (thv) thv.textContent = `+${_pace.threshold}%`;
    const jd = document.getElementById('paceJsonDriver');
    if (jd && !jd.value) jd.value = _pace.jsonDriver || '';
}

function paceRenderDriverList(drivers) {
    const el = document.getElementById('paceDriverList');
    if (!el) return;
    if (!drivers.size) { el.innerHTML = '<div class="pace-muted">Importe un fichier pour voir les pilotes.</div>'; return; }
    const q = _pace.search.trim().toLowerCase();
    const groups = paceGroups(drivers).filter(g =>
        !q || g.name.toLowerCase().includes(q) || g.drivers.some(d => d.name.toLowerCase().includes(q)));
    el.innerHTML = groups.map(g => `
        <div class="pace-group">
            <div class="pace-group-head">
                <span>${paceEsc(g.name)}</span>
                <button type="button" onclick="paceSelectGroup(${paceEsc(JSON.stringify(g.name))})">Équipage seul</button>
            </div>
            ${g.drivers.map(d => `
                <label class="pace-driver">
                    <input type="checkbox" ${_pace.selected.includes(d.name) ? 'checked' : ''}
                           onchange="paceToggleDriver(${paceEsc(JSON.stringify(d.name))}, this.checked)">
                    <span>${paceEsc(d.name)}</span>
                    <span class="pace-muted">${paceFmtLap(d.best)} · ${d.timed.length} t.${d.wearLaps.length ? ' · usure' : ''}</span>
                </label>`).join('')}
        </div>`).join('') || '<div class="pace-muted">Aucun résultat.</div>';
}

function paceToggleDriver(name, on) {
    _pace.selected = _pace.selected.filter(n => n !== name);
    if (on) _pace.selected.push(name);
    _pace.selectionTouched = true;   // l'utilisateur a choisi : ne plus réappliquer la sélection par défaut
    paceSave();
    renderPaceTab();
}
function paceSelectGroup(group) {
    const drivers = paceBuildDrivers();
    _pace.selected = Array.from(drivers.values()).filter(d => d.group === group).map(d => d.name);
    _pace.selectionTouched = true;
    paceSave();
    renderPaceTab();
}
function paceSetClass(v) { _pace.cls = v; paceSave(); renderPaceTab(); }
function paceSetThreshold(v) { _pace.threshold = Math.max(0.5, Math.min(15, parseFloat(v) || 4)); paceSave(); renderPaceTab(); }
function paceSetSearch(v) {
    _pace.search = v;
    paceRenderDriverList(paceBuildDrivers());
}

function paceRenderCharts(drivers) {
    const wrap = document.getElementById('paceCharts');
    if (!wrap) return;
    const sel = _pace.selected.map(n => drivers.get(n)).filter(Boolean);
    if (!sel.length) {
        wrap.innerHTML = `<div class="pace-empty">
            <div style="font-size:2.2em;">📊</div>
            <div>Importe des fichiers puis coche les pilotes à comparer.</div>
            <div class="pace-muted">XML : <code>Le Mans Ultimate\\UserData\\Log\\Results</code> · JSON : dossier <code>telemetrie</code> du connecteur</div>
        </div>`;
        return;
    }
    const rows = sel.map((d, i) => ({ d, s: paceStats(d), color: PACE_DRIVER_COLORS[i % PACE_DRIVER_COLORS.length] }));
    const timed = rows.filter(r => r.s.times.length).sort((a, b) => a.s.mean - b.s.mean);

    let html = '';
    if (timed.length) {
        html += `<div class="pace-card">
            <div class="pace-card-title">Rythme par pilote <span class="pace-muted">— tours à moins de +${_pace.threshold}% du meilleur tour de chacun, hors stands</span></div>
            ${paceCompoundLegend(timed)}
            <div class="pace-svg-wrap">${paceViolinSvg(timed)}</div>
            ${paceStatsTable(timed)}
        </div>
        <div class="pace-card">
            <div class="pace-card-title">Tours triés <span class="pace-muted">— du plus rapide au plus lent</span></div>
            <div class="pace-svg-wrap">${paceSortedSvg(timed)}</div>
        </div>`;
    } else {
        html += '<div class="pace-card pace-muted">Aucun temps au tour valide pour ces pilotes.</div>';
    }
    const worn = rows.filter(r => r.s.wearN);
    html += `<div class="pace-card">
        <div class="pace-card-title">Usure des pneus <span class="pace-muted">— % d'usure moyen par tour, hors tours aux stands</span></div>
        ${worn.length ? `<div class="pace-svg-wrap">${paceWearSvg(worn)}</div>${paceWearTable(worn)}` :
        `<div class="pace-muted" style="padding:10px 0;">Aucune donnée d'usure pour ces pilotes. Les XML des sessions en ligne n'en contiennent pas :
         importe les fichiers JSON du connecteur (dossier <code>telemetrie</code>) ou un XML d'une session hors ligne.</div>`}
    </div>`;
    wrap.innerHTML = html;
}

function paceCompoundLegend(rows) {
    const used = new Set();
    rows.forEach(r => r.s.push.forEach(l => used.add(l.compound)));
    return `<div class="pace-legend">${Array.from(used).map(k => `
        <span><i style="background:${PACE_COMPOUND_COLORS[k] || '#888'}"></i>${paceCompoundLabel(k)}</span>`).join('')}</div>`;
}

/* ── Axes ── */
function paceNiceStep(range, target) {
    const raw = range / target;
    const steps = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60];
    return steps.find(s => s >= raw) || 60;
}
function paceYAxis(min, max, y, x0, x1) {
    const step = paceNiceStep(max - min, 6);
    let out = '';
    for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) {
        const yy = y(v).toFixed(1);
        out += `<line x1="${x0}" x2="${x1}" y1="${yy}" y2="${yy}" class="pace-grid"/>
                <text x="${x0 - 6}" y="${yy}" class="pace-tick" text-anchor="end" dominant-baseline="middle">${paceFmtLap(v)}</text>`;
    }
    return out;
}

/* ── Violons + boîtes + points ── */
function paceViolinSvg(rows) {
    const all = rows.flatMap(r => r.s.times);
    const pad = Math.max(0.15, (Math.max(...all) - Math.min(...all)) * 0.08);
    const yMin = Math.min(...all) - pad, yMax = Math.max(...all) + pad;
    const slot = 120, ml = 72, mr = 16, mt = 14, mb = 46, H = 400;
    const W = Math.max(560, ml + mr + slot * rows.length);
    const plotW = W - ml - mr;
    const step = plotW / rows.length;
    const y = v => mt + (yMax - v) / (yMax - yMin) * (H - mt - mb);
    let svg = `<svg viewBox="0 0 ${W} ${H}" class="pace-svg pace-svg-fluid" style="min-width:${Math.min(W, 140 + 90 * rows.length)}px" role="img" aria-label="Distribution des temps au tour par pilote">`;
    svg += paceYAxis(yMin, yMax, y, ml, W - mr);

    rows.forEach((r, i) => {
        const cx = ml + step * (i + 0.5);
        const half = Math.min(step * 0.42, 52);
        const t = r.s.times;
        // Violon : densité par noyau gaussien (largeur de bande de Silverman).
        if (t.length >= 3) {
            const sd = paceSd(t) || 0.05;
            const h = Math.max(0.03, 1.06 * sd * Math.pow(t.length, -0.2));
            const lo = Math.max(yMin, t[0] - 2.5 * h), hi = Math.min(yMax, t[t.length - 1] + 2.5 * h);
            const pts = [];
            for (let k = 0; k <= 60; k++) {
                const v = lo + (hi - lo) * k / 60;
                pts.push([v, t.reduce((s, x) => s + Math.exp(-0.5 * ((v - x) / h) ** 2), 0)]);
            }
            const dMax = Math.max(...pts.map(p => p[1]));
            const right = pts.map(([v, dd]) => `${(cx + dd / dMax * half).toFixed(1)},${y(v).toFixed(1)}`);
            const left = pts.slice().reverse().map(([v, dd]) => `${(cx - dd / dMax * half).toFixed(1)},${y(v).toFixed(1)}`);
            svg += `<polygon points="${right.concat(left).join(' ')}" fill="${r.color}" fill-opacity="0.55" stroke="${r.color}" stroke-width="1.2"/>`;
        }
        // Boîte : quartiles + moustaches à 1,5 × écart interquartile.
        const iqr = r.s.q3 - r.s.q1;
        const wLo = t.find(v => v >= r.s.q1 - 1.5 * iqr), wHi = [...t].reverse().find(v => v <= r.s.q3 + 1.5 * iqr);
        svg += `<line x1="${cx}" x2="${cx}" y1="${y(wLo).toFixed(1)}" y2="${y(wHi).toFixed(1)}" class="pace-box-line"/>
                <rect x="${cx - 7}" y="${y(r.s.q3).toFixed(1)}" width="14" height="${Math.max(1, y(r.s.q1) - y(r.s.q3)).toFixed(1)}" class="pace-box"/>
                <line x1="${cx - 7}" x2="${cx + 7}" y1="${y(r.s.median).toFixed(1)}" y2="${y(r.s.median).toFixed(1)}" class="pace-median"/>`;
        // Points : un par tour, couleur de la gomme, décalage horizontal déterministe.
        r.s.push.forEach((l, j) => {
            const jitter = (((j * 7919) % 97) / 97 - 0.5) * half * 0.9;
            const fill = PACE_COMPOUND_COLORS[l.compound] || '#888';
            svg += `<circle cx="${(cx + jitter).toFixed(1)}" cy="${y(l.time).toFixed(1)}" r="4.2" fill="${fill}" class="pace-dot">
                <title>${paceEsc(r.d.name)} — tour ${l.num} : ${paceFmtLap(l.time)}${l.s1 ? `\nS1 ${l.s1.toFixed(3)} · S2 ${(l.s2 ?? 0).toFixed(3)} · S3 ${(l.s3 ?? 0).toFixed(3)}` : ''}\nGomme : ${paceCompoundLabel(l.compound)}</title></circle>`;
        });
        svg += `<text x="${cx}" y="${H - mb + 18}" class="pace-xlabel" text-anchor="middle">${paceEsc(paceShortName(r.d.name)).slice(0, 18)}</text>
                <rect x="${cx - 14}" y="${H - mb + 28}" width="28" height="4" rx="2" fill="${r.color}"/>`;
    });
    return svg + '</svg>';
}

function paceStatsTable(rows) {
    const ref = rows[0].s.mean;
    return `<div class="pace-table-wrap"><table class="pace-table">
        <thead><tr><th>Pilote</th><th>Moyenne</th><th>Écart</th><th>Médiane</th><th>Meilleur</th><th>Écart-type</th><th>Tours</th></tr></thead>
        <tbody>${rows.map((r, i) => `<tr>
            <td><i class="pace-swatch" style="background:${r.color}"></i>${paceEsc(r.d.name)}</td>
            <td>${paceFmtLap(r.s.mean)}</td>
            <td>${i === 0 ? '<b>Référence</b>' : '+' + (r.s.mean - ref).toFixed(3) + 's'}</td>
            <td>${paceFmtLap(r.s.median)}</td>
            <td>${paceFmtLap(r.s.best)}</td>
            <td>${r.s.sd.toFixed(3)}s</td>
            <td>${r.s.times.length}</td>
        </tr>`).join('')}</tbody></table></div>`;
}

/* ── Tours triés ── */
function paceSortedSvg(rows) {
    const all = rows.flatMap(r => r.s.times);
    const n = Math.max(...rows.map(r => r.s.times.length));
    const pad = Math.max(0.1, (Math.max(...all) - Math.min(...all)) * 0.06);
    const yMin = Math.min(...all) - pad, yMax = Math.max(...all) + pad;
    const W = 760, H = 320, ml = 72, mr = 16, mt = 12, mb = 40;
    const x = i => ml + (n <= 1 ? 0 : i / (n - 1)) * (W - ml - mr);
    const y = v => mt + (yMax - v) / (yMax - yMin) * (H - mt - mb);
    let svg = `<svg viewBox="0 0 ${W} ${H}" class="pace-svg pace-svg-fluid" role="img" aria-label="Tours triés par pilote">`;
    svg += paceYAxis(yMin, yMax, y, ml, W - mr);
    const xStep = paceNiceStep(n, 8) < 1 ? 1 : Math.round(paceNiceStep(n, 8));
    for (let i = 0; i < n; i += xStep) {
        svg += `<text x="${x(i).toFixed(1)}" y="${H - mb + 16}" class="pace-tick" text-anchor="middle">${i + 1}</text>`;
    }
    svg += `<text x="${(ml + W - mr) / 2}" y="${H - 6}" class="pace-tick" text-anchor="middle">Rang du tour (trié)</text>`;
    rows.forEach(r => {
        const pts = r.s.times.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
        svg += `<polyline points="${pts}" fill="none" stroke="${r.color}" stroke-width="2.2" stroke-linejoin="round"/>`;
        r.s.times.forEach((v, i) => {
            svg += `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.6" fill="${r.color}"><title>${paceEsc(r.d.name)} — ${i + 1}e : ${paceFmtLap(v)}</title></circle>`;
        });
    });
    // Légende pilotes
    svg += rows.map((r, i) => `<g transform="translate(${ml + 8 + (i % 4) * 190}, ${mt + 8 + Math.floor(i / 4) * 16})">
        <rect width="14" height="4" y="-2" rx="2" fill="${r.color}"/><text x="20" class="pace-tick" dominant-baseline="middle">${paceEsc(r.d.name).slice(0, 24)}</text></g>`).join('');
    return svg + '</svg>';
}

/* ── Usure ── */
function paceWearSvg(rows) {
    const maxV = Math.max(0.05, ...rows.flatMap(r => PACE_CORNERS.map(k => r.s.wear[k] || 0))) * 1.15;
    const slot = 150, ml = 56, mr = 16, mt = 26, mb = 44, H = 300;
    const W = Math.max(560, ml + mr + slot * rows.length);
    const step = (W - ml - mr) / rows.length;
    const y = v => mt + (maxV - v) / maxV * (H - mt - mb);
    let svg = `<svg viewBox="0 0 ${W} ${H}" class="pace-svg pace-svg-fluid" style="min-width:${Math.min(W, 140 + 110 * rows.length)}px" role="img" aria-label="Usure moyenne par tour et par pneu">`;
    const tick = paceNiceStep(maxV, 5);
    for (let v = 0; v <= maxV + 1e-9; v += tick) {
        svg += `<line x1="${ml}" x2="${W - mr}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="pace-grid"/>
                <text x="${ml - 6}" y="${y(v).toFixed(1)}" class="pace-tick" text-anchor="end" dominant-baseline="middle">${v.toFixed(2)}%</text>`;
    }
    svg += PACE_CORNERS.map((k, i) => `<g transform="translate(${ml + 6 + i * 60}, 10)"><rect width="10" height="10" y="-5" rx="2" fill="${PACE_CORNER_COLORS[k]}"/>
        <text x="15" class="pace-tick" dominant-baseline="middle">${k}</text></g>`).join('');
    rows.forEach((r, i) => {
        const cx = ml + step * (i + 0.5);
        const bw = Math.min(22, step / 6);
        PACE_CORNERS.forEach((k, j) => {
            const v = r.s.wear[k] || 0;
            const bx = cx + (j - 2) * (bw + 3);
            svg += `<rect x="${bx.toFixed(1)}" y="${y(v).toFixed(1)}" width="${bw}" height="${(y(0) - y(v)).toFixed(1)}" rx="2" fill="${PACE_CORNER_COLORS[k]}">
                <title>${paceEsc(r.d.name)} — ${k} : ${v.toFixed(3)}% / tour</title></rect>`;
        });
        svg += `<text x="${cx}" y="${H - mb + 18}" class="pace-xlabel" text-anchor="middle">${paceEsc(paceShortName(r.d.name)).slice(0, 18)}</text>
                <rect x="${cx - 14}" y="${H - mb + 28}" width="28" height="4" rx="2" fill="${r.color}"/>`;
    });
    return svg + '</svg>';
}

function paceWearTable(rows) {
    return `<div class="pace-table-wrap"><table class="pace-table">
        <thead><tr><th>Pilote</th>${PACE_CORNERS.map(k => `<th>${k}</th>`).join('')}<th>Pneu le plus usé</th><th>Tours jusqu'à 50 %</th><th>Tours mesurés</th></tr></thead>
        <tbody>${rows.map(r => {
            const worst = PACE_CORNERS.reduce((a, k) => (r.s.wear[k] || 0) > (r.s.wear[a] || 0) ? k : a, 'FL');
            const wv = r.s.wear[worst] || 0;
            return `<tr>
                <td><i class="pace-swatch" style="background:${r.color}"></i>${paceEsc(r.d.name)}</td>
                ${PACE_CORNERS.map(k => `<td>${r.s.wear[k] != null ? r.s.wear[k].toFixed(3) + '%' : '—'}</td>`).join('')}
                <td>${worst}</td>
                <td>${wv > 0 ? Math.floor(50 / wv) : '—'}</td>
                <td>${r.s.wearN}</td>
            </tr>`;
        }).join('')}</tbody></table></div>`;
}

/* ══════════ INITIALISATION ══════════ */
function initPaceTab() {
    paceLoad();
    const drop = document.getElementById('paceDropZone');
    const input = document.getElementById('paceFileInput');
    if (input) input.addEventListener('change', () => { paceImportFiles(input.files); input.value = ''; });
    if (drop) {
        ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('drag'); }));
        ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('drag'); }));
        drop.addEventListener('drop', e => paceImportFiles(e.dataTransfer.files));
    }
    renderPaceTab();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initPaceTab);
else initPaceTab();
