/* ════════════════════════════════════════════════════════════
   🗺️ CARTE LIVE — positions voitures via lmu_live_map_server.py
   (lit LMU_SharedMemoryMapPlugin64.dll en local, exposé en HTTP
   sur 127.0.0.1 ; ce script interroge cette adresse en boucle)
   ════════════════════════════════════════════════════════════ */

window._liveMap = {
    active: false,
    pollTimer: null,
    trail: [],          // [{x,z}] UN tour propre de la voiture du joueur -> dessine le circuit
    bounds: null,        // {minX,maxX,minZ,maxZ} du tracé
    trackName: null,     // nom du circuit du tracé en cours (pour invalider le cache si on change de circuit)
    carColors: {},       // id voiture -> couleur stable
    lastError: null,
    // Enregistrement du tracé : on garde le dernier tour PROPRE (sans passage aux stands,
    // vu depuis la ligne) et, après LIVE_MAP_TRAIL_LAPS tours propres, on fige le dessin
    // définitivement — plus aucune ré-écriture de la carte aux tours suivants.
    frozen: false,       // tracé figé : plus d'enregistrement
    complete: false,     // `trail` est un tour complet (et non plus un tour en cours de dessin)
    cleanLaps: 0,        // nb de tours propres bouclés depuis le début de l'enregistrement
    lapPts: [],          // points du tour en cours d'enregistrement
    lapNum: null,        // numéro de tour du joueur au dernier poll
    lapSeen: false,      // le début du tour en cours a été vu (sinon tour partiel : ignoré)
    lapPit: false,       // le tour en cours est passé par les stands : ignoré
};
const LIVE_MAP_TRAIL_LAPS = 3;

/* Le tracé figé est sauvegardé dans localStorage (par navigateur) pour qu'un
   rechargement de page ou une reconnexion (local OU à distance) retrouve
   immédiatement le circuit déjà dessiné, au lieu de repartir d'une carte vide en
   attendant d'avoir re-roulé des tours. Pas de dépendance réseau ni de session
   partagée : juste la mémoire du dernier circuit vu dans CE navigateur.
   v2 : l'ancien format (tracé cumulé sur tous les tours) est volontairement ignoré. */
const _LIVE_MAP_TRAIL_STORAGE_KEY = 'lmuLiveMapTrailCacheV2';

function _liveMapLoadTrailCache() {
    try {
        const raw = localStorage.getItem(_LIVE_MAP_TRAIL_STORAGE_KEY);
        if (!raw) return;
        const cached = JSON.parse(raw);
        if (!cached || !Array.isArray(cached.trail) || cached.trail.length < 20 || !cached.bounds) return;
        const M = window._liveMap;
        M.trail = cached.trail;
        M.bounds = cached.bounds;
        M.trackName = cached.track || null;
        M.frozen = true;
        M.complete = true;
    } catch (e) { /* stockage indisponible (navigation privée, quota…) : on repart à vide, sans importance */ }
}

function _liveMapSaveTrailCache() {
    try {
        const M = window._liveMap;
        if (M.trail.length < 20 || !M.bounds) return;
        localStorage.setItem(_LIVE_MAP_TRAIL_STORAGE_KEY, JSON.stringify({
            track: M.trackName || null, trail: M.trail, bounds: M.bounds,
        }));
    } catch (e) { /* stockage indisponible : sans importance, juste pas de cache cette fois */ }
}

/** Repart d'un tracé vide (changement de circuit / de pilote suivi). */
function _liveMapResetTrailState() {
    const M = window._liveMap;
    M.trail = []; M.bounds = null; M.frozen = false; M.complete = false;
    M.cleanLaps = 0; M.lapPts = []; M.lapNum = null; M.lapSeen = false; M.lapPit = false;
}

/* ── Base partagée des tracés : trackMaps/{circuit}, commune à toutes les équipes ──
   Le nom du circuit vient du jeu, identique pour tous : le premier qui boucle 3 tours
   propres sur un circuit inconnu l'enregistre, les suivants le reçoivent dès l'arrivée
   en piste. Le connecteur fait la même chose (SharedTrackMap, lmu_firebase_connector.py) ;
   les règles n'acceptent qu'un seul envoi par circuit (l'auteur peut le refaire). */
const LIVE_MAP_SHARED_RETRY_MS = 60000;
window._liveMap.shared = {track: null, state: null, rec: null, nextTry: 0};

