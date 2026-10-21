/* ══════════════════════════════════════════════════════════════
   team-voice.js — Salons vocaux par session (WebRTC, sans serveur audio)

   Chaque session a un salon, tous listés dans la bulle 🎙️ : on rejoint celui qu'on veut,
   quelle que soit la session ouverte dans l'appli. L'audio passe directement d'un
   navigateur à l'autre (maillage : chacun est relié à chacun, prévu pour ~6 personnes
   maximum par salon). Firebase ne sert qu'à se retrouver :
     teams/{équipe}/voice/{session}/{uid}             → { name, ts, n, mu? }  présence
     teams/{équipe}/voiceSig/{session}/{dest}/{src}/{id} → { t, d, n }         signalisation
   Le destinataire lit sa boîte, traite le message puis le supprime.
   Pour chaque paire, celui dont l'uid est le plus grand envoie l'offre (pas de collision).
   ══════════════════════════════════════════════════════════════ */

// Serveurs STUN publics (gratuits). Le relais TURN (identifiants) n'est PAS dans le code,
// qui est public : un admin le saisit dans le panneau vocal et il est stocké dans
// teams/{équipe}/voiceIce (lisible par les membres seulement).
const VOICE_ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
];
// Débit de la voix : généreux sur un lien direct (gratuit), serré sur un lien relayé par
// le TURN (quota limité). Dans les deux cas, coupure des silences (DTX).
const VOICE_DIRECT_BITRATE = 192000;
const VOICE_RELAY_BITRATE  = 24000;
const VOICE_BEAT_MS  = 60 * 1000;
const VOICE_STALE_MS = 3 * 60 * 1000;

// Réduction du bruit : 0 = aucune, 1 = normale, 2 = forte.
// Avec RNNoise (réseau de neurones, dossier vendor/rnnoise) : « forte » coupe aussi les
// moments où la parole est improbable. Sans RNNoise (chargement impossible), repli sur le
// filtre du navigateur + une porte de bruit simple. Seuils = volume RMS (0..1) sous lequel
// la porte de bruit coupe le micro.
const VOICE_NOISE_THRESHOLDS = [0, 0.006, 0.015];         // repli, sans RNNoise
const VOICE_NOISE_THRESHOLDS_RN = [0, 0.002, 0.005];      // après RNNoise
const VOICE_RNNOISE_VAD = [0, 0, 0.6];                    // seuil de probabilité de parole
const VOICE_RNNOISE_URL = 'vendor/rnnoise/rnnoise-worklet.js?v=1';

let _vWatchStop = null;      // écoute de tous les salons de l'équipe
let _vData = {};             // session → uid → { name, ts, n, mu }
let _vViewSid = null;        // session affichée dans l'appli
let _vTeam = null;
let _vErr = '';
let _vJoinTok = 0;

// Connexion active (null si on n'est dans aucun salon)
let _vc = null;              // { sid, team, nonce, ice, stream, raw, ac, gate, peers, stops, myRef, name, muted, seen, levels }

function _vNoiseMode() {
    try { const v = Number(localStorage.getItem('lmuVoiceNoise')); return v === 0 || v === 2 ? v : 1; } catch (e) { return 1; }
}

/* ── Porte de bruit : s'exécute dans le fil audio (AudioWorklet), donc continue de
      fonctionner même quand la page est en arrière-plan pendant la course ── */
const VOICE_GATE_SRC = `
class LmuGate extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'threshold', defaultValue: 0.006, minValue: 0, maxValue: 1 }]; }
  constructor() { super(); this.gain = 0; this.hold = 0; }
  process(inputs, outputs, params) {
    const inp = inputs[0], out = outputs[0];
    if (!inp || !inp.length || !out || !out.length) return true;
    const n = inp[0].length;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += inp[0][i] * inp[0][i];
    const rms = Math.sqrt(sum / n);
    if (rms > params.threshold[0]) this.hold = sampleRate * 0.3; else this.hold -= n;
    const target = this.hold > 0 ? 1 : 0;
    const tau = target > this.gain ? 0.004 : 0.12;
    const g0 = this.gain;
    const g1 = g0 + (target - g0) * (1 - Math.exp(-n / (sampleRate * tau)));
    for (let c = 0; c < out.length; c++) {
      const src = inp[c] || inp[0], dst = out[c];
      for (let i = 0; i < n; i++) dst[i] = src[i] * (g0 + (g1 - g0) * (i / n));
    }
    this.gain = g1;
    return true;
  }
}
registerProcessor('lmu-gate', LmuGate);
`;

