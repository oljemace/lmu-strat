/* ══════════════════════════════════════════════════════════════
   team-chat.js — Chat interne de l'équipe

   Stockage : teams/{équipe}/chat
     next        → numéro du prochain emplacement (0..499)
     m/{0..499}  → { uid, name, text, ts }   (tampon circulaire de 500 messages :
                   le 501e remplace le plus ancien, aucune suppression nécessaire)
   Tous les membres (admin, pilote, lecteur) lisent et écrivent ; seuls les admins
   suppriment un message (voir firebase/database.rules.json). Le texte est toujours
   affiché via textContent (jamais en HTML).
   ══════════════════════════════════════════════════════════════ */

const CHAT_SLOTS = 500;
const CHAT_MAX_LEN = 500;

let _chatStop = null;
let _chatMsgs = {};          // slot → message
let _chatOpen = false;
let _chatMyName = null;
let _chatTeam = null;
let _chatLastSend = 0;
let _chatLastUnread = 0;
let _chatBaseTitle = null;
let _chatReady = false;          // faux jusqu'au premier chargement (pas de son pour l'historique)
let _chatLastOtherTs = 0;
let _chatAudio = null;

function _chatSoundOn() {
    try { return localStorage.getItem('lmuChatSound') !== '0'; } catch (e) { return true; }
}
function _chatSoundSet(on) {
    try { localStorage.setItem('lmuChatSound', on ? '1' : '0'); } catch (e) { /* stockage indisponible */ }
    const b = document.getElementById('teamChatSound');
    if (b) { b.textContent = on ? '🔔' : '🔕'; b.title = on ? 'Son activé (cliquer pour couper)' : 'Son coupé (cliquer pour activer)'; }
}
// Petit « ding » à deux notes. Le navigateur n'autorise le son qu'après une première
// interaction avec la page ; sinon l'appel échoue en silence.
function _chatBeep() {
    try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        if (!_chatAudio) _chatAudio = new AC();
        if (_chatAudio.state === 'suspended') _chatAudio.resume();
        const t0 = _chatAudio.currentTime;
        [[880, 0], [1175, 0.14]].forEach(([f, dt]) => {
            const o = _chatAudio.createOscillator(), g = _chatAudio.createGain();
            o.type = 'sine'; o.frequency.value = f;
            g.gain.setValueAtTime(0.0001, t0 + dt);
            g.gain.exponentialRampToValueAtTime(0.18, t0 + dt + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.22);
            o.connect(g); g.connect(_chatAudio.destination);
            o.start(t0 + dt); o.stop(t0 + dt + 0.25);
        });
    } catch (e) { /* son indisponible */ }
}

function _chatSeenKey() {
    const u = window._firebaseAuth?.currentUser;
    return `lmuChatSeen:${_chatTeam}:${u ? u.uid : ''}`;
}
function _chatSeenGet() {
    try { return Number(localStorage.getItem(_chatSeenKey())) || 0; } catch (e) { return 0; }
}
function _chatSeenSet(ts) {
    try { localStorage.setItem(_chatSeenKey(), String(ts)); } catch (e) { /* stockage indisponible */ }
}

function _chatSorted() {
    return Object.keys(_chatMsgs)
        .map(slot => Object.assign({ slot }, _chatMsgs[slot]))
        .filter(m => m && typeof m.text === 'string')
        .map(m => { m.t = typeof m.ts === 'number' ? m.ts : Date.now(); return m; })
        .sort((a, b) => a.t - b.t);
}

function _chatFmtTime(t) {
    const d = new Date(t), now = new Date();
    const hm = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === now.toDateString()
        ? hm
        : d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) + ' ' + hm;
}

