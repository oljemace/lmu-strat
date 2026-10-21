/* ══════════════════════════════════════════════
   CONTEXTE D'ÉQUIPE
   Chaque donnée vit sous teams/{teamId}/… (voir firebase/database.rules.json).
   Ce fichier détermine, après connexion, dans quelle équipe travaille
   l'utilisateur et avec quel rôle, et fournit teamPath() aux autres modules.
   Il n'autorise rien : l'étanchéité et les rôles sont appliqués par les
   règles Firebase ; ici on ne fait que choisir où lire/écrire et adapter
   l'affichage (ex. lecture seule).
   ══════════════════════════════════════════════ */

window._teamId   = null;
window._teamName = '';
window._teamRole = null;   // 'admin' | 'driver' | 'viewer'

const TEAM_STORAGE_KEY = 'lmu.lastTeamId';

/** Chemin Firebase sous l'équipe courante (ex. teamPath('sessions') → teams/ABC/sessions). */
function teamPath(sub) {
    if (!window._teamId) throw new Error("Aucune équipe sélectionnée");
    return `teams/${window._teamId}/${sub}`;
}

/** Vrai si le rôle courant peut modifier les données (admin ou pilote). */
function canWriteTeamData() {
    return window._teamRole === 'admin' || window._teamRole === 'driver';
}

function _teamRoleLabel(role) {
    return { admin: 'Admin', driver: 'Pilote', viewer: 'Lecture seule' }[role] || role || '';
}

function _teamStorageGet() { try { return localStorage.getItem(TEAM_STORAGE_KEY); } catch (e) { return null; } }
function _teamStorageSet(v) { try { localStorage.setItem(TEAM_STORAGE_KEY, v); } catch (e) { /* stockage indisponible : sans conséquence */ } }

/**
 * Liste les équipes dont l'utilisateur est réellement membre.
 * L'index userTeams/{uid} n'est qu'une aide : chaque entrée est vérifiée en
 * lisant le nœud membre dans l'équipe (les règles refusent la lecture sinon).
 */
async function _fetchMyTeams(uid) {
    const db = window._firebaseDb, ref = window._firebaseRef, get = window._firebaseGet;
    let index = {};
    try {
        index = (await get(ref(db, `userTeams/${uid}`))).val() || {};
    } catch (e) {
        console.warn('Lecture de userTeams impossible :', e);
    }
    const teams = [];
    for (const teamId of Object.keys(index)) {
        try {
            const member = (await get(ref(db, `teams/${teamId}/members/${uid}`))).val();
            if (!member || !member.role) continue;       // plus membre : entrée d'index périmée
            const meta = (await get(ref(db, `teams/${teamId}/meta`))).val() || {};
            teams.push({ id: teamId, name: meta.name || teamId, role: member.role });
        } catch (e) {
            // accès refusé : pas (ou plus) membre de cette équipe
        }
    }
    return teams;
}

/**
 * Détermine l'équipe active pour l'utilisateur connecté.
 * Retourne true si une équipe est active, false sinon (écran « aucune équipe »).
 */
async function resolveTeamContext(user) {
    window._teamId = null; window._teamName = ''; window._teamRole = null;
    const teams = await _fetchMyTeams(user.uid);
    window._myTeams = teams;
    if (teams.length === 0) return false;

    const last = _teamStorageGet();
    const chosen = teams.find(t => t.id === last) || teams[0];
    window._teamId   = chosen.id;
    window._teamName = chosen.name;
    window._teamRole = chosen.role;
    _teamStorageSet(chosen.id);
    return true;
}

/** Affiche l'équipe et le rôle dans la barre du haut (et un sélecteur si plusieurs équipes). */
function renderTeamBadge() {
    const bar = document.getElementById('teamBadge');
    if (!bar) return;
    const teams = window._myTeams || [];
    bar.textContent = '';

    const name = document.createElement('span');
    name.style.cssText = 'color:var(--accent);font-weight:bold;';
    name.textContent = '👥 ';
    if (teams.length > 1) {
        const sel = document.createElement('select');
        sel.style.cssText = 'padding:3px 6px;border-radius:6px;border:1px solid var(--accent);background:var(--input-bg);color:var(--text);';
        teams.forEach(t => {
            const o = document.createElement('option');
            o.value = t.id; o.textContent = t.name;
            if (t.id === window._teamId) o.selected = true;
            sel.appendChild(o);
        });
        sel.addEventListener('change', () => { _teamStorageSet(sel.value); location.reload(); });
        name.appendChild(sel);
    } else {
        name.appendChild(document.createTextNode(window._teamName));
    }
    bar.appendChild(name);

    const role = document.createElement('span');
    role.style.cssText = 'margin-left:8px;padding:2px 8px;border-radius:10px;font-size:0.8em;'
        + (window._teamRole === 'viewer'
            ? 'background:rgba(255,170,0,0.2);color:#ffaa00;'
            : 'background:rgba(var(--accent-rgb),0.15);color:var(--accent);');
    role.textContent = (window._teamRole === 'viewer' ? '👁 ' : '') + _teamRoleLabel(window._teamRole);
    bar.appendChild(role);

    // Lecture seule : masquer la création de session
    document.querySelectorAll('[data-requires-write]').forEach(el => {
        el.style.display = canWriteTeamData() ? '' : 'none';
    });
    // Renommer / supprimer une session : admin d'équipe uniquement
    document.querySelectorAll('[data-requires-admin]').forEach(el => {
        el.style.display = window._teamRole === 'admin' ? '' : 'none';
    });
}

