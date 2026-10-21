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
let _chatLastUnreadTag = 0;
let _chatBaseTitle = null;
let _chatReady = false;          // faux jusqu'au premier chargement (pas de son pour l'historique)
let _chatLastOtherTs = 0;
let _chatAudio = null;

/* ── Tags : @membre et #session écrits dans le texte du message ──
   Aucun champ supplémentaire n'est stocké : le texte est analysé à l'affichage avec la
   liste des membres et des sessions. Un message est « pour moi » s'il cite mon nom ou
   la session dans laquelle je me trouve ; il déclenche alors une notification distincte. */
let _chatMembers = {};           // uid → nom
let _chatMembersStop = null;
let _chatSugg = [];              // suggestions affichées
let _chatSuggIdx = 0;

function _chatSessions() {
    return Array.from(document.getElementById('sessionSelect')?.options || [])
        .filter(o => o.value)
        .map(o => ({ id: o.value, label: o.textContent.replace(/^\s*[^\p{L}\p{N}]+/u, '').trim() }))
        .filter(s => s.label);
}

function _chatTargets() {
    const t = [];
    Object.keys(_chatMembers).forEach(uid => t.push({ kind: 'user', uid, label: _chatMembers[uid], sym: '@' }));
    _chatSessions().forEach(s => t.push({ kind: 'session', id: s.id, label: s.label, sym: '#' }));
    return t.sort((a, b) => b.label.length - a.label.length);   // le plus long d'abord
}

// Découpe un texte en segments { text } / { text, tag }
function _chatSegments(text) {
    const targets = _chatTargets();
    const isWord = c => !!c && /[\p{L}\p{N}_]/u.test(c);
    const low = text.toLowerCase();
    const out = [];
    let buf = '', i = 0;
    while (i < text.length) {
        const c = text[i];
        let hit = null;
        if ((c === '@' || c === '#') && !isWord(text[i - 1])) {
            hit = targets.find(t => t.sym === c &&
                low.startsWith(t.label.toLowerCase(), i + 1) &&
                !isWord(text[i + 1 + t.label.length]));
        }
        if (hit) {
            if (buf) { out.push({ text: buf }); buf = ''; }
            const len = 1 + hit.label.length;
            out.push({ text: text.substr(i, len), tag: hit });
            i += len;
        } else { buf += c; i++; }
    }
    if (buf) out.push({ text: buf });
    return out;
}

// Ce message me concerne-t-il (autre auteur que moi) ?
function _chatIsForMe(m, me) {
    if (m.uid === me) return false;
    return _chatSegments(m.text).some(s => s.tag &&
        ((s.tag.kind === 'user' && s.tag.uid === me) ||
         (s.tag.kind === 'session' && s.tag.id === window._presenceSession)));
}

function _chatFillBody(body, m, me) {
    _chatSegments(m.text).forEach(s => {
        if (!s.tag) { body.appendChild(document.createTextNode(s.text)); return; }
        if (s.tag.kind === 'user') {
            const el = document.createElement('span');
            el.className = 'chat-tag chat-tag-user' + (s.tag.uid === me ? ' me' : '');
            el.textContent = s.text;
            body.appendChild(el);
        } else {
            const el = document.createElement('button');
            el.type = 'button';
            el.className = 'chat-tag chat-tag-session';
            el.title = 'Ouvrir cette session';
            el.textContent = s.text;
            el.addEventListener('click', () => {
                const sel = document.getElementById('sessionSelect');
                if (sel && sel.value !== s.tag.id) {
                    sel.value = s.tag.id;
                    sel.dispatchEvent(new Event('change'));
                }
            });
            body.appendChild(el);
        }
    });
}

// ── Complétion pendant la frappe : @ → membres, # → sessions ──
function _chatSuggestHide() {
    _chatSugg = [];
    const el = document.getElementById('teamChatSuggest');
    if (el) el.style.display = 'none';
}

