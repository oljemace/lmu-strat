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

const TEAM_TELEMETRY_STALE_MS = 15000; // pousse toutes les ~3s côté connecteur ; au-delà, "obsolète"

function startTeamTelemetryWatch(sessionId) {
    stopTeamTelemetryWatch();
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
    if (!section || !list) return;

    const driverIds = Object.keys(_teamTelemetryData);
    section.style.display = driverIds.length > 0 ? '' : 'none';
    if (driverIds.length === 0) { list.innerHTML = ''; return; }

    const now = Date.now();
    list.innerHTML = driverIds
        .sort((a, b) => (_teamTelemetryData[a].driverName || a).localeCompare(_teamTelemetryData[b].driverName || b))
        .map(driverId => {
            const d = _teamTelemetryData[driverId];
            const age = now - (d.ts || 0);
            const stale = !d.ts || age > TEAM_TELEMETRY_STALE_MS;
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
