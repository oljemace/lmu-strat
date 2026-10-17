
            /* ══════════════════════════════
                PROTECTION D'ACCÈS ÉQUIPE
                (Firebase Authentication)
             ══════════════════════════════ */

            // L'autorisation réelle est appliquée côté serveur par les règles
            // Firebase (firebase/database.rules.json), qui exigent un compte
            // authentifié listé dans /authorizedUsers. Ce fichier ne fait que
            // piloter l'écran de connexion — il n'autorise jamais rien par
            // lui-même.
            //
            // Les comptes se créent soit dans la console Firebase, soit — pour les
            // pilotes — via un lien d'invitation (?join=…) généré par l'admin de
            // l'équipe (voir team-context.js). Créer un compte ne donne accès à
            // RIEN : seule une invitation valide fait entrer dans une équipe.

async function signIn() {
    const emailInput = document.getElementById('gateEmail');
    const pwdInput    = document.getElementById('gatePassword');
    const errEl       = document.getElementById('gateError');
    const btn         = document.getElementById('gateSubmitBtn');

    if (!emailInput || !pwdInput) return;

    const email = emailInput.value.trim();
    const pwd   = pwdInput.value;

    if (!email || !pwd) {
        if (errEl) errEl.textContent = '⚠️ Saisissez l\'email et le mot de passe';
        return;
    }

    if (!window._firebaseAuth || !window._firebaseSignIn) {
        if (errEl) errEl.textContent = '⏳ Connexion à Firebase en cours, réessayez dans un instant.';
        return;
    }

    if (btn) btn.disabled = true;
    if (errEl) errEl.textContent = '';

    try {
        await window._firebaseSignIn(window._firebaseAuth, email, pwd);
        // La suite (retrait du gate, init de l'UI) est gérée par
        // onAuthStateChanged ci-dessous, déclenché automatiquement
        // par Firebase après une connexion réussie.
    } catch (err) {
        console.error('Erreur de connexion :', err);
        let msg = '❌ Connexion impossible';
        if (err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password' || err.code === 'auth/user-not-found') {
            msg = '❌ Email ou mot de passe incorrect';
        } else if (err.code === 'auth/too-many-requests') {
            msg = '❌ Trop de tentatives, réessayez plus tard';
        } else if (err.code === 'auth/invalid-email') {
            msg = '❌ Adresse email invalide';
        }
        if (errEl) errEl.textContent = msg;
        pwdInput.value = '';
        pwdInput.focus();
    } finally {
        if (btn) btn.disabled = false;
    }
}

/* ── Mode de l'écran de connexion : connexion ↔ création de compte ── */
let _gateMode = 'signin';

function _gateErr(msg) { const e = document.getElementById('gateError'); if (e) e.textContent = msg || ''; }

function setGateMode(mode) {
    _gateMode = mode;
    const signup = mode === 'signup';
    const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
    show('gateName', signup);
    show('gateForgot', !signup);
    const btn = document.getElementById('gateSubmitBtn');
    if (btn) btn.textContent = signup ? '✨ Créer mon compte et rejoindre' : '🔓 Se connecter';
    const pwd = document.getElementById('gatePassword');
    if (pwd) {
        pwd.autocomplete = signup ? 'new-password' : 'current-password';
        pwd.placeholder = signup ? 'Mot de passe (8 caractères minimum)' : 'Mot de passe';
    }
    const hasInvite = !!parseJoinParam(location.search);
    const toggle = document.getElementById('gateToggle');
    if (toggle) {
        toggle.style.display = hasInvite ? '' : 'none';
        toggle.textContent = signup ? "J'ai déjà un compte" : 'Créer un compte avec cette invitation';
    }
    show('gateNoInvite', !hasInvite);
    show('gateInviteBanner', hasInvite);
    _gateErr('');
}

function toggleGateMode() { setGateMode(_gateMode === 'signup' ? 'signin' : 'signup'); }

function submitGate() { return _gateMode === 'signup' ? signUp() : signIn(); }