function _chatEnsureUI() {
    if (document.getElementById('teamChatPanel')) return;
    const wrap = document.createElement('div');
    wrap.id = 'teamChatRoot';
    wrap.innerHTML =
        '<button id="teamChatToggle" type="button" title="Chat de l\'équipe" aria-label="Ouvrir le chat de l\'équipe">💬' +
        '<span id="teamChatBadge" style="display:none"></span></button>' +
        '<div id="teamChatPanel" style="display:none">' +
        '<div class="chat-head"><span>💬 Chat de l\'équipe</span>' +
        '<span><button type="button" id="teamChatSound" aria-label="Son des notifications">🔔</button>' +
        '<button type="button" id="teamChatClose" aria-label="Fermer">✕</button></span></div>' +
        '<div id="teamChatPresence" style="display:none"></div>' +
        '<div id="teamChatList"></div>' +
        '<div id="teamChatError" style="display:none"></div>' +
        '<form id="teamChatForm"><textarea id="teamChatInput" rows="2" maxlength="' + CHAT_MAX_LEN +
        '" placeholder="Message… (Entrée pour envoyer)"></textarea>' +
        '<button type="submit">Envoyer</button></form></div>';
    document.body.appendChild(wrap);

    document.getElementById('teamChatToggle').addEventListener('click', () => _chatSetOpen(!_chatOpen));
    document.getElementById('teamChatClose').addEventListener('click', () => _chatSetOpen(false));
    _chatSoundSet(_chatSoundOn());
    document.getElementById('teamChatSound').addEventListener('click', () => {
        const on = !_chatSoundOn();
        _chatSoundSet(on);
        if (on) _chatBeep();
    });
    // Débloque le son dès la première interaction avec la page
    document.addEventListener('pointerdown', function unlock() {
        document.removeEventListener('pointerdown', unlock);
        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (AC && !_chatAudio) _chatAudio = new AC();
            if (_chatAudio && _chatAudio.state === 'suspended') _chatAudio.resume();
        } catch (e) { /* sans conséquence */ }
    });
    document.getElementById('teamChatForm').addEventListener('submit', e => { e.preventDefault(); chatSend(); });
    document.getElementById('teamChatInput').addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatSend(); }
    });
}

function _chatSetOpen(open) {
    _chatOpen = open;
    const panel = document.getElementById('teamChatPanel');
    if (panel) panel.style.display = open ? 'flex' : 'none';
    if (open) {
        _chatRender();
        document.getElementById('teamChatInput')?.focus();
    }
}

function _chatError(msg) {
    const el = document.getElementById('teamChatError');
    if (!el) return;
    el.textContent = msg || '';
    el.style.display = msg ? 'block' : 'none';
}

function _chatRender() {
    const list = document.getElementById('teamChatList');
    if (!list) return;
    const me = window._firebaseAuth?.currentUser?.uid;
    const msgs = _chatSorted();
    const seen = _chatSeenGet();

    if (_chatOpen) {
        const last = msgs.length ? msgs[msgs.length - 1].t : 0;
        if (last > seen) _chatSeenSet(last);
    }
    const unread = _chatOpen ? 0 : msgs.filter(m => m.t > seen && m.uid !== me).length;
    const badge = document.getElementById('teamChatBadge');
    if (badge) {
        badge.textContent = unread > 99 ? '99+' : String(unread);
        badge.style.display = unread ? 'inline-block' : 'none';
    }
    // Compteur dans le titre de l'onglet + animation quand un nouveau message arrive
    if (_chatBaseTitle === null) _chatBaseTitle = document.title.replace(/^\(\d+\+?\) /, '');
    document.title = (unread ? `(${unread > 99 ? '99+' : unread}) ` : '') + _chatBaseTitle;
    if (unread > _chatLastUnread) {
        const t = document.getElementById('teamChatToggle');
        if (t) { t.classList.remove('chat-ping'); void t.offsetWidth; t.classList.add('chat-ping'); }
    }
    _chatLastUnread = unread;

    // Son : un message d'un autre membre plus récent que tous ceux déjà vus
    const others = msgs.filter(m => m.uid !== me);
    const newest = others.length ? others[others.length - 1].t : 0;
    if (_chatReady && newest > _chatLastOtherTs && _chatSoundOn()) _chatBeep();
    if (newest > _chatLastOtherTs) _chatLastOtherTs = newest;
    _chatReady = true;
    if (!_chatOpen) return;

    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    list.textContent = '';
    if (!msgs.length) {
        const p = document.createElement('div');
        p.className = 'chat-empty';
        p.textContent = 'Aucun message pour le moment.';
        list.appendChild(p);
    }
    const isAdmin = window._teamRole === 'admin';
    msgs.forEach(m => {
        const row = document.createElement('div');
        row.className = 'chat-msg' + (m.uid === me ? ' mine' : '');
        const head = document.createElement('div');
        head.className = 'chat-meta';
        const who = document.createElement('b');
        who.textContent = m.name || 'Membre';
        const when = document.createElement('span');
        when.textContent = ' · ' + _chatFmtTime(m.t);
        head.appendChild(who);
        head.appendChild(when);
        if (isAdmin) {
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'chat-del';
            del.title = 'Supprimer ce message (modération)';
            del.textContent = '🗑';
            del.addEventListener('click', () => chatDelete(m.slot));
            head.appendChild(del);
        }
        const body = document.createElement('div');
        body.className = 'chat-text';
        body.textContent = m.text;
        row.appendChild(head);
        row.appendChild(body);
        list.appendChild(row);
    });
    if (nearBottom || list.dataset.init !== '1') {
        list.scrollTop = list.scrollHeight;
        list.dataset.init = '1';
    }
}