// Charge RNNoise (AudioWorklet) ; renvoie le nœud, ou null si le chargement échoue
async function _vLoadRnnoise(ac) {
    try {
        if (!ac.audioWorklet) return null;
        await ac.audioWorklet.addModule(new URL(VOICE_RNNOISE_URL, document.baseURI).href);
        const node = new AudioWorkletNode(ac, 'lmu-rnnoise', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        const ok = await new Promise(res => {
            const t = setTimeout(() => res(false), 6000);
            node.port.onmessage = e => { clearTimeout(t); res(!!(e.data && e.data.ready)); };
        });
        if (!ok) { node.disconnect(); return null; }
        return node;
    } catch (e) {
        console.warn('Vocal : RNNoise indisponible, filtre simple utilisé', e && e.message);
        return null;
    }
}

function _vApplyNoise(c, mode) {
    if (c.rn) {
        c.rn.parameters.get('bypass').value = mode === 0 ? 1 : 0;
        c.rn.parameters.get('vad').value = VOICE_RNNOISE_VAD[mode];
    }
    if (c.gate) c.gate.parameters.get('threshold').value = (c.rn ? VOICE_NOISE_THRESHOLDS_RN : VOICE_NOISE_THRESHOLDS)[mode];
    // Le filtre du navigateur fait double emploi avec RNNoise (et l'abîme) : on ne le garde qu'en repli
    c.raw.getAudioTracks().forEach(t => t.applyConstraints({ noiseSuppression: !c.rn && mode !== 0 }).catch(() => {}));
}

// Micro → filtre passe-haut (grondements) → RNNoise → porte de bruit → flux envoyé aux autres
async function _vBuildChain(ac, raw, mode) {
    const src = ac.createMediaStreamSource(raw);
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 100; hp.Q.value = 0.7;
    const dest = ac.createMediaStreamDestination();
    dest.channelCount = 1;
    const rn = await _vLoadRnnoise(ac);
    let gate = null;
    try {
        if (!ac.audioWorklet) throw new Error('AudioWorklet indisponible');
        const url = URL.createObjectURL(new Blob([VOICE_GATE_SRC], { type: 'application/javascript' }));
        try { await ac.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
        gate = new AudioWorkletNode(ac, 'lmu-gate', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    } catch (e) {
        console.warn('Vocal : porte de bruit indisponible', e && e.message);
        gate = null;
    }
    let last = src;
    [hp, rn, gate].forEach(n => { if (n) { last.connect(n); last = n; } });
    last.connect(dest);
    const chain = { stream: dest.stream, gate, rn, raw };
    _vApplyNoise(chain, mode);
    return chain;
}

function voiceSetNoise(mode) {
    mode = mode === 0 || mode === 2 ? mode : 1;
    try { localStorage.setItem('lmuVoiceNoise', String(mode)); } catch (e) { /* stockage indisponible */ }
    if (_vc) _vApplyNoise(_vc, mode);
}

/* ── Relais TURN : texte saisi par l'admin = adresse https d'une API d'identifiants
      (ex. Metered : https://xxx.metered.live/api/v1/turn/credentials?apiKey=…)
      ou liste JSON de serveurs [{"urls":"turn:…","username":"…","credential":"…"}] ── */
function _vCleanIce(list) {
    if (!Array.isArray(list)) return [];
    const okUrl = u => typeof u === 'string' && /^(stun|turn|turns):/i.test(u);
    return list.slice(0, 12).filter(s => s && (Array.isArray(s.urls) ? s.urls.length && s.urls.every(okUrl) : okUrl(s.urls)))
        .map(s => {
            const o = { urls: s.urls };
            if (typeof s.username === 'string') o.username = s.username;
            if (typeof s.credential === 'string') o.credential = s.credential;
            return o;
        });
}
async function _vLoadIce() {
    let extra = [];
    try {
        const raw = (await window._firebaseGet(_vRef(`teams/${window._teamId}/voiceIce`))).val();
        if (typeof raw === 'string' && raw.trim()) {
            const txt = raw.trim();
            if (/^https:\/\//i.test(txt)) {
                const r = await fetch(txt);
                if (r.ok) extra = _vCleanIce(await r.json());
            } else {
                extra = _vCleanIce(JSON.parse(txt));
            }
        }
    } catch (e) { console.warn('Vocal : relais TURN non chargé', e && e.message); }
    return { servers: VOICE_ICE_SERVERS.concat(extra), hasTurn: extra.some(s => [].concat(s.urls).some(u => /^turns?:/i.test(u))) };
}

// Ajoute au codec Opus de la description SDP : coupure des silences + débit maximal
function _vTuneSdp(sdp) {
    const m = /a=rtpmap:(\d+) opus\/48000\/2/i.exec(sdp || '');
    if (!m) return sdp;
    const extra = 'usedtx=1;maxaveragebitrate=' + VOICE_DIRECT_BITRATE;
    const re = new RegExp('a=fmtp:' + m[1] + ' ([^\\r\\n]*)');
    if (re.test(sdp)) {
        return sdp.replace(re, (all, params) => {
            const keep = params.split(';').filter(x => x && !/^(usedtx|maxaveragebitrate)=/.test(x));
            return 'a=fmtp:' + m[1] + ' ' + keep.concat(extra).join(';');
        });
    }
    return sdp.replace(m[0], m[0] + '\r\na=fmtp:' + m[1] + ' ' + extra);
}

// Plafonne le débit envoyé à ce participant
async function _vSetRate(peer, bps) {
    for (const s of peer.pc.getSenders()) {
        if (!s.track || s.track.kind !== 'audio') continue;
        try {
            const p = s.getParameters();
            if (!p.encodings || !p.encodings.length) p.encodings = [{}];
            p.encodings[0].maxBitrate = bps;
            await s.setParameters(p);
            peer.rate = bps;
        } catch (e) { console.warn('Vocal : débit non réglé', e && e.message); }
    }
}

// Le lien avec ce participant est-il direct ou relayé par le serveur TURN ?
async function _vRoute(peer) {
    try {
        const stats = await peer.pc.getStats();
        const by = {};
        let pair = null;
        stats.forEach(r => { by[r.id] = r; });
        stats.forEach(r => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = by[r.selectedCandidatePairId]; });
        if (!pair) stats.forEach(r => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
        if (!pair) return null;
        const l = by[pair.localCandidateId], r = by[pair.remoteCandidateId];
        return ((l && l.candidateType === 'relay') || (r && r.candidateType === 'relay')) ? 'relay' : 'direct';
    } catch (e) { return null; }
}
// Détecte le type de lien, puis règle le débit en conséquence (relayé : économe, direct : généreux)
async function _vApplyRoute(peer) {
    const route = await _vRoute(peer);
    if (!route || !_vc || _vc.peers[peer.uid] !== peer) return false;
    const want = route === 'direct' ? VOICE_DIRECT_BITRATE : VOICE_RELAY_BITRATE;
    const changed = route !== peer.route;
    peer.route = route;
    if (peer.rate !== want) await _vSetRate(peer, want);
    return changed;
}
async function _vPollRoutes() {
    if (!_vc) return;
    let changed = false;
    for (const uid of Object.keys(_vc.peers)) {
        const peer = _vc.peers[uid];
        if (peer.pc.connectionState !== 'connected') continue;
        if (await _vApplyRoute(peer)) changed = true;
    }
    if (changed) _vRender();
}

function _vUid() { return window._firebaseAuth?.currentUser?.uid; }
function _vRef(path) { return window._firebaseRef(window._firebaseDb, path); }

// Liste des salons = toutes les sessions de l'équipe (+ salons dont la session n'est plus listée)
function _vSessions() {
    const out = [];
    Array.from(document.getElementById('sessionSelect')?.options || []).forEach(o => {
        if (!o.value) return;
        const label = o.textContent.replace(/^\s*[^\p{L}\p{N}]+/u, '').trim();
        if (label) out.push({ id: o.value, label });
    });
    Object.keys(_vData).forEach(sid => {
        if (!out.some(s => s.id === sid) && _vPeopleOf(sid).length) out.push({ id: sid, label: 'Session (' + sid.slice(-6) + ')' });
    });
    return out;
}
function _vSessionLabel(sid) {
    const s = _vSessions().find(x => x.id === sid);
    return s ? s.label : 'Session';
}

/* ── Interface ── */
function _vEnsureUI() {
    if (document.getElementById('teamVoicePanel')) return;
    const wrap = document.createElement('div');
    wrap.id = 'teamVoiceRoot';
    wrap.innerHTML =
        '<button id="teamVoiceToggle" type="button" title="Salons vocaux" aria-label="Ouvrir les salons vocaux">🎙️' +
        '<span id="teamVoiceCount" style="display:none"></span></button>' +
        '<div id="teamVoicePanel" style="display:none">' +
        '<div class="voice-head"><span>🎙️ Salons vocaux</span>' +
        '<button type="button" id="teamVoiceClose" aria-label="Fermer">✕</button></div>' +
        '<div id="teamVoiceList"></div>' +
        '<div id="teamVoiceError" style="display:none"></div>' +
        '<div class="voice-actions"><button type="button" id="teamVoiceMute" style="display:none"></button></div>' +
        '<div id="teamVoiceNoiseRow"><label for="teamVoiceNoise">🔇 Réduction du bruit</label>' +
        '<select id="teamVoiceNoise"><option value="0">Désactivée</option><option value="1">Normale</option>' +
        '<option value="2">Forte</option></select></div>' +
        '<div id="teamVoiceAdmin" style="display:none">' +
        '<button type="button" id="teamVoiceAdminToggle">⚙️ Relais réseau (TURN)</button>' +
        '<div id="teamVoiceAdminBox" style="display:none">' +
        '<textarea id="teamVoiceIceInput" rows="3" maxlength="3000" ' +
        'placeholder="Adresse https de l\'API d\'identifiants TURN, ou liste JSON de serveurs"></textarea>' +
        '<div><button type="button" id="teamVoiceIceSave">Enregistrer</button>' +
        '<span id="teamVoiceIceMsg"></span></div></div></div>' +
        '<div id="teamVoiceAudio" style="display:none"></div></div>';
    document.body.appendChild(wrap);
    document.getElementById('teamVoiceToggle').addEventListener('click', () => _vSetOpen(!_vOpen()));
    document.getElementById('teamVoiceClose').addEventListener('click', () => _vSetOpen(false));
    document.getElementById('teamVoiceMute').addEventListener('click', voiceToggleMute);
    const noise = document.getElementById('teamVoiceNoise');
    noise.value = String(_vNoiseMode());
    noise.addEventListener('change', () => voiceSetNoise(Number(noise.value)));
    document.getElementById('teamVoiceAdminToggle').addEventListener('click', _vAdminOpen);
    document.getElementById('teamVoiceIceSave').addEventListener('click', _vAdminSave);
    // La liste des sessions se charge après coup : on redessine quand elle change
    const sel = document.getElementById('sessionSelect');
    if (sel) new MutationObserver(() => _vRender()).observe(sel, { childList: true });
}

async function _vAdminOpen() {
    const box = document.getElementById('teamVoiceAdminBox');
    const show = box.style.display === 'none';
    box.style.display = show ? 'block' : 'none';
    if (!show) return;
    try {
        const v = (await window._firebaseGet(_vRef(`teams/${window._teamId}/voiceIce`))).val();
        document.getElementById('teamVoiceIceInput').value = typeof v === 'string' ? v : '';
    } catch (e) { /* champ laissé vide */ }
}

async function _vAdminSave() {
    const msg = document.getElementById('teamVoiceIceMsg');
    const txt = document.getElementById('teamVoiceIceInput').value.trim();
    try {
        if (txt) {
            if (!/^https:\/\//i.test(txt) && !_vCleanIce(JSON.parse(txt)).length) throw new Error('aucun serveur valide');
            await window._firebaseSet(_vRef(`teams/${window._teamId}/voiceIce`), txt);
        } else {
            await window._firebaseRemove(_vRef(`teams/${window._teamId}/voiceIce`));
        }
        msg.textContent = ' ✔ Enregistré (pris en compte à la prochaine connexion au vocal)';
    } catch (e) {
        msg.textContent = ' ✖ Refusé : adresse https ou JSON valide attendu';
    }
}

function _vOpen() { return document.getElementById('teamVoicePanel')?.style.display === 'flex'; }

function _vSetOpen(open) {
    const p = document.getElementById('teamVoicePanel');
    if (!p) return;
    p.style.display = open ? 'flex' : 'none';
    if (open) {
        if (typeof _chatSetOpen === 'function') _chatSetOpen(false);   // un seul panneau à la fois
        _vRender();
    }
}

function _vSetError(msg) {
    _vErr = msg || '';
    const el = document.getElementById('teamVoiceError');
    if (el) { el.textContent = _vErr; el.style.display = _vErr ? 'block' : 'none'; }
}

function _vPeopleOf(sid) {
    const now = Date.now(), me = _vUid();
    const room = _vData[sid] || {};
    return Object.keys(room)
        .map(uid => Object.assign({ uid }, room[uid]))
        .filter(p => p && typeof p.ts === 'number' && (p.uid === me || now - p.ts < VOICE_STALE_MS))
        .sort((a, b) => (a.uid === me ? -1 : b.uid === me ? 1 : String(a.name).localeCompare(String(b.name))));
}

function _vRender() {
    const toggle = document.getElementById('teamVoiceToggle');
    if (!toggle) return;
    const me = _vUid();
    const sessions = _vSessions();

    let total = 0;
    sessions.forEach(s => { total += _vPeopleOf(s.id).length; });
    const count = document.getElementById('teamVoiceCount');
    count.textContent = String(total);
    count.style.display = total ? 'inline-block' : 'none';
    toggle.classList.toggle('connected', !!_vc);
    document.getElementById('teamVoiceAdmin').style.display = window._teamRole === 'admin' ? 'block' : 'none';

    const list = document.getElementById('teamVoiceList');
    list.textContent = '';
    if (!sessions.length) {
        const d = document.createElement('div');
        d.className = 'voice-empty';
        d.textContent = 'Aucune session : créez-en une pour avoir un salon vocal.';
        list.appendChild(d);
    }
    sessions.forEach(s => {
        const people = _vPeopleOf(s.id);
        const here = !!_vc && _vc.sid === s.id;
        const room = document.createElement('div');
        room.className = 'voice-room' + (here ? ' current' : '') + (s.id === _vViewSid ? ' viewed' : '');

        const head = document.createElement('div');
        head.className = 'voice-room-head';
        const name = document.createElement('span');
        name.textContent = '📋 ' + s.label + (people.length ? ' (' + people.length + ')' : '');
        if (s.id === _vViewSid) name.title = "Session ouverte dans l'appli";
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = here ? '📴 Quitter' : '🎧 Rejoindre';
        btn.className = here ? 'leave' : '';
        btn.addEventListener('click', () => { here ? voiceLeave() : voiceJoin(s.id); });
        head.appendChild(name);
        head.appendChild(btn);
        room.appendChild(head);

        if (!people.length) {
            const e = document.createElement('div');
            e.className = 'voice-empty';
            e.textContent = 'Salon vide';
            room.appendChild(e);
        }
        people.forEach(p => {
            const row = document.createElement('div');
            row.className = 'voice-row' + (p.uid === me ? ' mine' : '');
            row.dataset.uid = p.uid;
            const dot = document.createElement('span');
            dot.className = 'voice-dot';
            const who = document.createElement('b');
            who.textContent = String(p.name || '?').slice(0, 30) + (p.uid === me ? ' (vous)' : '');
            const st = document.createElement('span');
            st.className = 'voice-state';
            const peer = here && _vc.peers[p.uid];
            const bad = peer && (peer.pc.connectionState === 'failed' || peer.pc.iceConnectionState === 'failed');
            const route = peer && peer.route;
            st.textContent = (p.mu ? '🔇' : '') + (bad ? ' ⚠️' : '') +
                (!bad && route ? (route === 'relay' ? ' 🛰️' : ' 🔗') : '');
            if (bad) st.title = 'Connexion impossible avec cette personne (réseau)';
            else if (route === 'relay') st.title = 'Lien relayé par le serveur TURN (consomme le quota du relais)';
            else if (route === 'direct') st.title = 'Lien direct (aucun quota consommé)';
            row.appendChild(dot); row.appendChild(who); row.appendChild(st);
            room.appendChild(row);
        });
        list.appendChild(room);
    });

    const mute = document.getElementById('teamVoiceMute');
    mute.style.display = _vc ? '' : 'none';
    if (_vc) mute.textContent = _vc.muted ? '🔇 Micro coupé (cliquer pour réactiver)' : '🎙️ Micro actif (cliquer pour couper)';
}

/* ── Écoute de tous les salons ── */
function _vWatch() {
    if (_vWatchStop) { try { _vWatchStop(); } catch (e) { /* sans conséquence */ } }
    _vWatchStop = null; _vData = {};
    if (!window._teamId) { _vRender(); return; }
    _vWatchStop = window._firebaseOnValue(_vRef(`teams/${window._teamId}/voice`), snap => {
        _vData = snap.val() || {};
        if (_vc) _vSync();
        _vRender();
    }, () => { _vData = {}; _vRender(); });
}

/* Appelé quand l'utilisateur change de session affichée (simple repère dans la liste) */
function voiceViewSession(sid) {
    _vViewSid = sid || null;
    _vRender();
}

/* ── Participants ↔ connexions ── */
function _vSync() {
    if (!_vc) return;
    const me = _vUid(), now = Date.now();
    const room = _vData[_vc.sid] || {};
    const live = {};
    Object.keys(room).forEach(uid => {
        const p = room[uid];
        if (uid !== me && p && typeof p.ts === 'number' && now - p.ts < VOICE_STALE_MS) live[uid] = p;
    });
    // Départs ou reconnexion (nouveau jeton) : on referme
    Object.keys(_vc.peers).forEach(uid => {
        if (!live[uid] || live[uid].n !== _vc.peers[uid].n) _vClosePeer(uid);
    });
    // Arrivées : si mon uid est le plus grand, c'est moi qui envoie l'offre
    Object.keys(live).forEach(uid => {
        if (!_vc.peers[uid] && me > uid) _vOffer(uid, live[uid].n);
    });
}

function _vMakePeer(uid, n) {
    const pc = new RTCPeerConnection({ iceServers: _vc.ice.servers });
    const peer = { pc, n, uid, queue: [], chain: Promise.resolve(), audio: null, route: null, rate: null };
    _vc.stream.getTracks().forEach(t => pc.addTrack(t, _vc.stream));
    pc.onicecandidate = e => { if (e.candidate) _vSend(uid, 'ice', JSON.stringify(e.candidate)); };
    pc.ontrack = e => {
        if (!peer.audio) {
            peer.audio = document.createElement('audio');
            peer.audio.autoplay = true;
            document.getElementById('teamVoiceAudio')?.appendChild(peer.audio);
        }
        peer.audio.srcObject = e.streams[0];
        peer.audio.play().catch(() => {});
        _vWatchLevel(uid, e.streams[0]);
    };
    const refresh = () => {
        if (_vc && (pc.connectionState === 'failed' || pc.iceConnectionState === 'failed')) {
            _vSetError(_vc.ice.hasTurn
                ? "Connexion impossible avec " + ((_vData[_vc.sid] && _vData[_vc.sid][uid] && _vData[_vc.sid][uid].name) || 'un participant') + " (réseau très restrictif)."
                : "Connexion directe impossible : un admin doit configurer un relais TURN (⚙️ en bas du panneau).");
        }
        // Dès que le lien est établi : débit économe par prudence, puis réglage selon le type de lien
        if (pc.connectionState === 'connected' && peer.rate === null && _vc && _vc.peers[uid] === peer) {
            _vSetRate(peer, VOICE_RELAY_BITRATE).then(() => _vApplyRoute(peer)).then(() => _vRender());
            setTimeout(() => { if (_vc && _vc.peers[uid] === peer) _vApplyRoute(peer).then(c => c && _vRender()); }, 1500);
        }
        _vRender();
    };
    pc.onconnectionstatechange = refresh;
    pc.oniceconnectionstatechange = refresh;
    _vc.peers[uid] = peer;
    return peer;
}

function _vClosePeer(uid) {
    const peer = _vc && _vc.peers[uid];
    if (!peer) return;
    delete _vc.peers[uid];
    try { peer.pc.close(); } catch (e) { /* déjà fermée */ }
    if (peer.audio) { peer.audio.srcObject = null; peer.audio.remove(); }
    _vDropLevel(uid);
}

async function _vOffer(uid, n) {
    const peer = _vMakePeer(uid, n);
    try {
        const offer = await peer.pc.createOffer();
        await peer.pc.setLocalDescription({ type: offer.type, sdp: _vTuneSdp(offer.sdp) });
        _vSend(uid, 'offer', JSON.stringify(peer.pc.localDescription));
    } catch (e) { console.warn('Vocal : offre impossible', e); _vClosePeer(uid); }
}

function _vSend(to, type, data) {
    if (!_vc) return;
    const key = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    window._firebaseSet(_vRef(`teams/${window._teamId}/voiceSig/${_vc.sid}/${to}/${_vUid()}/${key}`),
        { t: type, d: data, n: _vc.nonce }).catch(e => console.warn('Vocal : signal non envoyé', e && e.code));
}

/* ── Boîte de signalisation ── */
function _vInbox(box) {
    if (!_vc || !box) return;
    const items = [];
    Object.keys(box).forEach(from => {
        const msgs = box[from] || {};
        Object.keys(msgs).forEach(k => items.push({ from, k, m: msgs[k] }));
    });
    items.sort((a, b) => a.k < b.k ? -1 : a.k > b.k ? 1 : 0);
    items.forEach(it => {
        const id = it.from + '/' + it.k;
        if (_vc.seen.has(id)) return;
        _vc.seen.add(id);
        window._firebaseRemove(_vRef(`teams/${window._teamId}/voiceSig/${_vc.sid}/${_vUid()}/${it.from}/${it.k}`)).catch(() => {});
        _vHandle(it.from, it.m);
    });
}

function _vHandle(from, m) {
    if (!_vc || !m || typeof m.d !== 'string') return;
    let peer = _vc.peers[from];
    if (m.t === 'offer') {
        if (peer) _vClosePeer(from);           // nouvelle négociation : on repart d'une connexion propre
        peer = _vMakePeer(from, m.n);
    } else if (!peer || peer.n !== m.n) {
        return;                                // réponse/ICE d'une connexion qui n'existe plus
    }
    const p = peer;
    p.chain = p.chain.then(async () => {
        if (!_vc || _vc.peers[from] !== p) return;
        try {
            if (m.t === 'offer') {
                await p.pc.setRemoteDescription(JSON.parse(m.d));
                const ans = await p.pc.createAnswer();
                await p.pc.setLocalDescription({ type: ans.type, sdp: _vTuneSdp(ans.sdp) });
                _vSend(from, 'answer', JSON.stringify(p.pc.localDescription));
                p.queue.splice(0).forEach(c => p.pc.addIceCandidate(c).catch(() => {}));
            } else if (m.t === 'answer') {
                await p.pc.setRemoteDescription(JSON.parse(m.d));
                p.queue.splice(0).forEach(c => p.pc.addIceCandidate(c).catch(() => {}));
            } else if (m.t === 'ice') {
                const c = JSON.parse(m.d);
                if (p.pc.remoteDescription) await p.pc.addIceCandidate(c).catch(() => {});
                else p.queue.push(c);
            }
        } catch (e) { console.warn('Vocal : signal ignoré', m.t, e && e.message); }
    });
}

/* ── Indicateur « parle » (niveau sonore) ── */
function _vWatchLevel(uid, stream) {
    if (!_vc) return;
    _vDropLevel(uid);
    try {
        const src = _vc.ac.createMediaStreamSource(stream);
        const an = _vc.ac.createAnalyser();
        an.fftSize = 512;
        src.connect(an);                       // pas relié à la sortie : analyse seulement
        _vc.levels[uid] = { src, an, buf: new Uint8Array(an.fftSize) };
    } catch (e) { /* indicateur facultatif */ }
}
function _vDropLevel(uid) {
    const l = _vc && _vc.levels[uid];
    if (l) { try { l.src.disconnect(); } catch (e) { /* déjà détaché */ } delete _vc.levels[uid]; }
}
function _vPoll() {
    if (!_vc) return;
    const list = document.getElementById('teamVoiceList');
    Object.keys(_vc.levels).forEach(uid => {
        const l = _vc.levels[uid];
        l.an.getByteTimeDomainData(l.buf);
        let max = 0;
        for (let i = 0; i < l.buf.length; i++) max = Math.max(max, Math.abs(l.buf[i] - 128));
        const row = list && list.querySelector(`.voice-row[data-uid="${uid}"]`);
        if (row) row.classList.toggle('speaking', max > 8);
    });
}

/* ── Rejoindre / quitter ── */
async function voiceJoin(sid) {
    sid = sid || _vViewSid;
    const user = window._firebaseAuth?.currentUser;
    if (!user || !sid || !window._teamId) { _vSetError("Choisissez un salon."); return; }
    if (_vc && _vc.sid === sid) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof RTCPeerConnection === 'undefined') {
        _vSetError("Ce navigateur ne permet pas le vocal (HTTPS et micro requis).");
        return;
    }
    if (_vc) voiceLeave();                      // changement de salon : on quitte l'ancien
    const tok = ++_vJoinTok;
    _vSetError('');
    const mode = _vNoiseMode();
    let raw;
    try {
        raw = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: mode !== 0, autoGainControl: true }, video: false
        });
    } catch (e) {
        _vSetError(e && e.name === 'NotAllowedError'
            ? "Accès au micro refusé : autorisez-le dans le navigateur puis réessayez."
            : "Micro introuvable ou indisponible.");
        return;
    }
    const abort = (ac) => { raw.getTracks().forEach(t => t.stop()); if (ac) { try { ac.close(); } catch (e) { /* déjà fermé */ } } _vRender(); };
    if (tok !== _vJoinTok || _vc) { abort(); return; }

    const AC = window.AudioContext || window.webkitAudioContext;
    const ac = new AC({ sampleRate: 48000 });     // RNNoise travaille à 48 kHz
    const chain = await _vBuildChain(ac, raw, mode);
    const ice = await _vLoadIce();
    if (tok !== _vJoinTok || _vc) { abort(ac); return; }

    const team = window._teamId;
    const name = (typeof _chatName === 'function')
        ? await _chatName(user)
        : ((user.email || '').split('@')[0] || 'Membre');
    if (tok !== _vJoinTok || _vc) { abort(ac); return; }
    const nonce = Math.random().toString(36).slice(2, 12);
    const myRef = _vRef(`teams/${team}/voice/${sid}/${user.uid}`);
    _vc = { sid, team, nonce, ice, stream: chain.stream, raw, ac, gate: chain.gate, rn: chain.rn, peers: {}, stops: [], myRef, name,
            muted: false, seen: new Set(), levels: {} };
    _vWatchLevel(user.uid, chain.stream);

    const beat = () => window._firebaseSet(myRef, { name, ts: Date.now(), n: nonce, mu: _vc ? _vc.muted : false }).catch(() => {});
    _vc.beat = beat;

    // Boîte de signalisation : on la vide, puis on l'écoute
    const inboxRef = _vRef(`teams/${team}/voiceSig/${sid}/${user.uid}`);
    await window._firebaseRemove(inboxRef).catch(() => {});
    if (!_vc || _vc.nonce !== nonce) return;
    _vc.stops.push(window._firebaseOnValue(inboxRef, snap => _vInbox(snap.val()), () => {}));

    // (Re)connexion au serveur : on se (re)déclare et on programme le retrait automatique
    _vc.stops.push(window._firebaseOnValue(_vRef('.info/connected'), snap => {
        if (snap.val() !== true || !_vc) return;
        window._firebaseOnDisconnect(myRef).remove().then(beat).catch(() => {});
    }));
    const timer = setInterval(() => { beat(); _vSync(); _vRender(); }, VOICE_BEAT_MS);
    const poll = setInterval(_vPoll, 200);
    const routes = setInterval(_vPollRoutes, 5000);
    _vc.stops.push(() => clearInterval(timer), () => clearInterval(poll), () => clearInterval(routes),
        () => { window._firebaseOnDisconnect(myRef).cancel().catch(() => {}); });
    _vRender();
}