async function signUp() {
    const name  = (document.getElementById('gateName')?.value || '').trim();
    const email = (document.getElementById('gateEmail')?.value || '').trim();
    const pwd   = document.getElementById('gatePassword')?.value || '';
    const btn   = document.getElementById('gateSubmitBtn');

    if (!parseJoinParam(location.search)) return _gateErr("⚠️ La création de compte nécessite un lien d'invitation valide.");
    if (!name)            return _gateErr('⚠️ Indiquez votre nom de pilote');
    if (!email)           return _gateErr("⚠️ Indiquez votre adresse email");
    if (pwd.length < 8)   return _gateErr('⚠️ Le mot de passe doit contenir au moins 8 caractères');
    if (!window._firebaseAuth || !window._firebaseSignUp) return _gateErr('⏳ Connexion à Firebase en cours, réessayez dans un instant.');

    if (btn) btn.disabled = true;
    _gateErr('');
    window._signupName = name;   // lu par _onAuthReady pour nommer le membre
    try {
        await window._firebaseSignUp(window._firebaseAuth, email, pwd);
        // La suite (adhésion à l'équipe) est gérée par _onAuthReady.
    } catch (err) {
        console.error('Erreur de création de compte :', err);
        window._signupName = null;
        const msgs = {
            'auth/email-already-in-use': "❌ Un compte existe déjà avec cet email : utilisez « J'ai déjà un compte ».",
            'auth/invalid-email': '❌ Adresse email invalide',
            'auth/weak-password': '❌ Mot de passe trop faible',
            'auth/too-many-requests': '❌ Trop de tentatives, réessayez plus tard',
        };
        _gateErr(msgs[err.code] || '❌ Création du compte impossible');
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function resetPasswordFromGate() {
    const email = (document.getElementById('gateEmail')?.value || '').trim();
    if (!email) return _gateErr("⚠️ Saisissez d'abord votre email, puis cliquez sur « Mot de passe oublié ? »");
    if (!window._firebaseAuth || !window._firebaseResetPassword) return _gateErr('⏳ Connexion à Firebase en cours, réessayez dans un instant.');
    try {
        await window._firebaseResetPassword(window._firebaseAuth, email);
    } catch (err) {
        console.warn('Réinitialisation du mot de passe :', err);
    }
    // Même message dans tous les cas : ne révèle pas si l'adresse a un compte.
    _gateErr("📧 Si un compte existe pour cette adresse, un email de réinitialisation vient d'être envoyé.");
}

function signOutUser() {
    if (window._firebaseSignOut) window._firebaseSignOut();
}

async function _onAuthReady(user) {
    const gate = document.getElementById('accessGate');

    if (!user) {
        // Déconnexion après une session ouverte : le gate a été retiré du DOM à la
        // connexion, on recharge la page pour repartir d'un état propre (gate affiché,
        // aucune donnée d'équipe en mémoire).
        if (window._wasSignedIn) { location.reload(); return; }
        // Non connecté : afficher le gate, masquer le reste.
        if (gate) gate.style.display = 'flex';
        document.body.dataset.hooksAttached = '';
        window._teamId = null; window._teamRole = null; window._teamName = '';
        if (typeof stopTeamTelemetryWatch === 'function') stopTeamTelemetryWatch();
        if (typeof hideNoTeamScreen === 'function') hideNoTeamScreen();
        return;
    }

    // Connecté : retirer le gate, puis déterminer l'équipe avant d'initialiser l'app.
    if (gate) gate.remove();
    window._wasSignedIn = true;

    const userLabel = document.getElementById('authUserLabel');
    if (userLabel) userLabel.textContent = user.email || '';

    // Lien d'invitation : entrer dans l'équipe avant de résoudre le contexte.
    let joinError = null;
    try {
        const joined = await redeemPendingInvite(user, window._signupName);
        if (!joined.ok) joinError = joined.message;
    } catch (e) {
        console.error("Adhésion impossible :", e);
    }
    window._signupName = null;

    let hasTeam = false;
    try {
        hasTeam = await resolveTeamContext(user);
    } catch (e) {
        console.error("Impossible de déterminer l'équipe :", e);
    }
    if (joinError) alert(joinError);
    if (!hasTeam) {
        showNoTeamScreen(user);
        return;
    }
    hideNoTeamScreen();
    if (typeof renderTeamBadge === 'function') renderTeamBadge();

    if (typeof renderSessionUI === 'function') renderSessionUI();

    if (!document.body.dataset.hooksAttached) {
        if (typeof hookSyncToInputs === 'function') hookSyncToInputs();
        document.body.dataset.hooksAttached = 'true';
    }

    if (typeof loadCircuitsFromFirebase === 'function') loadCircuitsFromFirebase();
}

function _attachAuthListener() {
    window._firebaseOnAuthStateChanged(window._firebaseAuth, _onAuthReady);
}

if (window._firebaseReady) {
    _attachAuthListener();
} else {
    window.addEventListener('firebaseReady', _attachAuthListener, { once: true });
}

// Écran de connexion : mode « création de compte » d'office si l'on arrive par un lien d'invitation.
setGateMode(parseJoinParam(location.search) ? 'signup' : 'signin');