/** Nom de circuit -> clé Firebase. DOIT rester identique à track_map_key (collecteur). */
function _liveMapTrackKey(track) {
    const key = String(track || '').trim().replace(/[.$#\[\]\/\x00-\x1f\x7f]/g, '_').slice(0, 120);
    return key || null;
}

function _liveMapMarksComplete(marks) {
    return Array.isArray(marks) && marks.length === 3 && marks.every(m => Array.isArray(m) && m.length === 2);
}

function _liveMapApplyShared(rec) {
    const M = window._liveMap;
    M.trail = rec.trail.map(([x, z]) => ({x, z}));
    M.bounds = _liveMapBoundsOf(M.trail);
    M.complete = true;
    M.frozen = true;
    M.lapPts = [];
    _liveMapSaveTrailCache();
}

/** Lecture (une fois par circuit) puis, si le circuit est inconnu, envoi de notre tracé figé. */
function _liveMapSyncShared(data) {
    const M = window._liveMap, S = M.shared;
    const key = _liveMapTrackKey(data.track);
    const user = window._firebaseAuth && window._firebaseAuth.currentUser;
    if (!key || !user || !window._firebaseDb || !window._firebaseGet || !window._firebaseRef) return;
    if (S.track !== data.track) Object.assign(S, {track: data.track, state: 'unknown', rec: null, nextTry: 0});
    if (S.state === 'present') {
        if (!M.frozen) _liveMapApplyShared(S.rec);   // après un relais / une remise à zéro
        return;
    }
    if (S.state !== 'unknown' && S.state !== 'absent') return;   // requête en cours, ou terminé
    if (Date.now() < S.nextTry) return;
    const nodeRef = window._firebaseRef(window._firebaseDb, `trackMaps/${key}`);
    const retryLater = st => { if (S.track === data.track) { S.state = st; S.nextTry = Date.now() + LIVE_MAP_SHARED_RETRY_MS; } };

    if (S.state === 'unknown') {
        S.state = 'loading';
        window._firebaseGet(nodeRef).then(snap => {
            if (S.track !== data.track) return;
            let rec = null;
            try {
                const v = snap.val();
                const obj = v && typeof v.j === 'string' ? JSON.parse(v.j) : null;
                if (obj && Array.isArray(obj.trail) && obj.trail.length >= 20) {
                    rec = {trail: obj.trail, marks: _liveMapMarksComplete(obj.marks) ? obj.marks : null};
                }
            } catch (e) { rec = null; }
            S.rec = rec;
            S.state = rec ? 'present' : 'absent';
            if (rec && M.trackName === data.track) {
                _liveMapApplyShared(rec);
                if (M.lastData) _liveMapDrawIfShown(M.lastData);
            }
        }).catch(e => {
            if (String(e && e.message).toLowerCase().includes('permission')) { if (S.track === data.track) S.state = 'done'; }
            else retryLater('unknown');
        });
        return;
    }

    // Circuit inconnu de la base : on envoie NOTRE tracé une fois figé, depuis le PC du pilote
    // seulement (à distance, c'est son connecteur qui s'en charge, avec un tracé plus fin).
    const marks = data.sectors && data.sectors.marks;
    const canWrite = window._teamId && (window._teamRole === 'admin' || window._teamRole === 'driver');
    const remote = window._liveRemote && window._liveRemote.active;
    if (remote || !canWrite || !M.frozen || M.trackName !== data.track || !_liveMapMarksComplete(marks)) return;
    S.state = 'saving';
    const trail = M.trail.map(p => [Math.round(p.x * 10) / 10, Math.round(p.z * 10) / 10]);
    window._firebaseSet(nodeRef, {
        ts: window._firebaseServerTimestamp ? window._firebaseServerTimestamp() : Date.now(),
        uid: user.uid, team: window._teamId,
        j: JSON.stringify({track: data.track, trackLength: data.trackLength || null, trail, marks}),
    }).then(() => {
        if (S.track === data.track) { S.state = 'present'; S.rec = {trail, marks}; }
    }).catch(e => {
        if (String(e && e.message).toLowerCase().includes('permission')) { if (S.track === data.track) S.state = 'done'; }
        else retryLater('absent');
    });
}

function _liveMapBoundsOf(pts) {
    return {
        minX: Math.min(...pts.map(q => q.x)), maxX: Math.max(...pts.map(q => q.x)),
        minZ: Math.min(...pts.map(q => q.z)), maxZ: Math.max(...pts.map(q => q.z)),
    };
}

window._liveStats = {
    active: false,
    pollTimer: null,
    url: null,
    baselineTyreBudget: null,   // valeur de #tyreBudget capturée au moment de la connexion
    lastError: null,
    inFlight: false,            // évite d'empiler des fetch concurrents à 50Hz
    tickCount: 0,                // compteur de polls, pour throttler classement/courbes
};

function _liveMapColorFor(id) {
    if (window._liveMap.carColors[id]) return window._liveMap.carColors[id];
    const palette = ['#00ff88', '#00aaff', '#ffaa00', '#ff4466', '#aa00ff', '#00ffcc', '#ff6600', '#ffffff'];
    const c = palette[Object.keys(window._liveMap.carColors).length % palette.length];
    window._liveMap.carColors[id] = c;
    return c;
}

function resetLiveMapTrail() {
    _liveMapResetTrailState();
    window._liveMap.trackName = null;
    _liveMapDraw({connected: false});
}

function toggleLiveMap() {
    if (window._liveMap.active) {
        _liveMapStop();
    } else {
        _liveMapStart();
    }
}

function _liveMapStart() {
    if (typeof livePlansOnConnect === 'function') livePlansOnConnect();   // copie des plans de la planification (1re connexion)
    const port = parseInt(document.getElementById('liveMapPort').value, 10) || 8777;
    window._liveMap.active = true;
    window._liveMap.url = `http://127.0.0.1:${port}/positions`;
    window._liveStats.active = true;
    window._liveStats.url = `http://127.0.0.1:${port}/live`;
    window._liveStats.baselineTyreBudget = null; // capturé au 1er /live reçu
    window._liveStats.tickCount = 0;
    window._liveStats.inFlight = false;
    const btn = document.getElementById('liveMapToggleBtn');
    if (btn) { btn.textContent = '⏸️ Déconnecter'; btn.style.background = 'rgba(255,68,102,0.2)'; btn.style.borderColor = '#ff4466'; btn.style.color = '#ff4466'; }
    // Retrouve immédiatement le circuit déjà dessiné lors d'une précédente
    // connexion dans ce navigateur, le temps que les premières positions arrivent.
    if (!window._liveMap.bounds) _liveMapLoadTrailCache();
    // Source « à distance » : on lit Firebase (publié par le programme du pilote) au lieu du serveur local.
    const remote = typeof liveSourceIsRemote === 'function' && liveSourceIsRemote();
    if (remote) remoteLiveStart();
    _liveMapPollOnce();
    _liveStatsPollOnce();
    window._liveMap.pollTimer = setInterval(_liveMapPollOnce, 500);
    // Données complètes (grille, historique des tours, traces : plusieurs centaines de Ko)
    // une fois par seconde ; à distance, elles arrivent 2 fois/s via Firebase.
    window._liveStats.pollTimer = setInterval(_liveStatsPollOnce, remote ? 250 : 1000);
    // Jauges instantanées (vitesse, pédales, températures…) : réponse légère /live?lite=1,
    // 20 fois par seconde — en local seulement.
    window._liveStats.gaugeInFlight = false;
    if (!remote) window._liveStats.gaugeTimer = setInterval(_liveGaugesPollOnce, 50);
}

/* Vrai si l'élément est réellement affiché à l'écran : page au premier plan, pas
   dans un onglet / un <details> fermé, et au moins en partie dans la fenêtre. Sert
   à ne pas redessiner des graphiques que personne ne regarde. */
function _liveIsOnScreen(el) {
    if (!el || document.hidden) return false;
    const shown = typeof el.checkVisibility === 'function'
        ? el.checkVisibility() : el.getClientRects().length > 0;
    if (!shown) return false;
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight && r.width > 0 && r.height > 0;
}

/* Jauges instantanées seules (/live?lite=1, ~1 Ko). Rien n'est demandé si aucune
   jauge n'est à l'écran : les données complètes (1/s) les rafraîchissent de toute façon. */
async function _liveGaugesPollOnce() {
    const S = window._liveStats;
    if (!S.active || S.gaugeInFlight) return;
    if (!_liveIsOnScreen(document.getElementById('liveSpeedKmh'))
        && !_liveIsOnScreen(document.getElementById('liveMapCanvas'))) return;
    S.gaugeInFlight = true;
    try {
        const resp = await fetch(S.url + '?lite=1', {cache: 'no-store'});
        if (!resp.ok) return;
        const data = await resp.json();
        if (!data.connected) return;
        if (!data.lite) {
            // Connecteur d'une version précédente : il renvoie tout à chaque fois. On arrête
            // ce poll rapide (trop coûteux) ; les jauges suivent alors les données complètes (1/s).
            clearInterval(S.gaugeTimer);
            S.gaugeTimer = null;
            return;
        }
        _updateLiveTelemetryExtras(data);
    } catch (e) {
        S.lastError = e;
    } finally {
        S.gaugeInFlight = false;
    }
}

// Bouton « Lancer le connecteur » : le lien lmu-connecteur:// est déclaré par le connecteur à sa première ouverture.
function onLaunchConnectorClick() {
    const txt = document.getElementById('liveMapStatusText');
    if (txt && !(window._liveMap && window._liveMap.active)) {
        txt.textContent = "Ouverture du connecteur… (si rien ne s'ouvre, lancez-le une première fois à la main, puis réessayez)";
    }
}

function _liveMapStop() {
    if (typeof remoteLiveStop === 'function') remoteLiveStop();
    window._liveMap.active = false;
    if (window._liveMap.pollTimer) clearInterval(window._liveMap.pollTimer);
    window._liveMap.pollTimer = null;
    window._liveStats.active = false;
    if (window._liveStats.pollTimer) clearInterval(window._liveStats.pollTimer);
    window._liveStats.pollTimer = null;
    if (window._liveStats.gaugeTimer) clearInterval(window._liveStats.gaugeTimer);
    window._liveStats.gaugeTimer = null;
    const btn = document.getElementById('liveMapToggleBtn');
    if (btn) { btn.textContent = '▶️ Connecter'; btn.style.background = 'rgba(var(--accent-rgb),0.2)'; btn.style.borderColor = 'var(--accent)'; btn.style.color = 'var(--accent)'; }
    const dot = document.getElementById('liveMapStatusDot');
    if (dot) dot.style.background = 'var(--text-4)';
    const txt = document.getElementById('liveMapStatusText');
    if (txt) txt.textContent = 'Non connecté.';
    const lsTxt = document.getElementById('liveStatsStatusText');
    if (lsTxt) lsTxt.textContent = 'Non connecté.';
    _resetLiveCharts();
    // Oublier l'horloge ingame live et la durée de séance restante : au
    // prochain recalcul, on repasse sur l'heure de départ/durée saisies
    // manuellement en planification.
    window._liveGameClockNow = undefined;
    window._liveSessionTimeRemainingSec = undefined;
}

async function _liveMapPollOnce() {
    if (!window._liveMap.active) return;
    const dot = document.getElementById('liveMapStatusDot');
    const txt = document.getElementById('liveMapStatusText');
    try {
        if (window._liveRemote && window._liveRemote.active) {
            const rdata = remoteMapData();
            const st = remoteStatusText();
            if (dot) dot.style.background = st.color;
            if (txt) txt.textContent = st.text;
            if (rdata.connected) { _liveMapAccumulateTrail(rdata); _liveMapDrawIfShown(rdata); }
            else _liveMapDrawIfShown({connected: false});
            return;
        }
        const resp = await fetch(window._liveMap.url, {cache: 'no-store'});
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        if (!data.connected) {
            if (dot) dot.style.background = '#ffaa00';
            if (txt) txt.textContent = '⏳ Serveur local joint, mais LMU non détecté — ' + (data.error || 'lancez le jeu.');
            return;
        }
        if (dot) dot.style.background = 'var(--accent)';
        if (txt) txt.textContent = `✅ ${data.track || 'Circuit'} — ${data.numVehicles} voiture(s)`;
        _liveMapAccumulateTrail(data);
        _liveMapDrawIfShown(data);
    } catch (e) {
        if (dot) dot.style.background = '#ff4466';
        if (txt) txt.textContent = '❌ Serveur local introuvable sur ce port. Lancez le connecteur LMU Stratégie sur le PC du jeu (ou lmu_telemetry_logger.py) et vérifiez le port.';
        window._liveMap.lastError = e;
    }
}

/* Le tracé continue d'être enregistré dans tous les cas ; seul le dessin est sauté
   quand la carte n'est pas à l'écran (repli fermé, autre onglet, hors de la fenêtre). */
function _liveMapDrawIfShown(data) {
    window._liveMap.lastData = data;
    if (_liveIsOnScreen(document.getElementById('liveMapCanvas'))) _liveMapDraw(data);
}

// À l'ouverture du repli « Carte live » : dessin immédiat avec les dernières positions reçues.
document.getElementById('liveMapCanvas')?.closest('details')?.addEventListener('toggle', e => {
    if (e.target.open && window._liveMap.lastData) {
        requestAnimationFrame(() => {
            _liveMapDraw(window._liveMap.lastData);
            _renderLiveMapClassStandings();
        });
    }
});

function _liveMapAccumulateTrail(data) {
    const player = (data.cars || []).find(c => c.isPlayer);
    if (!player) return;
    // Le tracé en mémoire/cache venait peut-être d'un autre circuit (cache d'une
    // session précédente, ou changement de pilote suivi à distance) : on repart
    // de zéro plutôt que de mélanger deux circuits dans le même dessin.
    const M = window._liveMap;
    if (data.track && M.trackName && data.track !== M.trackName) _liveMapResetTrailState();
    if (data.track) M.trackName = data.track;
    _liveMapSyncShared(data);
    if (M.frozen) return;   // tracé définitif : on n'y touche plus

    // Passage de ligne : le tour qui vient de finir, s'il est propre (début vu, aucun
    // passage aux stands), devient LE tracé affiché ; après LIVE_MAP_TRAIL_LAPS tours
    // propres on fige et on mémorise.
    if (M.lapNum !== null && player.lap !== M.lapNum) {
        if (M.lapSeen && !M.lapPit && M.lapPts.length >= 20) {
            M.cleanLaps++;
            M.trail = M.lapPts;
            M.bounds = _liveMapBoundsOf(M.trail);
            M.complete = true;
            if (M.cleanLaps >= LIVE_MAP_TRAIL_LAPS) {
                M.frozen = true;
                _liveMapSaveTrailCache();
                return;
            }
        }
        M.lapPts = [];
        M.lapSeen = true;
        M.lapPit = !!player.inPits;   // un tour qui démarre aux stands est un tour de sortie
    }
    M.lapNum = player.lap;
    if (player.inPits) M.lapPit = true;

    const pts = M.lapPts;
    const last = pts[pts.length - 1];
    // n'ajouter un point que si la voiture a réellement bougé (évite d'accumuler à l'arrêt/pit)
    if (!last || Math.hypot(player.x - last.x, player.z - last.z) > 1.0) {
        pts.push({x: player.x, z: player.z});
        if (!M.complete) {   // tant qu'aucun tour propre n'est bouclé : aperçu du tour en cours
            M.trail = pts;
            let b = M.bounds;
            if (!b) { b = {minX: player.x, maxX: player.x, minZ: player.z, maxZ: player.z}; }
            b.minX = Math.min(b.minX, player.x); b.maxX = Math.max(b.maxX, player.x);
            b.minZ = Math.min(b.minZ, player.z); b.maxZ = Math.max(b.maxZ, player.z);
            M.bounds = b;
        }
    }
}

/** Trace une polyligne lissée (courbes passant par les milieux des segments). */
function _liveMapStrokeSmooth(ctx, pts) {
    if (pts.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
        ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    ctx.stroke();
}

const _LIVE_SECTOR_COLORS = {purple: '#b44dff', green: '#00e676', yellow: '#ffd600'};

/** Indice du point du tracé le plus proche de (x, z). */
function _liveMapNearestIdx(trail, x, z) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < trail.length; i++) {
        const d = (trail[i].x - x) ** 2 + (trail[i].z - z) ** 2;
        if (d < bd) { bd = d; best = i; }
    }
    return best;
}

/** Délimitations des 3 secteurs + tronçons colorés selon les chronos (violet/vert/jaune). */
function _liveMapDrawSectors(ctx, trail, toPx, sectors) {
    if (!sectors || !Array.isArray(sectors.marks) || trail.length < 20) return;
    const marks = sectors.marks;
    if (marks.length !== 3 || marks.some(m => !Array.isArray(m))) return;
    const idx = marks.map(m => _liveMapNearestIdx(trail, m[0], m[1]));
    const px = trail.map(p => toPx(p.x, p.z));
    ctx.lineJoin = 'round'; ctx.lineCap = 'butt';
    for (let s = 0; s < 3; s++) {
        const color = _LIVE_SECTOR_COLORS[(sectors.colors || [])[s]];
        if (!color) continue;
        const a = idx[s], b = idx[(s + 1) % 3];
        const seg = b >= a ? px.slice(a, b + 1) : px.slice(a).concat(px.slice(0, b + 1));
        ctx.strokeStyle = color;
        ctx.lineWidth = 6;
        _liveMapStrokeSmooth(ctx, seg);
    }
    // Traits de délimitation, perpendiculaires au tracé (ligne d'arrivée + 2 intermédiaires)
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.5;
    marks.forEach((m, s) => {
        const i = idx[s];
        const p0 = px[(i - 2 + px.length) % px.length], p1 = px[(i + 2) % px.length];
        let dx = p1[0] - p0[0], dy = p1[1] - p0[1];
        const len = Math.hypot(dx, dy) || 1;
        dx /= len; dy /= len;
        const [cx, cy] = px[i], nx = -dy * 11, ny = dx * 11;
        ctx.beginPath();
        ctx.moveTo(cx - nx, cy - ny);
        ctx.lineTo(cx + nx, cy + ny);
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(s === 0 ? 'S/F' : 'S' + (s + 1), cx + nx * 1.9, cy + ny * 1.9 + 3);
    });
}

/** Bornes de secteurs du jeu, complétées par celles de la base partagée tant que le pilote
 *  ne les a pas toutes franchies (les délimitations s'affichent alors dès l'arrivée en piste). */
function _liveMapSectorsWithShared(data) {
    const S = window._liveMap.shared;
    const shared = S.track === data.track && S.rec && S.rec.marks;
    const live = data.sectors;
    if (!shared || (live && _liveMapMarksComplete(live.marks))) return live;
    return Object.assign({colors: []}, live, {marks: shared});
}

function _liveMapDraw(data) {
    const canvas = document.getElementById('liveMapCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const b = window._liveMap.bounds;
    if (!b) {
        ctx.fillStyle = '#888';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('En attente de données de position… (roulez 3 tours propres pour dessiner le circuit)', W/2, H/2);
        document.getElementById('liveMapLegend').innerHTML = '';
        return;
    }

    const pad = 30;
    const spanX = Math.max(1, b.maxX - b.minX);
    const spanZ = Math.max(1, b.maxZ - b.minZ);
    // Échelle UNIFORME (la forme du circuit n'est jamais déformée). Pour ne pas
    // gaspiller de place, c'est la hauteur du canvas qui s'adapte à la forme du
    // circuit (par pas de 20 px, pour ne pas « respirer » pendant le dessin).
    const wantH = Math.max(320, Math.min(800, Math.round(((W - 2*pad) * spanZ / spanX + 2*pad) / 20) * 20));
    if (canvas.height !== wantH && window._liveMap.complete) {
        canvas.height = wantH;
        canvas.style.aspectRatio = `${W}/${wantH}`;
        return _liveMapDraw(data);
    }
    const scale = Math.min((W - 2*pad) / spanX, (H - 2*pad) / spanZ);
    const offX = pad + ((W - 2*pad) - spanX * scale) / 2;
    const offY = pad + ((H - 2*pad) - spanZ * scale) / 2;
    // Carte tournée à 180° (X et Z tous deux inversés) par rapport au repère
    // monde brut, pour matcher l'orientation du circuit vue en jeu.
    const toPx = (x, z) => {
        const px = offX + (x - b.minX) * scale;
        const py = offY + (b.maxZ - z) * scale;
        return [px, py];
    };

    // Tracé du circuit (un tour propre du joueur)
    const trail = window._liveMap.trail;
    if (trail.length > 1) {
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 6;
        ctx.lineJoin = 'round';
        _liveMapStrokeSmooth(ctx, trail.map(p => toPx(p.x, p.z)));
        if (window._liveMap.complete) _liveMapDrawSectors(ctx, trail, toPx, _liveMapSectorsWithShared(data));
    }

    // Voitures
    const legendItems = [];
    (data.cars || []).forEach(car => {
        const [px, py] = toPx(car.x, car.z);
        const color = _liveClassColor(car.vclass) || _liveMapColorFor(car.id);
        ctx.beginPath();
        ctx.arc(px, py, car.isPlayer ? 8 : 6, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        if (car.isPlayer) {
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.stroke();
        }
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(String(car.place || ''), px, py - 11);
        legendItems.push(`<span style="display:inline-flex;align-items:center;gap:4px;">
            <span style="width:9px;height:9px;border-radius:50%;background:${color};display:inline-block;"></span>
            P${car.place || '?'} ${car.isPlayer ? '⭐' : ''} ${_teamTelemetryEscapeHtml((car.driver || '').trim() || car.vehicle || '—')}
        </span>`);
    });
    const legend = document.getElementById('liveMapLegend');
    if (legend) legend.innerHTML = legendItems.join('');
}

/* ────────────────────────────────────────────────────────────
   📡 DONNÉES LIVE (EV, tours, temps/tour, conso, pneus) — auto-
   remplissage des champs de l'onglet Stratégie depuis /live
   (même serveur local que la carte).
   ──────────────────────────────────────────────────────────── */

function _fmtLapTimeToFields(totalSeconds) {
    if (totalSeconds == null || isNaN(totalSeconds)) return null;
    const m = Math.floor(totalSeconds / 60);
    const s = Math.floor(totalSeconds % 60);
    const d = Math.round((totalSeconds - Math.floor(totalSeconds)) * 10);
    return {m, s, d};
}

/* Moyenne d'un champ sur les N derniers tours d'un tableau recentLaps
   (renvoyé par /live), en ignorant les tours où ce champ est absent
   (ex: tout premier tour sans vePctUsed). Renvoie null si rien d'exploitable. */
function _windowedLapAvg(recentLaps, n, key) {
    if (!Array.isArray(recentLaps) || recentLaps.length === 0) return null;
    const slice = recentLaps.slice(-n).filter(l => l && l[key] != null);
    if (slice.length === 0) return null;
    return slice.reduce((sum, l) => sum + l[key], 0) / slice.length;
}

/* Plages de valeurs jugées plausibles par tour (en %/tour). En dehors — proche
   de zéro (tour sans mesure, arrêt aux stands) ou aberrant (recharge, changement
   de pneus) — la valeur est ignorée et on passe à la source suivante. */
const _LIVE_EV_VALID   = {min: 0.5,  max: 60};
const _LIVE_WEAR_VALID = {min: 0.05, max: 15};

function _validRate(v, range) {
    return (typeof v === 'number' && isFinite(v) && v >= range.min && v <= range.max) ? v : null;
}

/* Comme _windowedLapAvg, mais ne garde que les tours aux valeurs plausibles ;
   null s'il y en a moins de minLaps. */
function _validLapAvg(laps, n, key, range, minLaps) {
    if (!Array.isArray(laps) || laps.length === 0) return null;
    const vals = laps.slice(-n).map(l => l && l[key]).filter(v => _validRate(v, range) != null);
    if (vals.length < (minLaps || 1)) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function _resolveLiveRate(measured, sharedMem, circuitDb) {
    if (measured  != null) return {value: measured,  source: 'live'};
    if (sharedMem != null) return {value: sharedMem, source: 'mémoire partagée'};
    if (circuitDb != null) return {value: circuitDb, source: 'base circuit'};
    return {value: null, source: null};
}

const _LIVE_NO_DATA_MSG = 'roulez quelques tours pour lancer les calculs';

/* ────────────────────────────────────────────────────────────
   🧠 MÉMOIRE D'USURE MESURÉE (par session, côté et composé)
   { left: { hard: { l12: 1.72, l13: 1.69, … } }, right: {…} }
   Un tour valide (usure/tour plausible) est enregistré sous le composé monté
   au moment de sa réception. Synchronisée via Firebase (session) : tous les
   utilisateurs de la session partagent les mêmes valeurs ; elle sert à calculer
   la vraie durée de vie des gommes des stints futurs.
   ──────────────────────────────────────────────────────────── */
window._measuredWear = window._measuredWear || {};
const _MW_KEEP_LAPS = 30;   // tours conservés par côté et composé

function _mwLaps(side, compound) {
    const box = window._measuredWear?.[side]?.[compound];
    if (!box) return [];
    return Object.keys(box).map(k => ({n: parseInt(k.slice(1)), v: box[k]}))
        .filter(e => isFinite(e.n) && typeof e.v === 'number').sort((a, b) => a.n - b.n);
}

/* Moyenne mémorisée (fenêtre 3 / 5 / 10 tours) ; null si moins de 3 tours mesurés. */
function _mwAvg(side, compound) {
    const win = Math.max(parseInt(document.getElementById('liveWearAvgWindow')?.value) || 5, 3);
    const laps = _mwLaps(side, compound).slice(-win);
    if (laps.length < 3) return null;
    return laps.reduce((a, e) => a + e.v, 0) / laps.length;
}

/* Enregistre les tours valides du relais en cours sous le composé monté. */
function _mwIngest(laps) {
    if (!Array.isArray(laps) || laps.length === 0) return;
    let changed = false;
    [['left', 'Left', 'wearLeftDelta'], ['right', 'Right', 'wearRightDelta']].forEach(([side, S, key]) => {
        const compound = document.getElementById(`liveTyreCompound${S}`)?.value;
        if (!compound || compound === 'none') return;
        // Relais en cours : après le dernier tour à delta négatif (= nouvelles gommes montées)
        let start = 0;
        for (let i = laps.length - 1; i >= 0; i--) {
            if (laps[i] && typeof laps[i][key] === 'number' && laps[i][key] < 0) { start = i + 1; break; }
        }
        const sideBox = (window._measuredWear[side] = window._measuredWear[side] || {});
        const box = (sideBox[compound] = sideBox[compound] || {});
        for (let i = start; i < laps.length; i++) {
            const l = laps[i];
            const v = _validRate(l && l[key], _LIVE_WEAR_VALID);
            if (v == null || l.num == null) continue;
            const k = 'l' + l.num;
            if (box[k] === undefined) { box[k] = Math.round(v * 1000) / 1000; changed = true; }
        }
        const ks = Object.keys(box);
        if (ks.length > _MW_KEEP_LAPS) {
            ks.sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)))
              .slice(0, ks.length - _MW_KEEP_LAPS).forEach(k => delete box[k]);
        }
    });
    if (changed) {
        _mwRenderRecap();
        // Seule la page qui reçoit directement la télémétrie écrit dans Firebase
        if (!(typeof liveRemoteReadOnly === 'function' && liveRemoteReadOnly())) {
            try { _dirtyFields.add('_measuredWear'); pushToFirebase(false); } catch (e) { /* hors session */ }
        }
    }
}

/* Reprise depuis Firebase : propre à la session (réinitialisée si on change de session). */
function _mwRestore(remote) {
    const sid = (typeof _sessionId !== 'undefined') ? _sessionId : null;
    if (window._mwSid !== sid) { window._measuredWear = {}; window._mwSid = sid; }
    if (remote && typeof remote === 'object') {
        ['left', 'right'].forEach(side => {
            Object.keys(remote[side] || {}).forEach(c => {
                const sideBox = (window._measuredWear[side] = window._measuredWear[side] || {});
                const box = (sideBox[c] = sideBox[c] || {});
                const src = remote[side][c] || {};
                Object.keys(src).forEach(k => { if (box[k] === undefined && typeof src[k] === 'number') box[k] = src[k]; });
            });
        });
    }
    _mwRenderRecap();
}

/* Petit récap à droite du bloc « Pneus actuels » */
function _mwRenderRecap() {
    const el = document.getElementById('liveMeasuredWearRecap');
    if (!el) return;
    const names = {soft: '⚪ Soft', medium: '🟡 Med', hard: '🔴 Hard', wet: '🔵 Wet'};
    const rows = [];
    ['soft', 'medium', 'hard', 'wet'].forEach(c => {
        const l = _mwAvg('left', c), r = _mwAvg('right', c);
        const nl = _mwLaps('left', c).length, nr = _mwLaps('right', c).length;
        if (l == null && r == null) {
            if (nl || nr) rows.push(`<div style="color:var(--text-4);">${names[c]} · ${Math.max(nl, nr)}/3 tours…</div>`);
            return;
        }
        rows.push(`<div><b>${names[c]}</b> · <span style="color:#88ccff;">G ${l != null ? l.toFixed(3) : '—'}</span>`
            + ` · <span style="color:#ffaa66;">D ${r != null ? r.toFixed(3) : '—'}</span>`
            + ` <span style="color:var(--text-4);">%/t (${Math.max(nl, nr)} t)</span></div>`);
    });
    el.innerHTML = rows.length ? rows.join('')
        : '<div style="color:var(--text-4);font-style:italic;">roulez 3 tours minimum</div>';
}


/* Affiche la valeur retenue (avec sa source si ce n'est pas la mesure live) ou
   le message d'attente quand aucune source n'est disponible. */
function _setRateStatus(elOrId, res, decimals) {
    const el = typeof elOrId === 'string' ? document.getElementById(elOrId) : elOrId;
    if (!el) return;
    if (res.value == null) {
        el.textContent = _LIVE_NO_DATA_MSG;
        el.style.color = '#ffaa00';
        return;
    }
    el.style.color = '';
    const src = res.source === 'live' ? '' : ` (${res.source})`;
    // Le champ EV n'a qu'un libellé de source ; les spans d'usure affichent aussi la valeur
    el.textContent = decimals ? `${res.value.toFixed(decimals)}%/tour${src}` : src.trim();
}

// Données complètes, 1 fois/s en local (2 fois/s à distance). Les jauges
// instantanées sont en plus rafraîchies 20 fois/s par _liveGaugesPollOnce().
async function _liveStatsPollOnce() {
    if (!window._liveStats.active) return;
    // Une requête encore en vol ne doit pas en empiler une nouvelle :
    // on saute simplement ce tick plutôt que d'accumuler des fetch concurrents.
    if (window._liveStats.inFlight) return;
    window._liveStats.inFlight = true;
    try {
        const remote = !!(window._liveRemote && window._liveRemote.active);
        let data;
        if (remote) {
            data = remoteStatsData();
            // Donnée identique à la précédente (le pilote publie 2 fois/s) : rien à retraiter.
            if (data.connected && data._ver === window._liveStats.lastRemoteVer) return;
            window._liveStats.lastRemoteVer = data._ver;
        } else {
            const resp = await fetch(window._liveStats.url, {cache: 'no-store'});
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            data = await resp.json();
        }
        if (!data.connected) return; // en attente du jeu — rien à mettre à jour pour l'instant

        window._liveTrackName   = data.trackName   || window._liveTrackName   || null;
        window._liveVehicleName = data.vehicleName || window._liveVehicleName || null;

        _updateLiveTelemetryExtras(data);
        window._liveStats.tickCount = (window._liveStats.tickCount || 0) + 1;

        const recentLaps = Array.isArray(data.recentLaps) ? data.recentLaps : [];
        const lapWindow   = parseInt(document.getElementById('liveLapTimeAvgWindow')?.value) || 5;
        const evWindow    = parseInt(document.getElementById('liveEvAvgWindow')?.value)      || 5;
        const wearWindow  = parseInt(document.getElementById('liveWearAvgWindow')?.value)    || 5;

        const avgLapTime   = _windowedLapAvg(recentLaps, lapWindow,  'lapTime');

        // Conso EV/tour et delta d'usure G/D par tour : chaîne de repli
        //   1. moyenne mesurée sur la fenêtre choisie (tours valides uniquement)
        //   2. valeurs de la mémoire partagée (moyenne sur tous les tours valides)
        //   3. base circuits (circuit + voiture détectés par le jeu)
        //   4. rien -> message "roulez quelques tours…"
        const allLaps = Array.isArray(data.allLaps) ? data.allLaps : recentLaps;
        const carDb   = typeof _getLiveCircuitCarData === 'function' ? _getLiveCircuitCarData() : null;

        const evRes = _resolveLiveRate(
            _validLapAvg(recentLaps, evWindow, 'vePctUsed', _LIVE_EV_VALID),
            _validLapAvg(allLaps, allLaps.length, 'vePctUsed', _LIVE_EV_VALID) ?? _validRate(data.avgVePerLapLast10, _LIVE_EV_VALID),
            _validRate(carDb?.evPerLap, _LIVE_EV_VALID));

        const wearRes = {};
        [['left', 'Left', 'wearLeftDelta'], ['right', 'Right', 'wearRightDelta']].forEach(([side, S, key]) => {
            const compound = document.getElementById(`liveTyreCompound${S}`)?.value;
            const corners  = side === 'left' ? ['FL', 'RL'] : ['FR', 'RR'];
            const dbWear   = (compound && compound !== 'none' && carDb?.tyres && typeof _getLiveCircuitDbWear === 'function')
                ? _validRate(_getLiveCircuitDbWear(corners, compound), _LIVE_WEAR_VALID) : null;
            // Minimum 3 tours valides pour la mesure live : en dessous, trop bruité
            wearRes[side] = _resolveLiveRate(
                _validLapAvg(recentLaps, Math.max(wearWindow, 3), key, _LIVE_WEAR_VALID, 3),
                _validLapAvg(allLaps, allLaps.length, key, _LIVE_WEAR_VALID, 1),
                dbWear);
        });
        const avgVePerLap = evRes.value;

        // Mémorise l'usure mesurée par côté / composé (partagée dans la session)
        _mwIngest(allLaps);

        // Exposé pour _updateLiveTyreWearLabels() (tyres-wear.js)
        window._liveMeasuredWearPerLap = {
            left:  wearRes.left.value,
            right: wearRes.right.value,
        };
        // Source de la valeur ('live' | 'mémoire partagée' | 'base circuit' | null)
        window._liveMeasuredWearSource = { left: wearRes.left.source, right: wearRes.right.source };

        // Horloge ingame ACTUELLE, lue en direct (secondes depuis minuit, heure du
        // jeu) — ancre l'axe "Ingame" de la timeline live sur la vraie horloge du
        // jeu plutôt que sur une heure de départ ingame saisie à la main.
        if (data.gameClockSec != null) window._liveGameClockNow = data.gameClockSec;

        const notEditing = el => el && document.activeElement !== el;

        // ── Durée de séance restante ──
        // Priorité à la valeur brute du jeu (data.sessionTimeRemainingSec, lue dans
        // la shared memory) : elle est fiable quel que soit le type de séance en
        // cours (essais, qualifs, warmup, course) et colle exactement au compteur
        // affiché à l'écran en jeu. L'ancien calcul (heure de départ + durée de
        // course saisies à la main en Planification) ne décrit QUE la course prévue
        // — il n'a aucun sens pendant des essais/qualifs et n'est gardé qu'en repli
        // si jamais le jeu ne renvoie pas cette donnée.
        const durEl = document.getElementById('liveRaceDurationRemaining');
        // Le jeu renvoie ponctuellement 0 entre deux lectures valides : on ignore
        // ces valeurs (sinon l'affichage clignote entre le vrai temps et 00:00:00)
        // et on garde la dernière valeur valide.
        if (data.sessionTimeRemainingSec != null && !isNaN(data.sessionTimeRemainingSec)
            && data.sessionTimeRemainingSec <= 0 && window._liveSessionTimeRemainingSec > 0) {
            // lecture parasite : ne rien changer
        } else if (data.sessionTimeRemainingSec != null && !isNaN(data.sessionTimeRemainingSec)) {
            const remaining = Math.max(0, data.sessionTimeRemainingSec);
            // Exposé pour recalculateLive() (live-mode.js) : le calcul du nombre de
            // stints/tours restants doit utiliser CETTE valeur (celle affichée ici),
            // pas l'heure de départ/durée de course saisies à la main en
            // Planification, qui ne décrit qu'une course planifiée et dérive dès
            // qu'on est en direct sur une séance réelle (retard au départ, essais,
            // qualifs…) — voir window._liveSessionTimeRemainingSec dans live-mode.js.
            window._liveSessionTimeRemainingSec = remaining;
            if (durEl) {
                const fmt = typeof formatDuration === 'function' ? formatDuration(remaining) : `${remaining}s`;
                durEl.textContent = data.sessionType ? `${fmt} (${data.sessionType})` : fmt;
            }
        } else {
            window._liveSessionTimeRemainingSec = undefined;
            if (durEl && typeof getRealStart === 'function' && typeof getRaceTimeInSeconds === 'function') {
                const realStart    = getRealStart();
                const totalRaceSec = getRaceTimeInSeconds();
                const raceEndSec   = realStart + totalRaceSec;
                const now = new Date();
                let nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
                if (raceEndSec > 86400 && nowSec < realStart && nowSec < 43200) nowSec += 86400;
                const remaining = Math.max(0, raceEndSec - nowSec);
                durEl.textContent = typeof formatDuration === 'function' ? formatDuration(remaining) : `${remaining}s`;
            }
        }

        // ── EV actuelle (%) ──
        const evInput = document.getElementById('evCurrent');
        if (notEditing(evInput) && data.veCurrentPct != null) evInput.value = data.veCurrentPct.toFixed(1);

        // ── Tours réalisés ──
        const lapsInput = document.getElementById('liveLapsCompleted');
        if (notEditing(lapsInput) && data.lapsCompleted != null) lapsInput.value = data.lapsCompleted;

        // ── Temps au tour réel (moyenne sur la fenêtre choisie) ──
        if (avgLapTime != null) {
            const t = _fmtLapTimeToFields(avgLapTime);
            const mEl = document.getElementById('livelapMinutes');
            const sEl = document.getElementById('livelapSeconds');
            const dEl = document.getElementById('livelapMillis');
            if (t && notEditing(mEl)) mEl.value = t.m;
            if (t && notEditing(sEl)) sEl.value = t.s;
            if (t && notEditing(dEl)) dEl.value = t.d;
        }

        // ── Conso EV réelle/tour (moyenne sur la fenêtre choisie) ──
        const evPerLapInput = document.getElementById('evPerLapReal');
        if (notEditing(evPerLapInput) && avgVePerLap != null) evPerLapInput.value = avgVePerLap.toFixed(2);
        _setRateStatus('liveEvPerLapMsg', evRes);

        // ── Gommes montées, détectées automatiquement ──
        const cmpdL = document.getElementById('liveTyreCompoundLeft');
        const cmpdR = document.getElementById('liveTyreCompoundRight');
        if (notEditing(cmpdL) && data.leftCompound)  cmpdL.value = data.leftCompound;
        if (notEditing(cmpdR) && data.rightCompound) cmpdR.value = data.rightCompound;

        // ── Vie restante des pneus actuels (%) ──
        const wearLInput = document.getElementById('liveTyreWearLeft');
        const wearRInput = document.getElementById('liveTyreWearRight');
        if (notEditing(wearLInput) && data.tyreLifeLeft  != null) wearLInput.value = data.tyreLifeLeft.toFixed(1);
        if (notEditing(wearRInput) && data.tyreLifeRight != null) wearRInput.value = data.tyreLifeRight.toFixed(1);

        // ── Delta d'usure par tour G/D (affichage informatif) ──
        const deltaLEl = document.getElementById('liveWearDeltaLeft');
        const deltaREl = document.getElementById('liveWearDeltaRight');
        _setRateStatus(deltaLEl, wearRes.left,  3);
        _setRateStatus(deltaREl, wearRes.right, 3);

        // ── Stock de pneus restant ──
        // Champ #liveTyreBudget : saisie 100 % manuelle (aucun calcul automatique), partagé via Firebase.

        if (typeof _updateLiveTyreWearLabels === 'function') _updateLiveTyreWearLabels();

        // Classement + courbes : 1 fois par seconde suffit (reconstruction coûteuse)
        const _heavyNow = Date.now();
        if (_heavyNow - (window._liveStats.lastStandingsMs || 0) >= 900) {
            window._liveStats.lastStandingsMs = _heavyNow;
            _updateLiveStandingsAndCharts(data);
        }

        // ── Recalcule la table des stints à partir de toutes ces données live ──
        // silent=true : un poll automatique ne doit jamais bloquer l'UI avec un
        // alert() (ex: pas encore de tour terminé donc conso EV/tour indisponible) —
        // voir recalculateLive() dans live-mode.js.
        // Throttlé : la table, la frise et le récap sont reconstruits de zéro (innerHTML)
        // à chaque recalcul ; à 5Hz la page entière se redessinait en permanence
        // (tremblements, scroll qui saute). Une fois toutes les 2s suffit largement.
        const _nowMs = Date.now();
        if (typeof recalculateLive === 'function' && _nowMs - (window._liveStats.lastRecalcMs || 0) >= 1900) {
            window._liveStats.lastRecalcMs = _nowMs;
            recalculateLive(true);
        }

    } catch (e) {
        window._liveStats.lastError = e;
    } finally {
        window._liveStats.inFlight = false;
    }
}

/* ── Panneaux "Télémétrie détaillée" (après la table des stints live) ──
   Purement informatif : ne déclenche aucun recalcul, ne touche à aucun
   champ de saisie. Toutes les clés lues ici viennent directement de la
   mémoire partagée du jeu, voir _handle_live() dans
   collector/lmu_telemetry_logger.py. */
function _setText(id, value, suffix) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = (value == null || isNaN(value)) ? '—' : `${value}${suffix || ''}`;
}