async function _chatName(user) {
    if (_chatMyName) return _chatMyName;
    let name = '';
    try {
        const m = (await window._firebaseGet(window._firebaseRef(window._firebaseDb,
            teamPath(`members/${user.uid}`)))).val();
        name = (m && m.name) || '';
    } catch (e) { /* nom indisponible : on retombe sur l'email */ }
    _chatMyName = (name || (user.email || '').split('@')[0] || 'Membre').slice(0, 60);
    return _chatMyName;
}

async function chatSend() {
    const input = document.getElementById('teamChatInput');
    const user = window._firebaseAuth?.currentUser;
    if (!input || !user || !window._teamId) return;
    const text = input.value.trim().slice(0, CHAT_MAX_LEN);
    if (!text) return;
    if (Date.now() - _chatLastSend < 800) return;   // anti-rafale
    _chatLastSend = Date.now();
    _chatError('');
    input.disabled = true;
    try {
        const db = window._firebaseDb, ref = window._firebaseRef;
        const name = await _chatName(user);
        // Réserve l'emplacement : le compteur avance de façon atomique (deux envois
        // simultanés n'obtiennent pas le même emplacement).
        let slot = 0;
        const res = await window._firebaseRunTransaction(ref(db, teamPath('chat/next')), cur => {
            const n = (Number.isInteger(cur) && cur >= 0 && cur < CHAT_SLOTS) ? cur : 0;
            slot = n;
            return (n + 1) % CHAT_SLOTS;
        });
        if (!res.committed) throw new Error('compteur non validé');
        await window._firebaseSet(ref(db, teamPath(`chat/m/${slot}`)), {
            uid: user.uid, name, text, ts: window._firebaseServerTimestamp()
        });
        input.value = '';
    } catch (e) {
        console.error('Chat : envoi impossible', e);
        _chatError("Message non envoyé (connexion ou droits). Réessayez.");
    } finally {
        input.disabled = false;
        input.focus();
    }
}

function chatDelete(slot) {
    if (window._teamRole !== 'admin') return;
    window._firebaseRemove(window._firebaseRef(window._firebaseDb, teamPath(`chat/m/${slot}`)))
        .catch(e => { console.error('Chat : suppression impossible', e); _chatError('Suppression refusée.'); });
}

function stopTeamChat() {
    if (_chatStop) { try { _chatStop(); } catch (e) { /* sans conséquence */ } }
    _chatStop = null;
    _chatMsgs = {};
    _chatReady = false; _chatLastOtherTs = 0; _chatLastUnread = 0;
    document.getElementById('teamChatRoot')?.remove();
    _chatOpen = false;
}

function startTeamChat() {
    if (!window._firebaseDb || !window._teamId || !window._firebaseAuth?.currentUser) return;
    if (_chatStop && _chatTeam === window._teamId) return;   // déjà actif pour cette équipe
    stopTeamChat();
    _chatTeam = window._teamId;
    _chatMyName = null;
    _chatEnsureUI();
    const r = window._firebaseRef(window._firebaseDb, teamPath('chat/m'));
    _chatStop = window._firebaseOnValue(r, snap => {
        _chatMsgs = snap.val() || {};
        _chatRender();
    }, err => console.warn('Chat : lecture impossible', err && err.code));
}
