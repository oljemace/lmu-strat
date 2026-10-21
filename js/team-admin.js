/* ══════════════════════════════════════════════
   GESTION D'ÉQUIPE — membres, rôles, invitations
   Tous les membres voient la liste des membres ; seul un admin peut inviter,
   changer un rôle ou retirer quelqu'un. Ces droits sont appliqués par les
   règles Firebase : masquer un bouton ici n'est qu'un confort d'affichage.
   Les noms/emails viennent d'autres utilisateurs : tout est construit avec
   textContent (jamais innerHTML) pour éviter toute injection.
   ══════════════════════════════════════════════ */

let _teamPanelUnsubs = [];
let _teamPanelMembers = {};
let _teamPanelInvites = {};

const INVITE_DURATIONS = [
    { days: 1,  label: '1 jour' },
    { days: 7,  label: '7 jours' },
    { days: 30, label: '30 jours' },
];

/** Petit constructeur DOM : h('div', {style:'…', onclick: fn}, enfants…) */
function _h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
        if (k === 'style') el.style.cssText = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (v !== false && v != null) el.setAttribute(k, v);
    });
    children.flat().forEach(c => el.append(c instanceof Node ? c : document.createTextNode(String(c ?? ''))));
    return el;
}

const _BTN = 'padding:5px 12px;border-radius:7px;border:1px solid #555;background:transparent;color:var(--text-2);cursor:pointer;font-size:0.85em;';
const _BTN_GREEN = 'padding:6px 14px;border-radius:7px;border:none;background:var(--accent);color:#000;font-weight:bold;cursor:pointer;font-size:0.9em;';
const _BTN_RED = 'padding:5px 10px;border-radius:7px;border:1px solid #ff5566;background:transparent;color:#ff7788;cursor:pointer;font-size:0.85em;';
const _FIELD = 'padding:5px 8px;border-radius:7px;border:1px solid #555;background:var(--input-bg);color:var(--text);font-size:0.9em;';

function _isTeamAdmin() { return window._teamRole === 'admin'; }

function _adminCount() {
    return Object.values(_teamPanelMembers).filter(m => m && m.role === 'admin').length;
}

function openTeamPanel() {
    if (!window._teamId) return;
    closeTeamPanel();

    const overlay = _h('div', {
        id: 'teamPanel',
        style: 'position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,0.65);display:flex;align-items:flex-start;'
             + 'justify-content:center;padding:60px 14px 20px;overflow:auto;font-family:"Segoe UI",sans-serif;',
        onclick: e => { if (e.target === overlay) closeTeamPanel(); },
    });
    const card = _h('div', {
        id: 'teamPanelCard',
        style: 'width:100%;max-width:760px;background:var(--bg-2);border:1px solid rgba(var(--accent-rgb),0.35);border-radius:14px;'
             + 'padding:22px;color:var(--text);box-shadow:0 12px 45px rgba(0,0,0,0.5);',
    });
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const db = window._firebaseDb, ref = window._firebaseRef, onValue = window._firebaseOnValue;
    _teamPanelUnsubs.push(onValue(ref(db, teamPath('members')), snap => {
        _teamPanelMembers = snap.val() || {};
        renderTeamPanel();
    }));
    if (_isTeamAdmin()) {
        _teamPanelUnsubs.push(onValue(ref(db, teamPath('invites')), snap => {
            _teamPanelInvites = snap.val() || {};
            renderTeamPanel();
        }, err => console.warn('Lecture des invitations refusée :', err)));
    }
    renderTeamPanel();
}

function closeTeamPanel() {
    _teamPanelUnsubs.forEach(u => { try { u(); } catch (e) { /* déjà arrêté */ } });
    _teamPanelUnsubs = [];
    _teamPanelMembers = {}; _teamPanelInvites = {};
    document.getElementById('teamPanel')?.remove();
}