const _GEAR_LABELS = { '-1': 'R', '0': 'N' };

function _updateLiveTelemetryExtras(data) {
    // Vitesse & moteur
    _setText('liveSpeedKmh', data.speedKmh, ' km/h');
    const gearEl = document.getElementById('liveGear');
    if (gearEl) gearEl.textContent = data.gear != null ? (_GEAR_LABELS[String(data.gear)] || String(data.gear)) : '—';
    _setText('liveRpm', data.engineRpm, ' tr/min');
    _setText('liveWaterTemp', data.engineWaterTemp, ' °C');
    _setText('liveOilTemp', data.engineOilTemp, ' °C');

    // Commandes pilote (barres)
    [['liveThrottle', data.throttlePct], ['liveBrake', data.brakePct]].forEach(([id, pct]) => {
        const bar = document.getElementById(id + 'Bar');
        const val = document.getElementById(id + 'Val');
        const p = Math.max(0, Math.min(100, pct ?? 0));
        if (bar) bar.style.width = `${p}%`;
        if (val) val.textContent = pct != null ? `${p.toFixed(0)}%` : '—%';
    });
    // Direction : -100%(gauche) .. +100%(droite) -> barre centrée
    const steerBar = document.getElementById('liveSteeringBar');
    const steerVal = document.getElementById('liveSteeringVal');
    if (data.steeringPct != null) {
        const s = Math.max(-100, Math.min(100, data.steeringPct));
        if (steerBar) {
            steerBar.style.width = `${Math.abs(s) / 2}%`;
            steerBar.style.marginLeft = s < 0 ? `${50 + s / 2}%` : '50%';
        }
        if (steerVal) steerVal.textContent = `${s.toFixed(0)}%`;
    } else if (steerVal) {
        steerVal.textContent = '—%';
    }

    // Carburant
    _setText('liveFuelLiters', data.fuelLiters, ' L');
    _setText('liveFuelCapacity', data.fuelCapacityLiters, ' L');
    const ratioEl = document.getElementById('liveFuelEvRatio');
    if (ratioEl) {
        ratioEl.textContent = (data.fuelLiters != null && data.veCurrentPct)
            ? (data.fuelLiters / data.veCurrentPct).toFixed(3)
            : '—';
    }

    // Piste & météo
    _setText('liveAmbientTemp', data.ambientTemp, ' °C');
    _setText('liveTrackTemp', data.trackTemp, ' °C');
    _setText('liveMapAmbientTemp', data.ambientTemp, ' °C');
    _setText('liveMapTrackTemp', data.trackTemp, ' °C');
    _setText('liveRainingPct', data.rainingPct, '%');
    _setText('liveTrackWetnessPct', data.trackWetnessPct, '%');
    _setText('liveMapRainPct', data.rainingPct, '%');
    _setText('liveMapWetnessPct', data.trackWetnessPct, '%');

    // Heure ingame (secondes depuis minuit, heure du jeu)
    const clockEl = document.getElementById('liveMapGameClock');
    if (clockEl) clockEl.textContent = data.gameClockSec != null && typeof formatClock === 'function'
        ? formatClock(data.gameClockSec) : '—';

    // Pneus / freins / pressions par coin
    ['FL', 'FR', 'RL', 'RR'].forEach(c => {
        _setText(`liveTyreTemp${c}`, data.tyreTemps?.[c], '°C');
        _setText(`liveTyrePress${c}`, data.tyrePressures?.[c], '');
        _setText(`liveBrakeTemp${c}`, data.brakeTemps?.[c], '°C');
    });
}

