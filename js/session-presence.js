/* ══════════════════════════════════════════════
   PRÉSENCE DANS L'ÉQUIPE
   Affiche, dans le panneau du chat, qui est connecté et dans quelle session.
   Chaque membre écrit teams/{équipe}/presence/{uid} = { name, sid, sname, ts } ;
   l'entrée est retirée à la déconnexion (onDisconnect) et son horodatage rafraîchi
   toutes les minutes. Une entrée plus vieille que PRESENCE_STALE_MS est ignorée
   (onglet planté). Tous les membres de l'équipe voient la liste.
   Tout est facultatif : si les règles Firebase n'autorisent pas encore
   l'écriture, rien ne s'affiche et le reste de l'appli n'est pas touché.
   ══════════════════════════════════════════════ */
const PRESENCE_BEAT_MS  = 60 * 1000;
const PRESENCE_STALE_MS = 3 * 60 * 1000;

let _presenceStops = [];
let _presenceData  = {};
let _presenceName  = null;
let _presenceTeamId = null;
let _presenceBeat  = null;

function _presenceRender() {
    const me = window._firebaseAuth?.currentUser?.uid;
    const now = Date.now();
    const people = Object.keys(_presenceData)
        .map(uid => Object.assign({ uid }, _presenceData[uid]))
        .filter(p => p && typeof p.ts === 'number' && now - p.ts < PRESENCE_STALE_MS)
        .sort((a, b) => (a.uid === me ? -1 : b.uid === me ? 1 : String(a.name).localeCompare(String(b.name))));

    const toggle = document.getElementById('teamChatToggle');
    if (toggle) toggle.title = "Chat de l'équipe" + (people.length ? ` — ${people.length} en ligne` : '');

    const el = document.getElementById('teamChatPresence');
    if (!el) return;
    el.textContent = '';
    if (!people.length) { el.style.display = 'none'; return; }
    el.style.display = '';
    const head = document.createElement('div');
    head.className = 'presence-title';
    head.textContent = '🟢 En ligne (' + people.length + ')';
    el.appendChild(head);
    people.forEach(p => {
        const row = document.createElement('div');
        row.className = 'presence-row' + (p.uid === me ? ' mine' : '');
        const who = document.createElement('b');
        who.textContent = String(p.name || '?').slice(0, 30) + (p.uid === me ? ' (vous)' : '');
        const where = document.createElement('span');
        where.textContent = p.sid ? '📋 ' + String(p.sname || 'Session').slice(0, 40) : 'hors session';
        if (!p.sid) where.className = 'presence-none';
        row.appendChild(who);
        row.appendChild(where);
        el.appendChild(row);
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

function _presenceSessionName(id) {
    if (!id) return '';
    const opt = Array.from(document.getElementById('sessionSelect')?.options || []).find(o => o.value === id);
    return ((opt && opt.textContent) || 'Session').replace(/^\s*[^\p{L}\p{N}]+/u, '').trim().slice(0, 100);
}

function stopTeamPresence() {
    _presenceStops.forEach(fn => { try { fn(); } catch (e) { /* sans conséquence */ } });
    _presenceStops = [];
    _presenceData = {};
    _presenceBeat = null;
    _presenceTeamId = null;
    _presenceRender();
}

async function startTeamPresence() {
    const user = window._firebaseAuth?.currentUser;
    if (!user || !window._firebaseDb || !window._teamId || !window._firebaseOnDisconnect) return;
    if (_presenceTeamId === window._teamId) return;     // déjà actif pour cette équipe
    stopTeamPresence();
    const db = window._firebaseDb, ref = window._firebaseRef;
    const teamId = _presenceTeamId = window._teamId;
    const myRef = ref(db, `teams/${teamId}/presence/${user.uid}`);
    const name = await _presenceMyName(user);
    if (_presenceTeamId !== teamId) return;             // équipe changée entre-temps

    const beat = _presenceBeat = () => {
        const sid = window._presenceSession || '';
        const data = { name, sid, ts: Date.now() };
        if (sid) data.sname = _presenceSessionName(sid);
        return window._firebaseSet(myRef, data).catch(() => {});
    };

    // (Re)connexion au serveur : on se (re)déclare et on programme le retrait automatique
    const offConn = window._firebaseOnValue(ref(db, '.info/connected'), snap => {
        if (snap.val() !== true) return;
        window._firebaseOnDisconnect(myRef).remove().then(beat).catch(() => {});
    });
    const timer = setInterval(() => { beat(); _presenceRender(); }, PRESENCE_BEAT_MS);
    const offList = window._firebaseOnValue(
        ref(db, `teams/${teamId}/presence`),
        snap => { _presenceData = snap.val() || {}; _presenceRender(); },
        () => { _presenceData = {}; _presenceRender(); });

    _presenceStops.push(offConn, () => clearInterval(timer), offList,
        () => { window._firebaseOnDisconnect(myRef).cancel().catch(() => {}); });
}

/* Appelé par joinSession() / à la perte de la session : met à jour la session affichée */
function presenceSwitchTo(sessionId) {
    window._presenceSession = sessionId || null;
    if (_presenceBeat) _presenceBeat();
}