function voiceLeave() {
    const c = _vc;
    if (!c) return;
    ++_vJoinTok;
    c.stops.forEach(fn => { try { fn(); } catch (e) { /* sans conséquence */ } });
    Object.keys(c.peers).forEach(_vClosePeer);
    c.raw.getTracks().forEach(t => t.stop());
    c.stream.getTracks().forEach(t => t.stop());
    try { c.ac.close(); } catch (e) { /* déjà fermé */ }
    window._firebaseRemove(c.myRef).catch(() => {});
    window._firebaseRemove(_vRef(`teams/${c.team}/voiceSig/${c.sid}/${_vUid()}`)).catch(() => {});
    _vc = null;
    _vRender();
}

function voiceToggleMute() {
    if (!_vc) return;
    _vc.muted = !_vc.muted;
    _vc.stream.getAudioTracks().forEach(t => { t.enabled = !_vc.muted; });
    if (_vc.beat) _vc.beat();
    _vRender();
}

function stopTeamVoice() {
    voiceLeave();
    if (_vWatchStop) { try { _vWatchStop(); } catch (e) { /* sans conséquence */ } }
    _vWatchStop = null; _vData = {};
    document.getElementById('teamVoiceRoot')?.remove();
}

function startTeamVoice() {
    if (!window._firebaseDb || !window._teamId || !window._firebaseAuth?.currentUser) return;
    if (_vTeam === window._teamId && document.getElementById('teamVoiceRoot')) return;
    stopTeamVoice();
    _vTeam = window._teamId;
    _vEnsureUI();
    _vViewSid = window._presenceSession || null;
    _vWatch();
    _vRender();
}
