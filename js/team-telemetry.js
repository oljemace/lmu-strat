/* ══════════════════════════════════════════════
   TÉLÉMÉTRIE ÉQUIPE EN DIRECT
   Affiche les données live poussées par chaque pilote connecté via
   collector/lmu_firebase_connector.py, sous
   teams/{équipe}/sessions/{sessionId}/telemetry/{driverId}/live. Lecture seule : ce
   fichier n'écrit jamais rien dans Firebase.
   ══════════════════════════════════════════════ */

let _teamTelemetryUnsubscribe = null;
let _teamTelemetryData = {};        // { driverId: liveObject }
let _teamTelemetryRefreshTimer = null;

let _atWheelId = null;   // pilote actuellement « au volant » (mémorisé : évite de sauter de l'un à l'autre)

/**
 * Qui conduit ? Parmi les pilotes qui envoient en ce moment, on privilégie ceux qui ne sont pas aux stands
 * (un coéquipier en attente de relais a souvent son programme ouvert aussi), et on GARDE le pilote actuel
 * tant qu'il remplit ces conditions — sinon deux programmes ouverts feraient alterner l'affichage à chaque envoi.
 */
function teamAtWheelDriver() {
    const now = Date.now();
    const online = Object.entries(_teamTelemetryData)
        .filter(([, d]) => d && d.connected !== false && d.ts && now - d.ts <= TEAM_TELEMETRY_STALE_MS);
    const driving = online.filter(([, d]) => !d.inPits);
    const pool = driving.length ? driving : online;
    if (_atWheelId && pool.some(([id]) => id === _atWheelId)) return _atWheelId;
    pool.sort((a, b) => b[1].ts - a[1].ts);
    _atWheelId = pool.length ? pool[0][0] : null;
    return _atWheelId;
}

const TEAM_TELEMETRY_STALE_MS = 15000; // pousse toutes les ~3s côté connecteur ; au-delà, "obsolète"

function startTeamTelemetryWatch(sessionId) {
    stopTeamTelemetryWatch();
    window._teamTelemetrySessionId = sessionId || null;   // lu par le Mode Live à distance (remote-live.js)
    if (!sessionId || !window._firebaseDb || !window._firebaseRef || !window._firebaseOnValue) return;

    const teleRef = window._firebaseRef(window._firebaseDb, teamPath(`sessions/${sessionId}/telemetry`));
    _teamTelemetryUnsubscribe = window._firebaseOnValue(teleRef, snap => {
        const all = snap.val() || {};
        const next = {};
        Object.entries(all).forEach(([driverId, d]) => {
            if (d && d.live) next[driverId] = d.live;
        });
        _teamTelemetryData = next;
        renderTeamTelemetry();
    });

    // Re-rendu périodique indépendant des mises à jour Firebase, pour faire
    // vieillir correctement la pastille "obsolète" même si un pilote arrête
    // d'envoyer (plus aucun événement onValue ne se déclenche dans ce cas).
    _teamTelemetryRefreshTimer = setInterval(renderTeamTelemetry, 3000);
}

function stopTeamTelemetryWatch() {
    if (_teamTelemetryUnsubscribe) { _teamTelemetryUnsubscribe(); _teamTelemetryUnsubscribe = null; }
    if (_teamTelemetryRefreshTimer) { clearInterval(_teamTelemetryRefreshTimer); _teamTelemetryRefreshTimer = null; }
    _teamTelemetryData = {};
    window._teamTelemetrySessionId = null;
    renderTeamTelemetry();
}

function _teamTelemetryCompoundColor(compound) {
    return { soft: '#ff4466', medium: '#ffcc00', hard: '#eeeeee', wet: '#3399ff' }[compound] || '#888';
}