/* Classement (table + courbes) : plus coûteux à reconstruire (innerHTML de
   toute la grille, redessin canvas) que les jauges instantanées ci-dessus —
   au plus 1 fois/s, et seulement pour ce qui est à l'écran (_liveIsOnScreen). */
function _updateLiveStandingsAndCharts(data) {
    // Ordre de course (Pilotes proches / Grille complète)
    window._liveStandingsFull = Array.isArray(data.standings) ? data.standings : [];
    if (_liveIsOnScreen(document.getElementById('liveNearbyDrivers'))) _renderLiveStandings();

    // Classement de la catégorie du joueur, à côté de la carte live
    window._livePlayerRecentLaps = Array.isArray(data.recentLaps) ? data.recentLaps : [];
    _liveTrackCarLaps(window._liveStandingsFull);
    if (_liveIsOnScreen(document.getElementById('liveMapClassStandings'))) _renderLiveMapClassStandings();

    // Courbes d'évolution par tour + trace accélérateur/frein
    _updateLiveCharts(data);
}

/* ── Panneau "Ordre de course" : toggle "Proches" (±6 autour du joueur) /
   "Grille complète" (tous les pilotes), avec écart signé au joueur, EV,
   gommes G/D et conso EV moyenne sur 5 tours. ── */
const _LIVE_STANDINGS_WINDOW = 6; // pilotes affichés devant/derrière en mode "Proches"