function _chatSuggestUpdate() {
    const input = document.getElementById('teamChatInput');
    const el = document.getElementById('teamChatSuggest');
    if (!input || !el) return;
    const before = input.value.slice(0, input.selectionStart);
    const m = /(^|\s)([@#])([^\s@#]*)$/.exec(before);
    const em = !m && typeof _chatEmojiSuggest === 'function' ? /(^|\s):([^\s:]*)$/.exec(before) : null;
    if (!m && !em) { _chatSuggestHide(); return; }
    if (em) _chatSugg = _chatEmojiSuggest(em[2]);
    else {
        const frag = m[3].toLowerCase();
        _chatSugg = _chatTargets().filter(t => t.sym === m[2] && t.label.toLowerCase().includes(frag))
            .sort((a, b) => a.label.localeCompare(b.label)).slice(0, 6);
    }
    if (!_chatSugg.length) { _chatSuggestHide(); return; }
    _chatSuggIdx = Math.min(_chatSuggIdx, _chatSugg.length - 1);
    el.textContent = '';
    _chatSugg.forEach((t, idx) => {
        const b = document.createElement('div');
        b.className = 'chat-sugg' + (idx === _chatSuggIdx ? ' active' : '');
        b.textContent = t.kind === 'emoji' ? t.e + '  ' + t.n : (t.kind === 'user' ? '@ ' : '# 📋 ') + t.label;
        b.addEventListener('mousedown', e => { e.preventDefault(); _chatSuggestPick(idx); });
        el.appendChild(b);
    });
    el.style.display = 'block';
}

function _chatSuggestPick(idx) {
    const input = document.getElementById('teamChatInput');
    const t = _chatSugg[idx];
    if (!input || !t) return;
    const pos = input.selectionStart;
    if (t.kind === 'emoji') {
        const head = input.value.slice(0, pos).replace(/:[^\s:]*$/, '');
        input.value = head + t.e + input.value.slice(pos);
        input.selectionStart = input.selectionEnd = head.length + t.e.length;
        if (typeof _chatEmojiRemember === 'function') _chatEmojiRemember(t.e);
        _chatSuggestHide();
        input.focus();
        return;
    }
    const before = input.value.slice(0, pos).replace(/([@#])[^\s@#]*$/, '');
    const ins = t.sym + t.label + ' ';
    input.value = before + ins + input.value.slice(pos);
    input.selectionStart = input.selectionEnd = before.length + ins.length;
    _chatSuggestHide();
    input.focus();
}

function _chatWatchMembers() {
    if (_chatMembersStop) { try { _chatMembersStop(); } catch (e) { /* sans conséquence */ } }
    _chatMembersStop = window._firebaseOnValue(window._firebaseRef(window._firebaseDb, teamPath('members')), snap => {
        const v = snap.val() || {};
        _chatMembers = {};
        Object.keys(v).forEach(uid => {
            const n = (v[uid] && (v[uid].name || String(v[uid].email || '').split('@')[0])) || '';
            if (n) _chatMembers[uid] = String(n).slice(0, 60);
        });
        _chatRender();
    }, () => { _chatMembers = {}; });
}

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
function _chatBeep(tagged) {
    try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        if (!_chatAudio) _chatAudio = new AC();
        if (_chatAudio.state === 'suspended') _chatAudio.resume();
        const t0 = _chatAudio.currentTime;
        // Message ordinaire : « ding » doux à deux notes. Message qui me cite : quatre notes
        // montantes, plus aiguës et plus longues, impossibles à confondre.
        const notes = tagged ? [[784, 0], [988, 0.15], [1319, 0.30], [1568, 0.45]] : [[880, 0], [1175, 0.14]];
        notes.forEach(([f, dt]) => {
            const o = _chatAudio.createOscillator(), g = _chatAudio.createGain();
            o.type = tagged ? 'triangle' : 'sine'; o.frequency.value = f;
            g.gain.setValueAtTime(0.0001, t0 + dt);
            g.gain.exponentialRampToValueAtTime(tagged ? 0.28 : 0.18, t0 + dt + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + (tagged ? 0.32 : 0.22));
            o.connect(g); g.connect(_chatAudio.destination);
            o.start(t0 + dt); o.stop(t0 + dt + (tagged ? 0.35 : 0.25));
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
        '<div id="teamChatResize" title="Glisser pour redimensionner (double-clic : taille initiale)"></div>' +
        '<div class="chat-head"><span>💬 Chat de l\'équipe</span>' +
        '<span><button type="button" id="teamChatSound" aria-label="Son des notifications">🔔</button>' +
        '<button type="button" id="teamChatClose" aria-label="Fermer">✕</button></span></div>' +
        '<div id="teamChatPresence" style="display:none"></div>' +
        '<div id="teamChatList"></div>' +
        '<div id="teamChatError" style="display:none"></div>' +
        '<div id="teamChatSuggest" style="display:none"></div>' +
        '<div id="teamChatAttach" style="display:none"></div>' +
        '<div id="teamChatEmoji" style="display:none"></div>' +
        '<form id="teamChatForm"><button type="button" id="teamChatClip" title="Joindre un fichier (ou coller / glisser une image) — 50 Mo max">📎</button>' +
        '<input type="file" id="teamChatFile" hidden><button type="button" id="teamChatEmojiBtn" title="Émoticônes">😀</button><textarea id="teamChatInput" rows="2" maxlength="' + CHAT_MAX_LEN +
        '" placeholder="Message… (@membre, #session — Entrée pour envoyer)"></textarea>' +
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
    if (typeof _chatAttachInit === 'function') _chatAttachInit();
    if (typeof _chatEmojiInit === 'function') _chatEmojiInit();
    _chatResizeInit();
    const inp = document.getElementById('teamChatInput');
    inp.addEventListener('input', e => {
        if (typeof _chatEmojiAuto === 'function') _chatEmojiAuto(e);
        _chatSuggIdx = 0; _chatSuggestUpdate();
    });
    inp.addEventListener('click', _chatSuggestUpdate);
    inp.addEventListener('blur', () => setTimeout(_chatSuggestHide, 120));
    inp.addEventListener('keydown', e => {
        if (_chatSugg.length) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                _chatSuggIdx = (_chatSuggIdx + (e.key === 'ArrowDown' ? 1 : _chatSugg.length - 1)) % _chatSugg.length;
                _chatSuggestUpdate();
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); _chatSuggestPick(_chatSuggIdx); return; }
            if (e.key === 'Escape') { e.preventDefault(); _chatSuggestHide(); return; }
        }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatSend(); }
    });
}

// Redimensionnement : la poignée est en haut à gauche car le panneau est ancré en bas à droite
const CHAT_SIZE_KEY = 'lmuChatSize';
function _chatApplySize(w, h) {
    const panel = document.getElementById('teamChatPanel');
    if (!panel) return;
    if (!w || !h) { panel.style.width = ''; panel.style.height = ''; return; }
    panel.style.width = Math.max(280, Math.min(w, window.innerWidth - 32)) + 'px';
    panel.style.height = Math.max(300, Math.min(h, window.innerHeight - 110)) + 'px';
}
function _chatResizeInit() {
    const panel = document.getElementById('teamChatPanel');
    const grip = document.getElementById('teamChatResize');
    if (!panel || !grip) return;
    try {
        const s = JSON.parse(localStorage.getItem(CHAT_SIZE_KEY) || 'null');
        if (s && s.w && s.h) _chatApplySize(s.w, s.h);
    } catch (e) { /* taille par défaut */ }
    grip.addEventListener('pointerdown', e => {
        e.preventDefault();
        const x0 = e.clientX, y0 = e.clientY;
        const w0 = panel.offsetWidth, h0 = panel.offsetHeight;
        grip.setPointerCapture(e.pointerId);
        const move = ev => _chatApplySize(w0 + (x0 - ev.clientX), h0 + (y0 - ev.clientY));
        const up = () => {
            grip.removeEventListener('pointermove', move);
            grip.removeEventListener('pointerup', up);
            grip.removeEventListener('pointercancel', up);
            try { localStorage.setItem(CHAT_SIZE_KEY, JSON.stringify({ w: panel.offsetWidth, h: panel.offsetHeight })); } catch (err) { /* sans conséquence */ }
        };
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', up);
        grip.addEventListener('pointercancel', up);
    });
    grip.addEventListener('dblclick', () => {
        _chatApplySize(0, 0);
        try { localStorage.removeItem(CHAT_SIZE_KEY); } catch (e) { /* sans conséquence */ }
    });
}

function _chatSetOpen(open) {
    _chatOpen = open;
    const panel = document.getElementById('teamChatPanel');
    if (panel) panel.style.display = open ? 'flex' : 'none';
    if (open) {
        if (typeof _vSetOpen === 'function') _vSetOpen(false);   // un seul panneau à la fois
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
    const unreadTag = _chatOpen ? 0 : msgs.filter(m => m.t > seen && _chatIsForMe(m, me)).length;
    const badge = document.getElementById('teamChatBadge');
    if (badge) {
        const n = unread > 99 ? '99+' : String(unread);
        badge.textContent = unreadTag ? '@' + n : n;
        badge.classList.toggle('tagged', unreadTag > 0);
        badge.style.display = unread ? 'inline-block' : 'none';
    }
    // Compteur dans le titre de l'onglet + animation quand un nouveau message arrive
    if (_chatBaseTitle === null) _chatBaseTitle = document.title.replace(/^\(\d+\+?\) /, '');
    document.title = (unread ? `(${unreadTag ? '@' : ''}${unread > 99 ? '99+' : unread}) ` : '') + _chatBaseTitle;
    if (unread > _chatLastUnread || unreadTag > _chatLastUnreadTag) {
        const t = document.getElementById('teamChatToggle');
        if (t) {
            t.classList.remove('chat-ping', 'chat-ping-tag'); void t.offsetWidth;
            t.classList.add(unreadTag > _chatLastUnreadTag ? 'chat-ping-tag' : 'chat-ping');
        }
    }
    _chatLastUnread = unread;
    _chatLastUnreadTag = unreadTag;

    // Son : un message d'un autre membre plus récent que tous ceux déjà vus
    const others = msgs.filter(m => m.uid !== me);
    const newest = others.length ? others[others.length - 1].t : 0;
    if (_chatReady && newest > _chatLastOtherTs && _chatSoundOn()) {
        _chatBeep(others.some(m => m.t > _chatLastOtherTs && _chatIsForMe(m, me)));
    }
    if (newest > _chatLastOtherTs) _chatLastOtherTs = newest;
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
        row.className = 'chat-msg' + (m.uid === me ? ' mine' : '') + (_chatIsForMe(m, me) ? ' tagged' : '');
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
        _chatFillBody(body, m, me);
        if (m.file && typeof _chatFillFile === 'function') _chatFillFile(body, m);
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
    const raw = input.value.trim();
    const text = (typeof _chatEmojiAutoEnd === 'function' ? _chatEmojiAutoEnd(raw) : raw).slice(0, CHAT_MAX_LEN);
    const hasFile = typeof _chatPending !== 'undefined' && !!_chatPending;
    if (!text && !hasFile) return;
    if (_chatUploading) return;
    if (Date.now() - _chatLastSend < 800) return;   // anti-rafale
    _chatLastSend = Date.now();
    _chatError('');
    input.disabled = true;
    let fileMeta = null;
    try {
        const db = window._firebaseDb, ref = window._firebaseRef;
        const name = await _chatName(user);
        if (hasFile) {
            try { fileMeta = await _chatUploadPending(user); }
            catch (e) {
                console.error('Chat : envoi du fichier impossible', e);
                _chatError("Fichier non envoyé (connexion, taille ≤ 50 Mo, ou stockage non activé). Réessayez.");
                return;
            }
        }
        // Réserve l'emplacement : le compteur avance de façon atomique (deux envois
        // simultanés n'obtiennent pas le même emplacement).
        let slot = 0;
        const res = await window._firebaseRunTransaction(ref(db, teamPath('chat/next')), cur => {
            const n = (Number.isInteger(cur) && cur >= 0 && cur < CHAT_SLOTS) ? cur : 0;
            slot = n;
            return (n + 1) % CHAT_SLOTS;
        });
        if (!res.committed) throw new Error('compteur non validé');
        const replaced = _chatMsgs[slot];   // message qui quitte le tampon circulaire
        const msg = { uid: user.uid, name, text, ts: window._firebaseServerTimestamp() };
        if (fileMeta) msg.file = fileMeta;
        await window._firebaseSet(ref(db, teamPath(`chat/m/${slot}`)), msg);
        input.value = '';
        if (hasFile) _chatAttachClear();
        if (replaced && replaced.file && typeof _chatDeleteFile === 'function') _chatDeleteFile(replaced.file.path);
    } catch (e) {
        console.error('Chat : envoi impossible', e);
        _chatError("Message non envoyé (connexion ou droits). Réessayez.");
        // Le message n'a pas été publié : on ne laisse pas un fichier orphelin dans le stockage
        if (fileMeta && typeof _chatDeleteFile === 'function') { _chatDeleteFile(fileMeta.path); fileMeta = null; _chatAttachRender(); }
    } finally {
        input.disabled = false;
        input.focus();
    }
}

function chatDelete(slot) {
    if (window._teamRole !== 'admin') return;
    const f = _chatMsgs[slot] && _chatMsgs[slot].file;
    if (f && typeof _chatDeleteFile === 'function') _chatDeleteFile(f.path);
    window._firebaseRemove(window._firebaseRef(window._firebaseDb, teamPath(`chat/m/${slot}`)))
        .catch(e => { console.error('Chat : suppression impossible', e); _chatError('Suppression refusée.'); });
}

function stopTeamChat() {
    if (_chatStop) { try { _chatStop(); } catch (e) { /* sans conséquence */ } }
    _chatStop = null;
    _chatMsgs = {};
    _chatReady = false; _chatLastOtherTs = 0; _chatLastUnread = 0; _chatLastUnreadTag = 0;
    if (_chatMembersStop) { try { _chatMembersStop(); } catch (e) { /* sans conséquence */ } }
    _chatMembersStop = null; _chatMembers = {};
    if (typeof _chatAttachClear === 'function') _chatAttachClear();
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
    _chatWatchMembers();
    const r = window._firebaseRef(window._firebaseDb, teamPath('chat/m'));
    _chatStop = window._firebaseOnValue(r, snap => {
        _chatMsgs = snap.val() || {};
        _chatRender();
        _chatReady = true;   // à partir d'ici, un message plus récent déclenche le son
    }, err => console.warn('Chat : lecture impossible', err && err.code));
}