function renderTeamPanel() {
    const card = document.getElementById('teamPanelCard');
    if (!card) return;
    card.textContent = '';

    const uid = window._firebaseAuth?.currentUser?.uid;
    const admin = _isTeamAdmin();

    card.append(
        _h('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;' },
            _h('h2', { style: 'margin:0;color:var(--accent);font-size:1.3em;' }, `👥 ${window._teamName}`),
            _h('button', { style: _BTN, onclick: closeTeamPanel }, '✕ Fermer')),
    );

    /* ── Membres ── */
    card.append(_h('h3', { style: 'margin:6px 0 8px;font-size:1em;color:#9fb4ff;' }, 'Membres'));
    const members = Object.entries(_teamPanelMembers)
        .filter(([, m]) => m && m.role)
        .sort((a, b) => (a[1].role === 'admin' ? 0 : 1) - (b[1].role === 'admin' ? 0 : 1) || String(a[1].name || '').localeCompare(String(b[1].name || '')));
    const onlyAdmin = _adminCount() <= 1;

    const list = _h('div', { style: 'display:flex;flex-direction:column;gap:6px;' });
    members.forEach(([mUid, m]) => {
        const isSelf = mUid === uid;
        const isLastAdmin = m.role === 'admin' && onlyAdmin;
        const row = _h('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:rgba(var(--fg-rgb),0.05);border-radius:8px;padding:8px 10px;' },
            _h('div', { style: 'flex:1;min-width:150px;' },
                _h('div', { style: 'font-weight:600;' }, (m.name || '—') + (isSelf ? '  (vous)' : '')),
                _h('div', { style: 'font-size:0.8em;color:#8e9ac0;' }, m.email || '')),
        );
        if (admin) {
            const sel = _h('select', { style: _FIELD, 'aria-label': `Rôle de ${m.name || ''}` },
                ...INVITE_ROLES.map(r => _h('option', { value: r, selected: r === m.role ? 'selected' : false }, _teamRoleLabel(r))));
            sel.disabled = isLastAdmin;
            if (isLastAdmin) sel.title = "Dernier admin de l'équipe : nommez-en un autre avant de changer ce rôle.";
            sel.addEventListener('change', () => changeMemberRole(mUid, m, sel.value));
            row.append(sel);
            if (!isSelf) {
                row.append(_h('button', { style: _BTN_RED, onclick: () => removeMember(mUid, m) }, 'Retirer'));
            }
        } else {
            row.append(_h('span', { style: 'font-size:0.85em;color:var(--accent);' }, _teamRoleLabel(m.role)));
        }
        if (isSelf) {
            const leave = _h('button', { style: _BTN, onclick: () => leaveTeam() }, "Quitter l'équipe");
            if (isLastAdmin) { leave.disabled = true; leave.title = "Vous êtes le dernier admin : nommez-en un autre avant de partir."; leave.style.opacity = '0.4'; }
            row.append(leave);
        }
        list.append(row);
    });
    card.append(list);

    /* ── Invitations (admin) ── */
    if (!admin) {
        card.append(_h('div', { style: 'margin-top:16px;color:#8e9ac0;font-size:0.85em;' },
            "Seul un admin peut inviter de nouveaux membres ou modifier les rôles."));
        return;
    }

    card.append(_h('h3', { style: 'margin:20px 0 8px;font-size:1em;color:#9fb4ff;' }, 'Inviter quelqu\'un'));
    const roleSel = _h('select', { id: 'inviteRole', style: _FIELD },
        _h('option', { value: 'driver' }, 'Pilote'), _h('option', { value: 'viewer' }, 'Lecture seule'), _h('option', { value: 'admin' }, 'Admin'));
    const durSel = _h('select', { id: 'inviteDuration', style: _FIELD },
        ...INVITE_DURATIONS.map(d => _h('option', { value: d.days, selected: d.days === 7 ? 'selected' : false }, `Valable ${d.label}`)));
    card.append(_h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;' },
        roleSel, durSel,
        _h('button', { style: _BTN_GREEN, onclick: () => createInvite(roleSel.value, parseInt(durSel.value)) }, '🔗 Créer un lien')));

    const invs = Object.entries(_teamPanelInvites).filter(([, i]) => i && i.role).sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));
    if (invs.length) {
        card.append(_h('h3', { style: 'margin:18px 0 8px;font-size:1em;color:#9fb4ff;' }, 'Liens d\'invitation'));
        const il = _h('div', { style: 'display:flex;flex-direction:column;gap:6px;' });
        invs.forEach(([code, inv]) => {
            const expired = (inv.expiresAt || 0) <= Date.now();
            const link = buildInviteLink(window._teamId, code, inv.role);
            const input = _h('input', { type: 'text', readonly: 'readonly', value: link, style: _FIELD + 'flex:1;min-width:200px;' + (expired ? 'opacity:0.45;' : '') });
            input.addEventListener('focus', () => input.select());
            const copy = _h('button', { style: _BTN, onclick: () => copyInviteLink(link, copy) }, 'Copier');
            if (expired) copy.disabled = true;
            il.append(_h('div', { style: 'background:rgba(var(--fg-rgb),0.05);border-radius:8px;padding:8px 10px;' },
                _h('div', { style: 'font-size:0.8em;margin-bottom:5px;color:' + (expired ? '#ff7788' : '#8e9ac0') + ';' },
                    `${_teamRoleLabel(inv.role)} · ` + (expired ? 'expirée' : `expire le ${new Date(inv.expiresAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}`)),
                _h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;align-items:center;' },
                    input, copy,
                    _h('button', { style: _BTN_RED, onclick: () => revokeInvite(code) }, 'Révoquer'))));
        });
        card.append(il);
        card.append(_h('div', { style: 'margin-top:8px;color:#8e9ac0;font-size:0.8em;' },
            "Un lien reste utilisable jusqu'à son expiration par toute personne qui le possède : révoquez-le dès que les personnes attendues ont rejoint l'équipe."));
    }
}