/** Écran affiché quand le compte n'appartient à aucune équipe. */
function showNoTeamScreen(user) {
    let el = document.getElementById('noTeamScreen');
    if (!el) {
        el = document.createElement('div');
        el.id = 'noTeamScreen';
        el.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;'
            + 'background:linear-gradient(135deg,var(--bg-1),var(--bg-2));font-family:"Segoe UI",sans-serif;padding:16px;';
        const card = document.createElement('div');
        card.style.cssText = 'max-width:460px;background:rgba(var(--fg-rgb),0.06);border:1px solid rgba(var(--fg-rgb),0.15);'
            + 'border-radius:14px;padding:28px;color:var(--text);text-align:center;';
        const h = document.createElement('h2');
        h.style.cssText = 'margin:0 0 10px;color:#ffaa00;';
        h.textContent = 'Aucune équipe';
        const p = document.createElement('p');
        p.style.cssText = 'color:var(--text-2);line-height:1.5;';
        p.id = 'noTeamText';
        const b = document.createElement('button');
        b.style.cssText = 'margin-top:14px;padding:8px 18px;border-radius:8px;border:1px solid #555;background:transparent;color:var(--text-2);cursor:pointer;';
        b.textContent = 'Déconnexion';
        b.addEventListener('click', () => signOutUser());
        card.append(h, p, b);
        el.appendChild(card);
        document.body.appendChild(el);
    }
    document.getElementById('noTeamText').textContent =
        `Le compte ${user.email || ''} n'est rattaché à aucune équipe. `
        + `Demandez à l'administrateur de votre équipe de vous envoyer un lien d'invitation.`;
    el.style.display = 'flex';
}

function hideNoTeamScreen() {
    const el = document.getElementById('noTeamScreen');
    if (el) el.style.display = 'none';
}

/* ══════════════════════════════════════════════
   INVITATIONS
   Un admin crée un code (teams/{équipe}/invites/{code} : rôle + expiration) et
   envoie le lien  …/index.html?join=<équipe>.<code>.<rôle>.
   Le rôle figure dans le lien parce que le nouveau venu ne peut pas lire
   l'invitation ; les règles Firebase n'acceptent l'adhésion que si ce rôle
   correspond exactement à celui de l'invitation et qu'elle n'a pas expiré.
   ══════════════════════════════════════════════ */

const INVITE_ROLES = ['admin', 'driver', 'viewer'];
const INVITE_CODE_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';   // sans l/o/0/1 (lisibilité)

/** Code aléatoire (cryptographique) de 20 caractères. */
function generateInviteCode() {
    const bytes = new Uint8Array(20);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => INVITE_CODE_ALPHABET[b % INVITE_CODE_ALPHABET.length]).join('');
}

/** Lien d'invitation complet. */
function buildInviteLink(teamId, code, role, base) {
    const b = base || (location.origin + location.pathname);
    return `${b}?join=${encodeURIComponent(teamId)}.${encodeURIComponent(code)}.${encodeURIComponent(role)}`;
}

/** Lit ?join=<équipe>.<code>.<rôle> ; retourne null si absent ou mal formé. */
function parseJoinParam(search) {
    const raw = new URLSearchParams(search || '').get('join');
    if (!raw) return null;
    const parts = raw.split('.');
    if (parts.length !== 3) return null;
    const [teamId, code, role] = parts;
    if (!/^[a-z0-9][a-z0-9_-]{1,38}[a-z0-9]$/.test(teamId)) return null;
    if (!/^[a-z0-9]{8,64}$/i.test(code)) return null;
    if (!INVITE_ROLES.includes(role)) return null;
    return { teamId, code, role };
}

/** Retire ?join=… de la barre d'adresse (sans recharger). */
function clearJoinParam() {
    try {
        const u = new URL(location.href);
        u.searchParams.delete('join');
        history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
    } catch (e) { /* sans conséquence */ }
}

/**
 * Utilise l'invitation du lien (si présent) pour entrer dans l'équipe.
 * Retourne { ok: true, already?: true } ou { ok: false, message }.
 */
async function redeemPendingInvite(user, displayName) {
    const join = parseJoinParam(location.search);
    if (!join) return { ok: true, none: true };

    const db = window._firebaseDb, ref = window._firebaseRef;
    try {
        // Déjà membre ? (lien recliqué) → rien à faire.
        try {
            const existing = (await window._firebaseGet(ref(db, `teams/${join.teamId}/members/${user.uid}`))).val();
            if (existing && existing.role) {
                _teamStorageSet(join.teamId);
                clearJoinParam();
                return { ok: true, already: true };
            }
        } catch (e) { /* lecture refusée = pas encore membre : normal */ }

        const name = (displayName || (user.email || '').split('@')[0] || 'Membre').slice(0, 60);
        await window._firebaseSet(ref(db, `teams/${join.teamId}/members/${user.uid}`), {
            role: join.role, name, email: (user.email || '').slice(0, 120), inviteCode: join.code,
        });
        await window._firebaseSet(ref(db, `userTeams/${user.uid}/${join.teamId}`), join.role);
        _teamStorageSet(join.teamId);
        clearJoinParam();
        return { ok: true };
    } catch (e) {
        console.warn("Adhésion par invitation refusée :", e);
        clearJoinParam();
        return { ok: false, message: "Cette invitation n'est pas valide : elle a expiré, a été révoquée ou le lien est incomplet. Demandez un nouveau lien à l'administrateur de l'équipe." };
    }
}