function setLiveStandingsMode(mode) {
    window._liveStandingsMode = mode === 'full' ? 'full' : 'nearby';
    // Le changement de mode est volontaire : on relâche les tailles mémorisées
    const _tb = document.getElementById('liveNearbyDrivers');
    const _wrap = _tb?.closest('table')?.parentElement;
    if (_wrap) { _wrap._maxH = 0; _wrap.style.minHeight = ''; }
    _tb?.closest('table')?.querySelectorAll('thead th').forEach(th => { th._maxW = 0; th.style.minWidth = ''; });
    const nearbyBtn = document.getElementById('liveStandingsModeNearbyBtn');
    const fullBtn = document.getElementById('liveStandingsModeFullBtn');
    const hint = document.getElementById('liveStandingsModeHint');
    const isFull = window._liveStandingsMode === 'full';
    if (nearbyBtn) {
        nearbyBtn.style.background = isFull ? 'transparent' : 'rgba(255,136,0,0.18)';
        nearbyBtn.style.borderColor = isFull ? 'rgba(var(--fg-rgb),0.2)' : '#ff8800';
        nearbyBtn.style.color = isFull ? 'var(--text-3)' : '#ff8800';
    }
    if (fullBtn) {
        fullBtn.style.background = isFull ? 'rgba(255,136,0,0.18)' : 'transparent';
        fullBtn.style.borderColor = isFull ? '#ff8800' : 'rgba(var(--fg-rgb),0.2)';
        fullBtn.style.color = isFull ? '#ff8800' : 'var(--text-3)';
    }
    if (hint) hint.textContent = isFull ? '' : `Jusqu'à ${_LIVE_STANDINGS_WINDOW} devant · ${_LIVE_STANDINGS_WINDOW} derrière`;
    _renderLiveStandings();
}

function _liveCompoundBadge(compound) {
    if (!compound) return '<span style="color:#555;">—</span>';
    const colors = {
        soft:   {bg: 'rgba(220,220,220,0.15)',fg: '#dddddd', letter: 'S'},
        medium: {bg: 'rgba(255,200,0,0.2)',   fg: '#ffcc00', letter: 'M'},
        hard:   {bg: 'rgba(255,60,60,0.25)',  fg: '#ff6060', letter: 'H'},
        wet:    {bg: 'rgba(51,153,255,0.2)',  fg: '#3399ff', letter: 'W'},
    };
    const c = colors[compound] || {bg: 'rgba(255,255,255,0.1)', fg: '#aaa', letter: '?'};
    return `<span style="display:inline-block;min-width:16px;padding:1px 4px;border-radius:4px;background:${c.bg};color:${c.fg};font-size:0.78em;font-weight:bold;text-align:center;">${c.letter}</span>`;
}

/* Couleur stable par catégorie (classe de véhicule), pour les en-têtes de
   groupe en "Grille complète", le badge de catégorie en "Proches" ET les
   marqueurs de la carte live (_liveMapDraw) — une seule source de vérité pour
   que les deux panneaux restent cohérents. Couleurs figées par nom de
   catégorie (le jeu envoie p. ex. "Hyper", "GT3", "LMP2") : elles ne
   dépendent pas de l'ordre d'arrivée des voitures, donc ne changent pas d'une
   connexion à l'autre. Une catégorie inconnue prend une couleur tirée de son
   nom (toujours la même pour le même nom).
*/
function _liveClassColor(vclass) {
    const c = (vclass || '').toLowerCase();
    if (c.includes('hyper') || c.includes('lmh') || c.includes('lmdh') || c.includes('gtp')) return '#ff3344';
    if (c.includes('gt3')) return '#00ff88';
    if (c.includes('lmp2')) return '#00aaff';
    if (c.includes('lmp3')) return '#aa00ff';
    if (c.includes('gte')) return '#ffaa00';
    const palette = ['#ffee00', '#ff66cc', '#66ffee', '#ff8844'];
    let h = 0;
    for (const ch of c) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return palette[h % palette.length];
}

/* Stints restants d'une voiture adverse, même logique que le récapitulatif du
   joueur (recalculateLive) : fraction du stint en cours (EV actuelle / conso
   moyenne, plafonnée par le temps restant) + nombre entier de stints futurs
   (recharge pleine, pit déduit du temps restant). Dérivé de la conso EV et du
   temps au tour moyens sur 5 tours de la voiture ; null si données absentes. */
