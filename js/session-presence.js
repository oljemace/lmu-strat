/* ══════════════════════════════════════════════
   PRÉSENCE DANS LA SESSION
   Affiche dans la barre du haut qui est connecté à la session ouverte.
   Chaque utilisateur écrit teams/{équipe}/sessions/{id}/presence/{uid} =
   { name, ts } ; l'entrée est retirée à la déconnexion (onDisconnect) et son
   horodatage rafraîchi toutes les minutes. Une entrée plus vieille que
   PRESENCE_STALE_MS est ignorée (onglet planté).
   Tout est facultatif : si les règles Firebase n'autorisent pas encore
   l'écriture, rien ne s'affiche et le reste de l'appli n'est pas touché.
   ══════════════════════════════════════════════ */
const PRESENCE_BEAT_MS  = 60 * 1000;
const PRESENCE_STALE_MS = 3 * 60 * 1000;

let _presenceStops = [];
let _presenceData  = {};
let _presenceName  = null;

function _presenceEl() { return document.getElementById('sessionPresence'); }

function _presenceRender() {
    const el = _presenceEl();
    if (!el) return;
    const me = window._firebaseAuth?.currentUser?.uid;
    const now = Date.now();
    const people = Object.keys(_presenceData)
        .map(uid => Object.assign({ uid }, _presenceData[uid]))
        .filter(p => p && typeof p.ts === 'number' && now - p.ts < PRESENCE_STALE_MS)
        .sort((a, b) => (a.uid === me ? -1 : b.uid === me ? 1 : String(a.name).localeCompare(String(b.name))));
    el.textContent = '';
    if (!people.length) { el.style.display = 'none'; return; }
    el.style.display = '';
    const label = document.createElement('span');
    label.textContent = '🟢 En ligne : ';
    label.style.color = '#8e9ac0';
    el.appendChild(label);
    people.forEach((p, i) => {
        const s = document.createElement('span');
        s.textContent = String(p.name || '?').slice(0, 30) + (p.uid === me ? ' (vous)' : '');
        s.style.cssText = 'color:' + (p.uid === me ? '#00ff88' : '#fff') + ';font-weight:bold;';
        el.appendChild(s);
        if (i < people.length - 1) el.appendChild(document.createTextNode(' · '));
    });
}

async function _presenceMyName(user) {
    if (_presenceName) return _presenceName;
    let name = '';
    try {
        const m = (await window._firebaseGet(window._firebaseRef(window._firebaseDb,
            teamPath(`members/${user.uid}`)))).val();
        name = (m && m.name) || '';
    } catch (e) { /* nom indisponible : on retombe sur l'email */ }
    _presenceName = (name || (user.email || '').split('@')[0] || 'Membre').slice(0, 60);
    return _presenceName;
}

function stopSessionPresence(sessionId, teamId) {
    _presenceStops.forEach(fn => { try { fn(); } catch (e) { /* sans conséquence */ } });
    _presenceStops = [];
    _presenceData = {};
    _presenceRender();
    // On retire notre entrée de la session quittée (si on la connaît)
    const user = window._firebaseAuth?.currentUser;
    if (sessionId && teamId && user && window._firebaseRemove) {
        window._firebaseRemove(window._firebaseRef(window._firebaseDb,
            `teams/${teamId}/sessions/${sessionId}/presence/${user.uid}`)).catch(() => {});
    }
}

async function startSessionPresence(sessionId) {
    const user = window._firebaseAuth?.currentUser;
    if (!user || !window._firebaseDb || !window._teamId || !window._firebaseOnDisconnect) return;
    const db = window._firebaseDb, ref = window._firebaseRef;
    const teamId = window._teamId;
    const myRef = ref(db, `teams/${teamId}/sessions/${sessionId}/presence/${user.uid}`);
    const name = await _presenceMyName(user);
    if (window._presenceSession !== sessionId) return;   // session déjà quittée entre-temps

    const beat = () => window._firebaseSet(myRef, { name, ts: Date.now() }).catch(() => {});

    // (Re)connexion au serveur : on se (re)déclare et on programme le retrait automatique
    const offConn = window._firebaseOnValue(ref(db, '.info/connected'), snap => {
        if (snap.val() !== true) return;
        window._firebaseOnDisconnect(myRef).remove().then(beat).catch(() => {});
    });
    const timer = setInterval(() => { beat(); _presenceRender(); }, PRESENCE_BEAT_MS);
    const offList = window._firebaseOnValue(
        ref(db, `teams/${teamId}/sessions/${sessionId}/presence`),
        snap => { _presenceData = snap.val() || {}; _presenceRender(); },
        () => { _presenceData = {}; _presenceRender(); });

    _presenceStops.push(offConn, () => clearInterval(timer), offList,
        () => { window._firebaseOnDisconnect(myRef).cancel().catch(() => {}); });
}

/* Point d'entrée appelé par joinSession() / à la perte de la session */
function presenceSwitchTo(sessionId) {
    const prev = window._presenceSession, prevTeam = window._presenceTeam;
    stopSessionPresence(prev, prevTeam);
    window._presenceSession = sessionId || null;
    window._presenceTeam = window._teamId;
    if (sessionId) startSessionPresence(sessionId).catch(() => {});
}
