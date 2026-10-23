/* ══════════════════════════════════════════════
   🌐 MODE LIVE À DISTANCE
   Alternative au serveur local (127.0.0.1:8777) : lit dans Firebase ce que le programme du
   pilote publie sous teams/{équipe}/sessions/{session}/stream/{pilote}/
   (voir run_remote_publisher dans collector/lmu_firebase_connector.py) et le remet sous la
   forme exacte de /live et /positions, pour que le Mode Live affiche la même chose qu'au
   PC du pilote. Lecture seule : ce fichier n'écrit jamais rien dans Firebase.

   Chaque nœud publié est {ts, j} où j = JSON sérialisé en texte. Les listes de champs
   ci-dessous DOIVENT rester identiques à STANDINGS_FIELDS / POSITION_FIELDS du collecteur.
   ══════════════════════════════════════════════ */

const REMOTE_STANDINGS_FIELDS = ['id', 'place', 'driver', 'vehicle', 'vclass', 'isPlayer', 'inPits', 'lap', 'gapToPlayer',
    'lastLapTime', 'veCurrentPct', 'leftCompound', 'rightCompound', 'avgVePerLapLast5', 'avgLapTimeLast5',
    'lastLaps'];
const REMOTE_POSITION_FIELDS = ['id', 'x', 'z', 'place', 'inPits', 'lap', 'lapDist', 'isPlayer'];
const REMOTE_STALE_MS = 15000;      // sans nouvelle donnée depuis ce délai : pilote considéré hors ligne
const REMOTE_SOURCE_KEY = 'lmuLiveSource';

window._liveRemote = {
    active: false,
    driverId: null,
    unsub: null,
    resolveTimer: null,
    parts: {},          // {live, laps, standings, positions} : {ts, obj}
    stats: null,        // objet de même forme que /live
    map: null,          // objet de même forme que /positions
    statsVer: 0,
    seededTrailKey: null,
    defaulted: false,
};

/** Vrai tant que le Mode Live suit un pilote à distance : on regarde, on n'écrit RIEN dans les données
 *  partagées de la session (ni état live, ni tableau des relais, ni « Fin live »). */
function liveRemoteReadOnly() {
    return !!(window._liveRemote && window._liveRemote.active);
}

/* ── Choix de la source ── */
function liveSourceChoice() {
    const el = document.getElementById('liveSourceSelect');
    return el ? el.value : 'local';
}
function liveSourceIsRemote() { return liveSourceChoice() !== 'local'; }

function onLiveSourceChange() {
    try { localStorage.setItem(REMOTE_SOURCE_KEY, liveSourceChoice()); } catch (e) { /* stockage indisponible : sans importance */ }
    if (window._liveMap && window._liveMap.active) {   // reconnecter sur la nouvelle source
        toggleLiveMap();
        toggleLiveMap();
    }
}

function _remoteTeamData() {
    return (typeof _teamTelemetryData !== 'undefined' && _teamTelemetryData) ? _teamTelemetryData : {};
}

/** Pilote à suivre : le choix explicite, ou « au volant » (le plus récent en ligne) en mode auto. */
function _remoteWantedDriver() {
    const choice = liveSourceChoice();
    if (choice.startsWith('d:')) return choice.slice(2);
    return typeof teamAtWheelDriver === 'function' ? teamAtWheelDriver() : null;
}

function refreshLiveSourceOptions() {
    const sel = document.getElementById('liveSourceSelect');
    if (!sel) return;
    const R = window._liveRemote;
    let current = sel.value;
    if (!R.defaulted && window._teamRole) {      // 1er affichage avec un rôle connu
        R.defaulted = true;
        let saved = null;
        try { saved = localStorage.getItem(REMOTE_SOURCE_KEY); } catch (e) { /* ignoré */ }
        current = saved || (window._teamRole === 'viewer' ? 'auto' : 'local');
    }
    const data = _remoteTeamData();
    const now = typeof teamNow === 'function' ? teamNow() : Date.now();
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const opts = [['local', '💻 Mon PC (programme lancé ici)'], ['auto', '🌐 À distance — pilote au volant']];
    Object.entries(data)
        .sort((a, b) => String(a[1].driverName || a[0]).localeCompare(String(b[1].driverName || b[0])))
        .forEach(([id, d]) => {
            const off = d.connected === false || !d.ts || now - d.ts > REMOTE_STALE_MS;
            opts.push([`d:${id}`, `🌐 ${d.driverName || id}${off ? ' (hors ligne)' : ''}`]);
        });
    if (current.startsWith('d:') && !opts.some(o => o[0] === current)) opts.push([current, '🌐 Pilote (introuvable)']);
    const html = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
    if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
    sel.value = opts.some(o => o[0] === current) ? current : 'local';
}