function _liveCarStintsRemaining(d) {
    const evPerLap = d.avgVePerLapLast5, lapTime = d.avgLapTimeLast5, ve = d.veCurrentPct;
    const evRefuel = parseFloat(document.getElementById('evRefuelPerStint')?.value);
    const raceSec = window._liveSessionTimeRemainingSec;
    if (!(evPerLap > 0) || !(lapTime > 0) || ve == null || !(evRefuel > 0)
        || raceSec == null || isNaN(raceSec)) return null;

    const toursParStint = evRefuel / evPerLap;
    const toursStintCourant = Math.min(ve / evPerLap, raceSec / lapTime);
    let tempsRestant = raceSec - toursStintCourant * lapTime - getPitDuration(0);
    let stintsFuturs = 0;
    let idx = 1;
    while (tempsRestant > lapTime * 0.1 && idx < 60) {
        stintsFuturs++;
        const dureeIci = toursParStint * lapTime;
        if (dureeIci >= tempsRestant - 0.1) break;
        tempsRestant -= dureeIci + getPitDuration(idx);
        idx++;
    }
    return toursStintCourant / toursParStint + stintsFuturs;
}

function _liveStandingsRowHtml(d, posLabel, opts) {
    const esc = _teamTelemetryEscapeHtml || (s => s);
    const name = esc(d.driver || d.vehicle || '—');
    let gap = '—';
    let gapColor = '#aaa';
    if (d.isPlayer) {
        gap = '—';
    } else if (d.gapToPlayer != null) {
        gap = `${d.gapToPlayer > 0 ? '+' : ''}${d.gapToPlayer.toFixed(1)}s`;
        gapColor = d.gapToPlayer > 0 ? '#ffaa66' : '#88ccff';
    }
    const lap = d.lap != null ? d.lap : '—';
    const ve = d.veCurrentPct != null ? `${d.veCurrentPct.toFixed(1)}%` : '—';
    const veAvg = d.avgVePerLapLast5 != null ? `${d.avgVePerLapLast5.toFixed(2)}%` : '—';
    const avgLap = d.avgLapTimeLast5 != null ? _fmtSecondsShort(d.avgLapTimeLast5) : '—';
    let stints = null;
    if (d.isPlayer) {
        const v = parseFloat(document.getElementById('liveStintsRestants')?.textContent);
        stints = isNaN(v) ? null : v;
    }
    if (stints == null) stints = _liveCarStintsRemaining(d);
    const stintsTxt = stints != null ? stints.toFixed(1) : '—';
    const rowStyle = d.isPlayer ? 'background:rgba(var(--accent-rgb),0.12);' : '';
    const classBadge = (opts && opts.showClassBadge && d.vclass)
        ? `<span style="display:inline-block;margin-right:5px;padding:0 4px;border-radius:3px;
               border:1px solid ${_liveClassColor(d.vclass)};color:${_liveClassColor(d.vclass)};
               font-size:0.72em;font-weight:bold;vertical-align:middle;">${esc(d.vclass)}</span>`
        : '';
    return `<tr style="${rowStyle}border-bottom:1px solid rgba(var(--fg-rgb),0.06);">
        <td style="padding:3px 6px;color:var(--text-3);">${posLabel}</td>
        <td style="padding:3px 6px;color:var(--text);text-align:left;">${classBadge}${name}${d.isPlayer ? ' ⭐' : ''}${d.inPits ? ' 🔧' : ''}</td>
        <td style="padding:3px 6px;text-align:right;color:${gapColor};">${gap}</td>
        <td style="padding:3px 6px;text-align:right;color:var(--text-3);">${lap}</td>
        <td style="padding:3px 6px;text-align:right;color:var(--text);">${ve}</td>
        <td style="padding:3px 6px;text-align:right;color:var(--text-3);">${veAvg}</td>
        <td style="padding:3px 6px;text-align:right;color:var(--text-3);">${avgLap}</td>
        <td style="padding:3px 6px;text-align:right;color:var(--text);">${stintsTxt}</td>
        <td style="padding:3px 6px;text-align:center;"><span style="display:inline-flex;gap:3px;align-items:center;justify-content:center;">${_liveCompoundBadge(d.leftCompound)}${_liveCompoundBadge(d.rightCompound)}</span></td>
    </tr>`;
}

function _liveStandingsClassHeaderHtml(vclass, count) {
    const esc = _teamTelemetryEscapeHtml || (s => s);
    return `<tr><td colspan="9" style="padding:8px 6px 4px;border-top:1px solid rgba(var(--fg-rgb),0.12);
        color:${_liveClassColor(vclass)};font-weight:bold;font-size:0.85em;letter-spacing:0.5px;">
        ${esc(vclass)} <span style="color:var(--text-4);font-weight:normal;">(${count})</span>
    </td></tr>`;
}

function _renderLiveStandings() {
    const el = document.getElementById('liveNearbyDrivers');
    if (!el) return;
    const full = window._liveStandingsFull || [];
    if (full.length === 0) {
        el.innerHTML = '<tr><td colspan="9" style="color:var(--text-4);padding:6px;white-space:normal;">En attente de télémétrie live.</td></tr>';
        return;
    }
    const mode = window._liveStandingsMode || 'nearby';

    if (mode === 'full') {
        // Grille complète : regroupée par catégorie (Hypercar/LMP2/LMGT3…),
        // chaque groupe trié selon l'ordre de course déjà renvoyé par le
        // serveur (position officielle), avec un rang PROPRE À LA CATÉGORIE
        // (P1, P2… de la classe) plutôt que la position toutes classes
        // confondues, qui n'a pas de sens pour comparer des voitures qui ne
        // courent pas la même course.
        const groups = [];
        const byClass = new Map();
        full.forEach(d => {
            const key = d.vclass || 'Non classé';
            if (!byClass.has(key)) {
                const g = {vclass: key, cars: []};
                byClass.set(key, g);
                groups.push(g);
            }
            byClass.get(key).cars.push(d);
        });
        _setHtmlIfChanged(el, groups.map(g => {
            const header = _liveStandingsClassHeaderHtml(g.vclass, g.cars.length);
            const rows = g.cars.map((d, i) => _liveStandingsRowHtml(d, `P${i + 1}`)).join('');
            return header + rows;
        }).join(''));
        return;
    }

    // Proches : fenêtre de positions autour du joueur, toutes catégories
    // mélangées (c'est le but — voir le trafic réel autour de soi sur la
    // piste) ; un badge de catégorie par ligne garde le contexte classe.
    let list = full;
    const myIdx = full.findIndex(d => d.isPlayer);
    if (myIdx !== -1) {
        list = full.slice(Math.max(0, myIdx - _LIVE_STANDINGS_WINDOW), myIdx + _LIVE_STANDINGS_WINDOW + 1);
    }
    _setHtmlIfChanged(el, list.map(d => _liveStandingsRowHtml(d, `P${d.place ?? '—'}`, {showClassBadge: true})).join(''));
}

/* ── Classement de la catégorie du joueur, affiché à côté de la carte live ──
   Même liste que "Grille complète" (window._liveStandingsFull), mais filtrée
   sur la classe du joueur et enrichie de 3 colonnes "delta par tour" : pour
   chacun des 3 derniers tours de CHAQUE voiture (d.lastLaps, voir
   snapshot_live() dans collector/lmu_telemetry_logger.py), on prend le tour de
   même rang chez le joueur (son dernier face au dernier du joueur, etc.), quel
   que soit le numéro du tour : une voiture avec un tour d'avance ou de retard
   est comparée quand même. Rouge = la voiture est plus rapide que vous sur ce
   tour, vert = plus lente. */
function _liveDeltaCellHtml(carLap, pl) {
    const empty = '<td style="padding:3px 4px;text-align:right;color:var(--text-4);">—</td>';
    if (!carLap || carLap.lapTime == null) return empty;
    if (!pl || pl.lapTime == null) return empty;
    const delta = carLap.lapTime - pl.lapTime;
    const color = delta < -0.05 ? '#ff6666' : (delta > 0.05 ? '#66ff99' : 'var(--text-3)');
    const txt = `${delta > 0 ? '+' : ''}${delta.toFixed(1)}`;
    return `<td style="padding:3px 4px;text-align:right;color:${color};">${txt}</td>`;
}

/* Secours quand le classement reçu n'a pas de d.lastLaps (connecteur antérieur
   en mode à distance) : on reconstruit les 3 derniers tours de chaque voiture
   en notant d.lastLapTime à chaque fois que son compteur de tours (d.lap)
   avance. */
window._liveCarLapHist = new Map();
function _liveTrackCarLaps(standings) {
    const hist = window._liveCarLapHist;
    (standings || []).forEach(d => {
        if (d.id == null || d.lap == null) return;
        const h = hist.get(d.id);
        if (!h || d.lap < h.lap) { hist.set(d.id, {lap: d.lap, laps: []}); return; }
        if (d.lap > h.lap) {
            if (d.lastLapTime > 0) {
                h.laps.push({num: d.lap, lapTime: d.lastLapTime});
                if (h.laps.length > 5) h.laps.shift();
            }
            h.lap = d.lap;
        }
    });
}

function _liveClassStandingsRowHtml(d, posLabel, playerLast3) {
    const esc = _teamTelemetryEscapeHtml || (s => s);
    const name = esc(d.driver || d.vehicle || '—');
    let gap = '—', gapColor = '#aaa';
    if (!d.isPlayer && d.gapToPlayer != null) {
        gap = `${d.gapToPlayer > 0 ? '+' : ''}${d.gapToPlayer.toFixed(1)}s`;
        gapColor = d.gapToPlayer > 0 ? '#ffaa66' : '#88ccff';
    }
    const ve = d.veCurrentPct != null ? `${d.veCurrentPct.toFixed(0)}%` : '—';
    let stints = null;
    if (d.isPlayer) {
        const v = parseFloat(document.getElementById('liveStintsRestants')?.textContent);
        stints = isNaN(v) ? null : v;
    }
    if (stints == null) stints = _liveCarStintsRemaining(d);
    const stintsTxt = stints != null ? stints.toFixed(1) : '—';
    const rowStyle = d.isPlayer ? 'background:rgba(var(--accent-rgb),0.12);' : '';
    // 3 derniers tours connus, du plus ancien (T-2) au plus récent (Dernier) ;
    // complété à gauche par "—" si la voiture n'a pas encore bouclé 3 tours.
    // Sans d.lastLaps, on prend l'historique reconstruit par la page.
    const carLaps = Array.isArray(d.lastLaps) ? d.lastLaps : ((window._liveCarLapHist.get(d.id) || {}).laps || []);
    const last3 = carLaps.slice(-3);
    while (last3.length < 3) last3.unshift(null);
    const deltaCells = d.isPlayer
        ? '<td style="padding:3px 4px;text-align:right;color:var(--text-4);">—</td>'.repeat(3)
        : last3.map((l, i) => _liveDeltaCellHtml(l, playerLast3[i])).join('');
    return `<tr style="${rowStyle}border-bottom:1px solid rgba(var(--fg-rgb),0.06);">
        <td style="padding:3px 4px;color:var(--text-3);">${posLabel}</td>
        <td style="padding:3px 4px;color:var(--text);text-align:left;">${name}${d.isPlayer ? ' ⭐' : ''}${d.inPits ? ' 🔧' : ''}</td>
        <td style="padding:3px 4px;text-align:right;color:${gapColor};">${gap}</td>
        <td style="padding:3px 4px;text-align:right;color:var(--text-3);">${d.lap != null ? d.lap : '—'}</td>
        <td style="padding:3px 4px;text-align:center;"><span style="display:inline-flex;gap:3px;align-items:center;justify-content:center;">${_liveCompoundBadge(d.leftCompound)}${_liveCompoundBadge(d.rightCompound)}</span></td>
        <td style="padding:3px 4px;text-align:right;color:var(--text);">${ve}</td>
        <td style="padding:3px 4px;text-align:right;color:var(--text);">${stintsTxt}</td>
        <td style="padding:3px 4px;text-align:right;color:var(--text);">${d.lastLapTime != null ? _fmtSecondsShort(d.lastLapTime) : '—'}</td>
        <td style="padding:3px 4px;text-align:right;color:var(--text-3);">${d.avgLapTimeLast5 != null ? _fmtSecondsShort(d.avgLapTimeLast5) : '—'}</td>
        ${deltaCells}
    </tr>`;
}