function _teamTelemetryEscapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderTeamTelemetry() {
    const section = document.getElementById('teamTelemetrySection');
    const list = document.getElementById('teamTelemetryList');
    if (typeof refreshLiveSourceOptions === 'function') refreshLiveSourceOptions();   // liste des pilotes du Mode Live à distance
    if (!section || !list) return;

    const driverIds = Object.keys(_teamTelemetryData);
    section.style.display = driverIds.length > 0 ? '' : 'none';
    if (driverIds.length === 0) { list.innerHTML = ''; return; }

    const now = Date.now();
    // Relais de pilotes : seul celui qui envoie réellement en ce moment est « au volant » ; les autres
    // (arrêtés, ou silencieux depuis plus de 15 s) passent en « hors ligne » et sont rangés après.
    const isOffline = d => d.connected === false || !d.ts || (now - d.ts) > TEAM_TELEMETRY_STALE_MS;
    const atWheel = teamAtWheelDriver();
    list.innerHTML = driverIds
        .sort((a, b) => ((b === atWheel) - (a === atWheel))
            || (isOffline(_teamTelemetryData[a]) - isOffline(_teamTelemetryData[b]))
            || (_teamTelemetryData[a].driverName || a).localeCompare(_teamTelemetryData[b].driverName || b))
        .map(driverId => {
            const d = _teamTelemetryData[driverId];
            const age = now - (d.ts || 0);
            const stale = isOffline(d);
            const ageLabel = d.ts ? `${Math.max(0, Math.round(age / 1000))}s` : '?';
            const leftColor = _teamTelemetryCompoundColor(d.leftCompound);
            const rightColor = _teamTelemetryCompoundColor(d.rightCompound);
            const name = _teamTelemetryEscapeHtml(d.driverName || driverId);
            const car = _teamTelemetryEscapeHtml(d.car || '—');

            return `
                <div style="background:rgba(255,255,255,${stale ? 0.03 : 0.07});
                            border:1px solid ${stale ? 'rgba(255,255,255,0.08)' : 'rgba(0,255,136,0.25)'};
                            border-radius:10px;padding:12px 14px;min-width:210px;${stale ? 'opacity:0.55;' : ''}">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                        <strong style="color:#00ff88;">${name}</strong>
                        ${driverId === atWheel ? '<span style="font-size:0.72em;color:#00ff88;border:1px solid rgba(0,255,136,0.4);border-radius:8px;padding:1px 6px;">🏁 au volant</span>' : (stale ? '<span style="font-size:0.72em;color:#888;">hors ligne</span>' : '')}
                        <span title="Dernière donnée reçue il y a ${ageLabel}"
                              style="width:8px;height:8px;border-radius:50%;display:inline-block;
                                     background:${stale ? '#ff4444' : '#00ff88'};"></span>
                    </div>
                    <div style="font-size:0.82em;color:#aaa;margin-bottom:6px;">${car}</div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;font-size:0.85em;">
                        <span>Tour</span><span style="text-align:right;">${d.lapNumberCurrent ?? '—'}</span>
                        <span>EV</span><span style="text-align:right;">${d.veCurrentPct != null ? d.veCurrentPct.toFixed(1) + '%' : '—'}</span>
                        <span>Tour moy.</span><span style="text-align:right;">${d.avgLapTimeLast10 != null ? d.avgLapTimeLast10.toFixed(2) + 's' : '—'}</span>
                        <span>Conso EV/t.</span><span style="text-align:right;">${d.avgVePerLapLast10 != null ? d.avgVePerLapLast10.toFixed(2) + '%' : '—'}</span>
                        <span>Pneus G/D</span>
                        <span style="text-align:right;">
                            <span style="color:${leftColor};">${_teamTelemetryEscapeHtml(d.leftCompound) || '—'}</span>
                            /
                            <span style="color:${rightColor};">${_teamTelemetryEscapeHtml(d.rightCompound) || '—'}</span>
                        </span>
                        <span>Arrêts</span><span style="text-align:right;">${d.numPitstops ?? '—'}</span>
                    </div>
                    ${d.inPits ? '<div style="margin-top:6px;color:#ffaa00;font-size:0.8em;font-weight:bold;">🔧 Aux stands</div>' : ''}
                </div>
            `;
        }).join('');
}