/* ── Abonnement Firebase ── */
function _remoteParse(node) {
    if (!node || typeof node.j !== 'string') return null;
    try { return { ts: node.ts || 0, obj: JSON.parse(node.j) }; } catch (e) { return null; }
}

function _remoteSubscribe(driverId) {
    const R = window._liveRemote;
    if (R.unsub) { R.unsub(); R.unsub = null; }
    R.parts = {}; R.stats = null; R.map = null; R.seededTrailKey = null;
    R.driverId = driverId;
    const sid = window._teamTelemetrySessionId;
    if (!driverId || !sid || !window._firebaseDb || !window._firebaseRef || !window._firebaseOnValue) return;
    const streamRef = window._firebaseRef(window._firebaseDb, teamPath(`sessions/${sid}/stream/${driverId}`));
    // Nœud séparé de « telemetry » : la carte d'équipe (toujours écoutée) ne télécharge pas ce flux.
    R.unsub = window._firebaseOnValue(streamRef, snap => {
        const v = snap.val() || {};
        R.parts = { live: _remoteParse(v.live), laps: _remoteParse(v.laps),
                    standings: _remoteParse(v.standings), positions: _remoteParse(v.positions) };
        _remoteRebuild();
    });
}

/** Reconstitue les objets /live et /positions à partir des morceaux publiés. */
function _remoteRebuild() {
    const R = window._liveRemote;
    const p = R.parts;
    if (!p.live) { R.stats = null; R.map = null; return; }
    const rows = (p.standings && Array.isArray(p.standings.obj)) ? p.standings.obj : [];
    const standings = rows.map(r => {
        const o = {};
        REMOTE_STANDINGS_FIELDS.forEach((f, i) => { o[f] = r[i] === undefined ? null : r[i]; });
        return o;
    });
    const laps = (p.laps && p.laps.obj) || {};
    R.stats = Object.assign({}, p.live.obj, {
        allLaps: laps.allLaps || [], recentLaps: laps.recentLaps || [],
        lastLapTrace: laps.lastLapTrace || [], bestSessionLapTrace: laps.bestSessionLapTrace || [],
        bestEventLapTrace: laps.bestEventLapTrace || [], currentLapTrace: [],
        standings,
    });
    R.statsVer++;

    if (p.positions && p.positions.obj) {
        const byId = {};
        standings.forEach(s => { byId[s.id] = s; });
        const pos = p.positions.obj;
        R.map = {
            connected: true, track: pos.track, session: pos.session, trackLength: pos.trackLength,
            numVehicles: pos.numVehicles, t: p.positions.ts / 1000, sectors: pos.sectors || null,
            cars: (pos.rows || []).map(r => {
                const c = {};
                REMOTE_POSITION_FIELDS.forEach((f, i) => { c[f] = r[i]; });
                c.inPits = !!c.inPits; c.isPlayer = !!c.isPlayer;
                const s = byId[c.id] || {};
                c.driver = s.driver || ''; c.vehicle = s.vehicle || ''; c.vclass = s.vclass || '';
                return c;
            }),
        };
    }
    _remoteSeedTrail(laps.trail, !!laps.trailFrozen);
}

/** Un spectateur qui arrive en cours de course reçoit le tour propre mémorisé par le programme du pilote :
 *  le circuit se dessine tout de suite. `frozen` = le programme a fini d'enregistrer (3 tours propres). */