function _renderLiveMapClassStandings() {
    const el = document.getElementById('liveMapClassStandings');
    if (!el) return;
    const full = window._liveStandingsFull || [];
    if (full.length === 0) return; // on laisse le message d'attente initial

    const player = full.find(d => d.isPlayer);
    const vclass = player ? player.vclass : null;
    const titleEl = document.getElementById('liveMapClassTitle');
    if (titleEl) titleEl.textContent = vclass ? `🏁 Classement ${vclass}` : '🏁 Classement catégorie';

    const group = vclass ? full.filter(d => d.vclass === vclass) : full;
    // 3 derniers tours du joueur (data.recentLaps), sinon ceux reconstruits par la page.
    let playerLaps = window._livePlayerRecentLaps || [];
    if (!playerLaps.length && player) playerLaps = (window._liveCarLapHist.get(player.id) || {}).laps || [];
    const playerLast3 = playerLaps.slice(-3);
    while (playerLast3.length < 3) playerLast3.unshift(null);

    const html = group.length
        ? group.map((d, i) => _liveClassStandingsRowHtml(d, `P${i + 1}`, playerLast3)).join('')
        : '<tr><td colspan="12" style="color:var(--text-4);padding:6px;white-space:normal;">En attente de télémétrie live.</td></tr>';
    _setHtmlIfChanged(el, html);
}

/* N'écrit dans le DOM que si le HTML a réellement changé : évite de détruire et
   recréer des nœuds (reflow, clignotement) quand rien n'a bougé. */
function _setHtmlIfChanged(el, html) {
    if (el._lastHtml === html) return;
    el._lastHtml = html;
    el.innerHTML = html;
    if (el.tagName === 'TBODY') {
        _ratchetTableColumns(el);
        const wrap = el.closest('table')?.parentElement;
        if (wrap) {
            const h = wrap.offsetHeight;
            if (h > (wrap._maxH || 0)) { wrap._maxH = h; wrap.style.minHeight = h + 'px'; }
        }
    }
}

/* Un tableau ou une légende dont le contenu change chaque seconde ne doit jamais
   rétrécir : on garde la plus grande largeur de colonne / hauteur de bloc vue, ce
   qui supprime les décalages de mise en page à chaque rafraîchissement. */
function _ratchetTableColumns(tbody) {
    const table = tbody.closest('table');
    if (!table) return;
    const ths = table.querySelectorAll('thead th');
    const row = Array.from(tbody.rows).find(r => r.cells.length === ths.length);
    if (!row) return;
    ths.forEach((th, i) => {
        const w = Math.max(th.offsetWidth, row.cells[i].offsetWidth);
        if (w > (th._maxW || 0)) { th._maxW = w; th.style.minWidth = w + 'px'; }
    });
}

function _setLegendHtml(el, html) {
    if (!el || el._lastHtml === html) return;
    el._lastHtml = html;
    el.innerHTML = html;
    const h = el.offsetHeight;
    if (h > (el._maxH || 0)) { el._maxH = h; el.style.minHeight = h + 'px'; }
}

/* ────────────────────────────────────────────────────────────
   📊 ANALYSE DE RELAIS — courbes d'évolution par tour (carburant/EV,
   usure pneus, temps au tour, températures) + trace accélérateur/
   frein vs distance parcourue. Canvas natif, pas de dépendance
   externe, même approche que _liveMapDraw() plus haut. Alimenté par
   data.allLaps / data.currentLapPartial / data.*LapTrace (voir
   _handle_live() dans collector/lmu_telemetry_logger.py).
   ──────────────────────────────────────────────────────────── */

function _fmtSecondsShort(totalSeconds) {
    if (totalSeconds == null || isNaN(totalSeconds)) return '—';
    const m = Math.floor(totalSeconds / 60);
    const s = (totalSeconds - m * 60).toFixed(1).padStart(4, '0');
    return `${m}:${s}`;
}

function _liveChartEmpty(canvas, legendEl, msg) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#666';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(msg || 'En attente de télémétrie live.', canvas.width / 2, canvas.height / 2);
    if (legendEl) legendEl.innerHTML = `<span style="color:var(--text-4);">${msg || 'En attente de télémétrie live.'}</span>`;
}

/* Construit les points {x:numéro de tour, y:valeur} d'une série à partir des
   tours terminés (allLaps) + un point "live" optionnel pour le tour en cours
   (currentLapPartial), marqué {live:true} pour un rendu distinct. `get` lit
   la même clé sur un tour terminé ET sur le partiel (mêmes noms de champs
   côté serveur), donc un champ absent du partiel (ex: lapTime, non calculable
   avant la ligne d'arrivée) est simplement ignoré sans erreur. */
function _lapNumPoints(allLaps, partial, get) {
    const pts = [];
    (allLaps || []).forEach(l => {
        const y = get(l);
        if (y != null && !isNaN(y)) pts.push({x: l.num, y});
    });
    if (partial && partial.lapNumber != null) {
        const y = get(partial);
        if (y != null && !isNaN(y)) pts.push({x: partial.lapNumber, y, live: true});
    }
    return pts;
}

/* Graphique multi-séries générique (axe X = numéro de tour), avec un axe Y
   gauche et, si une série porte axis:'R', un second axe Y droit. */