/* ── Actions (les règles Firebase restent juges) ── */
function _panelError(prefix, err) {
    console.error(prefix, err);
    alert(`${prefix} : ${err && err.code === 'PERMISSION_DENIED' ? "action refusée (droits insuffisants)" : (err && err.message) || err}`);
}

async function createInvite(role, days) {
    if (!INVITE_ROLES.includes(role) || !days) return;
    if (role === 'admin' && !confirm("Ce lien donnera les droits d'ADMIN à toute personne qui l'utilise. Continuer ?")) return;
    const code = generateInviteCode();
    try {
        await window._firebaseSet(window._firebaseRef(window._firebaseDb, teamPath(`invites/${code}`)), {
            role,
            expiresAt: Date.now() + days * 86400000,
            createdAt: Date.now(),
            createdBy: window._firebaseAuth?.currentUser?.uid || null,
        });
    } catch (e) { _panelError("Création de l'invitation impossible", e); }
}

async function revokeInvite(code) {
    try { await window._firebaseRemove(window._firebaseRef(window._firebaseDb, teamPath(`invites/${code}`))); }
    catch (e) { _panelError("Révocation impossible", e); }
}

async function changeMemberRole(uid, member, role) {
    if (!INVITE_ROLES.includes(role) || role === member.role) return;
    if (member.role === 'admin' && _adminCount() <= 1) { alert("Dernier admin : nommez-en un autre d'abord."); renderTeamPanel(); return; }
    const db = window._firebaseDb, ref = window._firebaseRef;
    try {
        await window._firebaseUpdate(ref(db, teamPath(`members/${uid}`)), { role });
        await window._firebaseSet(ref(db, `userTeams/${uid}/${window._teamId}`), role);
    } catch (e) { _panelError('Changement de rôle impossible', e); renderTeamPanel(); }
}

async function removeMember(uid, member) {
    if (!confirm(`Retirer ${member.name || member.email || 'ce membre'} de l'équipe ?`)) return;
    const db = window._firebaseDb, ref = window._firebaseRef;
    try {
        await window._firebaseRemove(ref(db, teamPath(`members/${uid}`)));
        await window._firebaseRemove(ref(db, `userTeams/${uid}/${window._teamId}`));
    } catch (e) { _panelError('Retrait impossible', e); }
}

async function leaveTeam() {
    if (!confirm(`Quitter l'équipe « ${window._teamName} » ? Vous perdrez l'accès à ses données.`)) return;
    const uid = window._firebaseAuth?.currentUser?.uid, db = window._firebaseDb, ref = window._firebaseRef;
    try {
        await window._firebaseRemove(ref(db, teamPath(`members/${uid}`)));
        await window._firebaseRemove(ref(db, `userTeams/${uid}/${window._teamId}`));
        try { localStorage.removeItem(TEAM_STORAGE_KEY); } catch (e) { /* sans conséquence */ }
        location.reload();
    } catch (e) { _panelError("Impossible de quitter l'équipe", e); }
}

async function copyInviteLink(link, btn) {
    try {
        await navigator.clipboard.writeText(link);
        btn.textContent = 'Copié ✓';
    } catch (e) {
        btn.textContent = 'Sélectionnez le lien';
    }
    setTimeout(() => { btn.textContent = 'Copier'; }, 2000);
}