function _remoteSeedTrail(trail, frozen) {
    const R = window._liveRemote;
    const M = window._liveMap;
    if (!Array.isArray(trail) || trail.length < 20 || !M) return;
    const key = trail.length + ':' + trail[0] + ':' + trail[trail.length - 1] + ':' + frozen;
    if (R.seededTrailKey === key) return;
    R.seededTrailKey = key;
    if (M.frozen && !(R.map && R.map.track && M.trackName && R.map.track !== M.trackName)) return;   // tracé figé déjà en place
    if (R.map && R.map.track) {   // autre circuit que celui du tracé en mémoire : on repart de zéro
        if (M.trackName && M.trackName !== R.map.track) _liveMapResetTrailState();
        M.trackName = R.map.track;
    }
    M.trail = trail.map(([x, z]) => ({ x, z }));
    M.bounds = _liveMapBoundsOf(M.trail);
    M.complete = true;
    if (frozen) { M.frozen = true; _liveMapSaveTrailCache(); }
}

/* ── Lecture par le Mode Live ── */
function _remoteAgeMs() {
    const live = window._liveRemote.parts.live;
    return live ? (typeof teamNow === 'function' ? teamNow() : Date.now()) - live.ts : Infinity;
}

function remoteStatsData() {
    const R = window._liveRemote;
    if (!R.stats || _remoteAgeMs() > REMOTE_STALE_MS) return { connected: false };
    return Object.assign({ _ver: R.statsVer }, R.stats);
}

function remoteMapData() {
    const R = window._liveRemote;
    if (!R.map || _remoteAgeMs() > REMOTE_STALE_MS) return { connected: false, error: 'pilote hors ligne ou en attente' };
    return R.map;
}

/** Texte et pastille d'état de la carte, côté « à distance ». */
function remoteStatusText() {
    const R = window._liveRemote;
    const name = (_remoteTeamData()[R.driverId] || {}).driverName || R.driverId;
    if (!window._teamTelemetrySessionId) return { color: '#ff4466', text: '🌐 Ouvrez une session d\'équipe pour suivre un pilote à distance.' };
    if (!R.driverId) return { color: '#ffaa00', text: '🌐 En attente d\'un pilote qui roule (programme lancé et en piste)…' };
    const age = _remoteAgeMs();
    if (!isFinite(age)) return { color: '#ffaa00', text: `🌐 ${name} : aucune donnée de Mode Live reçue (programme à jour ? en piste ?)` };
    if (age > REMOTE_STALE_MS) return { color: '#ff4466', text: `🌐 ${name} hors ligne — dernière donnée il y a ${Math.round(age / 1000)} s` };
    const n = R.map ? R.map.numVehicles : '?';
    return { color: '#00ff88', text: `🌐 ${name} — ${(R.map && R.map.track) || (R.stats && R.stats.trackName) || 'Circuit'} — ${n} voiture(s)` };
}

function remoteLiveStart() {
    const R = window._liveRemote;
    R.active = true;
    R.driverId = null;
    _remoteTick();
    R.resolveTimer = setInterval(_remoteTick, 2000);
}

function _remoteTick() {
    const R = window._liveRemote;
    if (!R.active) return;
    const want = _remoteWantedDriver();
    if (want && want !== R.driverId) {
        const hadOther = R.driverId !== null;
        _remoteSubscribe(want);
        if (hadOther) {   // relais : on repart d'un tracé et de courbes propres pour le nouveau pilote
            if (typeof resetLiveMapTrail === 'function') resetLiveMapTrail();
            if (typeof _resetLiveCharts === 'function') _resetLiveCharts();
        }
    }
}

function remoteLiveStop() {
    const R = window._liveRemote;
    R.active = false;
    if (R.unsub) { R.unsub(); R.unsub = null; }
    if (R.resolveTimer) { clearInterval(R.resolveTimer); R.resolveTimer = null; }
    R.parts = {}; R.stats = null; R.map = null; R.driverId = null; R.seededTrailKey = null;
}

document.addEventListener('DOMContentLoaded', refreshLiveSourceOptions);