function _drawLiveLineChart(canvas, legendEl, series, opts) {
    if (!canvas) return;
    opts = opts || {};
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const allPoints = series.flatMap(s => s.points);
    if (allPoints.length === 0) { _liveChartEmpty(canvas, legendEl, opts.emptyText); return; }

    const hasRight = series.some(s => s.axis === 'R' && s.points.length);
    const padL = 42, padR = hasRight ? 42 : 14, padT = 10, padB = 20;

    const xs = allPoints.map(p => p.x);
    let xMin = Math.min(...xs), xMax = Math.max(...xs);
    if (xMin === xMax) { xMin -= 1; xMax += 1; }

    const calcRange = pts => {
        if (!pts.length) return null;
        let mn = Math.min(...pts.map(p => p.y)), mx = Math.max(...pts.map(p => p.y));
        if (mn === mx) { mn -= Math.abs(mn) * 0.1 || 1; mx += Math.abs(mx) * 0.1 || 1; }
        const pad = (mx - mn) * 0.12;
        return [mn - pad, mx + pad];
    };
    const leftRange = calcRange(series.filter(s => s.axis !== 'R').flatMap(s => s.points)) || [0, 1];
    const rightRange = calcRange(series.filter(s => s.axis === 'R').flatMap(s => s.points));
    const [yMinL, yMaxL] = leftRange;
    const [yMinR, yMaxR] = rightRange || [0, 1];

    const toX = x => padL + (x - xMin) / (xMax - xMin) * (W - padL - padR);
    const toYL = y => H - padB - (y - yMinL) / (yMaxL - yMinL) * (H - padT - padB);
    const toYR = y => H - padB - (y - yMinR) / (yMaxR - yMinR) * (H - padT - padB);

    // Grille + graduations axe gauche
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.font = '10px sans-serif';
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
        const v = yMinL + (yMaxL - yMinL) * i / ticks;
        const y = toYL(v);
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
        ctx.fillStyle = '#777';
        ctx.textAlign = 'right';
        ctx.fillText(opts.yFmtL ? opts.yFmtL(v) : v.toFixed(1), padL - 6, y + 3);
    }
    if (rightRange) {
        ctx.textAlign = 'left';
        for (let i = 0; i <= ticks; i++) {
            const v = yMinR + (yMaxR - yMinR) * i / ticks;
            ctx.fillStyle = '#777';
            ctx.fillText(opts.yFmtR ? opts.yFmtR(v) : v.toFixed(1), W - padR + 6, toYR(v) + 3);
        }
    }

    // Axe X (numéros de tour)
    ctx.fillStyle = '#777';
    ctx.textAlign = 'center';
    const xTickCount = Math.max(1, Math.min(8, Math.round(xMax - xMin)));
    for (let i = 0; i <= xTickCount; i++) {
        const v = Math.round(xMin + (xMax - xMin) * i / xTickCount);
        ctx.fillText(String(v), toX(v), H - padB + 14);
    }

    // Séries
    series.forEach(s => {
        if (!s.points.length) return;
        const toY = s.axis === 'R' ? toYR : toYL;
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        s.points.forEach((p, i) => {
            const x = toX(p.x), y = toY(p.y);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
        s.points.forEach(p => {
            const x = toX(p.x), y = toY(p.y);
            ctx.beginPath();
            ctx.arc(x, y, p.live ? 4 : 2.5, 0, Math.PI * 2);
            ctx.fillStyle = p.live ? '#fff' : s.color;
            ctx.fill();
            if (p.live) { ctx.strokeStyle = s.color; ctx.lineWidth = 2; ctx.stroke(); }
        });
    });

    if (legendEl) {
        _setLegendHtml(legendEl, series.map(s => {
            const last = s.points[s.points.length - 1];
            const fmt = s.axis === 'R' ? opts.yFmtR : opts.yFmtL;
            const val = last ? (fmt ? fmt(last.y) : last.y.toFixed(1)) : '—';
            return `<span class="live-chart-legend-item"><span class="live-chart-legend-swatch" style="background:${s.color};"></span>${s.label} <b style="color:var(--text);">${val}</b></span>`;
        }).join(''));
    }
}

function _drawFuelEvChart(allLaps, partial) {
    const canvas = document.getElementById('chartFuelEv');
    const legend = document.getElementById('chartFuelEvLegend');
    _drawLiveLineChart(canvas, legend, [
        {label: 'Carburant/tour', color: '#00aaff', axis: 'L', points: _lapNumPoints(allLaps, partial, l => l.fuelUsed)},
        {label: 'EV/tour',        color: '#ffaa00', axis: 'R', points: _lapNumPoints(allLaps, partial, l => l.vePctUsed)},
    ], {yFmtL: v => v.toFixed(2) + 'L', yFmtR: v => v.toFixed(1) + '%'});
}

function _drawTyreLifeChart(allLaps, partial) {
    const canvas = document.getElementById('chartTyreLife');
    const legend = document.getElementById('chartTyreLifeLegend');
    _drawLiveLineChart(canvas, legend, [
        {label: 'Usure G/tour', color: '#88ccff', axis: 'L', points: _lapNumPoints(allLaps, partial, l => l.wearLeftDelta)},
        {label: 'Usure D/tour', color: '#ffaa66', axis: 'L', points: _lapNumPoints(allLaps, partial, l => l.wearRightDelta)},
    ], {yFmtL: v => v.toFixed(2) + '%'});
}

function _drawLapTimeChart(allLaps, partial) {
    const canvas = document.getElementById('chartLapTime');
    const legend = document.getElementById('chartLapTimeLegend');
    _drawLiveLineChart(canvas, legend, [
        {label: 'Temps au tour', color: '#00ff88', axis: 'L', points: _lapNumPoints(allLaps, partial, l => l.lapTime)},
    ], {yFmtL: v => _fmtSecondsShort(v)});
}

const _LIVE_CORNER_COLORS = [['FL', '#ff6060'], ['FR', '#ffaa00'], ['RL', '#66ccff'], ['RR', '#aa66ff']];

function _drawTyreTempChart(allLaps, partial) {
    const canvas = document.getElementById('chartTyreTemp');
    const legend = document.getElementById('chartTyreTempLegend');
    const series = _LIVE_CORNER_COLORS.map(([c, color]) => ({
        label: c, color, axis: 'L',
        points: _lapNumPoints(allLaps, partial, l => l.tyreTempAvg && l.tyreTempAvg[c]),
    }));
    _drawLiveLineChart(canvas, legend, series, {yFmtL: v => v.toFixed(0) + '°C'});
}

function _drawOilWaterChart(allLaps, partial) {
    const canvas = document.getElementById('chartOilWater');
    const legend = document.getElementById('chartOilWaterLegend');
    _drawLiveLineChart(canvas, legend, [
        {label: 'Huile', color: '#ffaa00', axis: 'L', points: _lapNumPoints(allLaps, partial, l => l.oilTempAvg)},
        {label: 'Eau',   color: '#00aaff', axis: 'L', points: _lapNumPoints(allLaps, partial, l => l.waterTempAvg)},
    ], {yFmtL: v => v.toFixed(0) + '°C'});
}

function _drawBrakeTempChart(allLaps, partial) {
    const canvas = document.getElementById('chartBrakeTemp');
    const legend = document.getElementById('chartBrakeTempLegend');
    const series = _LIVE_CORNER_COLORS.map(([c, color]) => ({
        label: c, color, axis: 'L',
        points: _lapNumPoints(allLaps, partial, l => l.brakeTempAvg && l.brakeTempAvg[c]),
    }));
    _drawLiveLineChart(canvas, legend, series, {yFmtL: v => v.toFixed(0) + '°C'});
}

/* ── Trace accélérateur/frein vs distance parcourue (tour actuel, dernier
   tour, meilleur de la session, meilleur de l'événement) ── */
const _LIVE_TRACE_COLORS = {current: '#00ff88', last: '#ffaa00', bestSession: '#aa66ff', bestEvent: '#00ccff'};
const _LIVE_TRACE_LABELS = {current: 'Actuel · live', last: 'Dernier tour', bestSession: 'Meilleur de la session', bestEvent: "Meilleur de l'événement"};

window._liveTraceVisible = window._liveTraceVisible || {current: true, last: true, bestSession: true, bestEvent: true};

function toggleLiveTraceSeries(key) {
    window._liveTraceVisible[key] = !window._liveTraceVisible[key];
    const btn = document.querySelector(`.live-trace-toggle[data-trace="${key}"]`);
    if (btn) btn.classList.toggle('active', window._liveTraceVisible[key]);
    if (window._liveLastTraceData) _drawDriverTraceChart(window._liveLastTraceData);
}

function _drawDriverTraceChart(data) {
    const canvas = document.getElementById('chartDriverTrace');
    const legend = document.getElementById('chartDriverTraceLegend');
    if (!canvas) return;

    const traces = {
        current: data.currentLapTrace,
        last: data.lastLapTrace,
        bestSession: data.bestSessionLapTrace,
        bestEvent: data.bestEventLapTrace,
    };
    const visibleKeys = Object.keys(traces).filter(k => window._liveTraceVisible[k] && Array.isArray(traces[k]) && traces[k].length > 1);

    if (visibleKeys.length === 0) {
        _liveChartEmpty(canvas, legend, 'En attente de télémétrie live.');
        return;
    }

    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const trackLength = data.trackLength || Math.max(1, ...Object.values(traces).filter(Array.isArray).flat().map(p => p[0]));
    const padL = 38, padR = 10, padT = 10, padB = 16;
    const toX = d => padL + Math.min(1, d / trackLength) * (W - padL - padR);
    // Accélérateur et frein sur le même axe 0 → 100 % (frein en positif, comme l'accélérateur)
    const toY = pct => H - padB - Math.max(0, Math.min(100, pct)) / 100 * (H - padT - padB);

    ctx.lineWidth = 1;
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    [0, 50, 100].forEach(pct => {
        const y = toY(pct);
        ctx.strokeStyle = pct === 0 ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.1)';
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.fillText(`${pct}%`, padL - 6, y);
    });

    visibleKeys.forEach(key => {
        const pts = traces[key];
        const color = _LIVE_TRACE_COLORS[key];
        ctx.globalAlpha = key === 'current' ? 1 : 0.85;

        ctx.strokeStyle = color;
        ctx.lineWidth = key === 'current' ? 2.2 : 1.6;
        ctx.setLineDash([]);
        ctx.beginPath();
        pts.forEach((p, i) => {
            const x = toX(p[0]), y = toY(p[1]);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();

        ctx.setLineDash([3, 2]);
        ctx.beginPath();
        pts.forEach((p, i) => {
            const x = toX(p[0]), y = toY(p[2]);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
    });

    if (Array.isArray(data.currentLapTrace) && data.currentLapTrace.length) {
        const curD = data.currentLapTrace[data.currentLapTrace.length - 1][0];
        const x = toX(curD);
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB); ctx.stroke();
    }

    _setLegendHtml(legend, Object.keys(traces).map(key => {
        const has = Array.isArray(traces[key]) && traces[key].length > 1;
        const timeKey = key === 'bestSession' ? 'bestSessionLapTime' : key === 'bestEvent' ? 'bestEventLapTime' : null;
        const t = timeKey ? data[timeKey] : null;
        const timeStr = t != null ? ` (${_fmtSecondsShort(t)})` : '';
        return `<span class="live-chart-legend-item" style="opacity:${has ? 1 : 0.4};">
            <span class="live-chart-legend-swatch" style="background:${_LIVE_TRACE_COLORS[key]};"></span>${_LIVE_TRACE_LABELS[key]}${timeStr}
        </span>`;
    }).join('') + '<span style="color:var(--text-4);">Trait plein = accélérateur · pointillé = frein</span>');
}

function _updateLiveDriverTrace(data) {
    window._liveLastTraceData = data;
    if (_liveIsOnScreen(document.getElementById('chartDriverTrace'))) _drawDriverTraceChart(data);
}

/* Chaque graphique n'est redessiné que s'il est à l'écran : un graphique masqué ou
   hors de la fenêtre est repris au plus tard 1 s après y être revenu. */
function _updateLiveCharts(data) {
    window._liveLastChartsData = data;
    const allLaps = Array.isArray(data.allLaps) ? data.allLaps : [];
    const partial = data.currentLapPartial || null;
    [['chartFuelEv', _drawFuelEvChart], ['chartTyreLife', _drawTyreLifeChart],
     ['chartLapTime', _drawLapTimeChart], ['chartTyreTemp', _drawTyreTempChart],
     ['chartOilWater', _drawOilWaterChart], ['chartBrakeTemp', _drawBrakeTempChart]].forEach(([id, draw]) => {
        if (_liveIsOnScreen(document.getElementById(id))) draw(allLaps, partial);
    });
    _updateLiveDriverTrace(data);
}

/* ── Agrandir un graphique : la carte passe en plein écran (par-dessus la page) et le
   canvas prend la résolution de sa nouvelle taille, pour un dessin net et lisible.
   Fermeture : même bouton, touche Échap ou clic sur le fond. ── */
function _liveChartRedrawAll() {
    if (window._liveLastChartsData) _updateLiveCharts(window._liveLastChartsData);
    else _resetLiveCharts();
}

function _liveChartFitCanvas(card) {
    const canvas = card.querySelector('canvas.live-chart-canvas');
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.max(300, Math.round(r.width));
    canvas.height = Math.max(150, Math.round(r.height));
}

function toggleLiveChartExpand(card) {
    const open = document.querySelector('.live-chart-card.live-chart-expanded');
    if (open) {   // une seule carte agrandie à la fois : on referme d'abord
        const canvas = open.querySelector('canvas.live-chart-canvas');
        open.classList.remove('live-chart-expanded');
        if (canvas) { canvas.width = +canvas.dataset.baseW; canvas.height = +canvas.dataset.baseH; }
        open.querySelector('.live-chart-expand-btn')?.setAttribute('title', 'Agrandir');
        document.getElementById('liveChartBackdrop')?.remove();
        const spot = document.getElementById('liveChartExpandSpot');
        if (spot) { spot.replaceWith(open); }
        document.body.style.overflow = '';
    }
    if (card && card !== open) {
        const canvas = card.querySelector('canvas.live-chart-canvas');
        if (canvas && !canvas.dataset.baseW) { canvas.dataset.baseW = canvas.width; canvas.dataset.baseH = canvas.height; }
        const backdrop = document.createElement('div');
        backdrop.id = 'liveChartBackdrop';
        backdrop.className = 'live-chart-backdrop';
        backdrop.addEventListener('click', () => toggleLiveChartExpand(null));
        document.body.appendChild(backdrop);
        // La carte est déplacée sous <body> le temps de l'agrandissement (un parent avec
        // transform / filtre fausserait le plein écran) ; un repère garde sa place d'origine.
        const spot = document.createElement('div');
        spot.id = 'liveChartExpandSpot';
        spot.style.minHeight = card.offsetHeight + 'px';
        card.replaceWith(spot);
        document.body.appendChild(card);
        card.classList.add('live-chart-expanded');
        card.querySelector('.live-chart-expand-btn')?.setAttribute('title', 'Réduire (Échap)');
        document.body.style.overflow = 'hidden';
        _liveChartFitCanvas(card);
    }
    _liveChartRedrawAll();
}

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.live-chart-card').forEach(card => {
        if (!card.querySelector('canvas.live-chart-canvas') || card.querySelector('.live-chart-expand-btn')) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'live-chart-expand-btn';
        btn.title = 'Agrandir';
        btn.setAttribute('aria-label', 'Agrandir le graphique');
        btn.textContent = '⛶';
        btn.addEventListener('click', () => toggleLiveChartExpand(card));
        card.appendChild(btn);
    });
});
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.querySelector('.live-chart-expanded')) toggleLiveChartExpand(null);
});
window.addEventListener('resize', () => {
    const card = document.querySelector('.live-chart-card.live-chart-expanded');
    if (card) { _liveChartFitCanvas(card); _liveChartRedrawAll(); }
});

function _resetLiveCharts() {
    ['chartFuelEv', 'chartTyreLife', 'chartLapTime', 'chartTyreTemp', 'chartOilWater', 'chartBrakeTemp', 'chartDriverTrace'].forEach(id => {
        const canvas = document.getElementById(id);
        const legend = document.getElementById(id + 'Legend');
        _liveChartEmpty(canvas, legend);
    });
    window._liveLastTraceData = null;
}
