/* ══════════════════════════════════════════════
   SESSIONS & SYNCHRONISATION FIREBASE
   ══════════════════════════════════════════════ */

let _sessionId          = null;   // ID de session active
let _isSyncing          = false;  // verrou anti-écho (bloque seulement l'ENVOI, plus la saisie)
let _syncTimeout        = null;   // debounce timer
let _lastLocalPushTime  = 0;      // anti-écho Firebase
let _calculatingFromRemote = false; // anti-boucle applyFormData→calculate

// Champs modifiés localement depuis le dernier push réussi.
// Permet d'envoyer une mise à jour PARTIELLE (merge) au lieu d'écraser
// tout le document à chaque frappe, ce qui évite qu'un push basé sur un
// état local périmé n'efface les changements d'un·e autre utilisateur·ice.
let _dirtyFields        = new Set();
let _dirtyPitState      = false;
let _dirtyTyreWear      = false;
let _dirtyDrivers       = false;  // nom/couleur pilotes ou nombre de pilotes
let _pendingPushAfterLock = false; // un push a été demandé pendant le verrou _isSyncing

/* ── Sélecteur de session (à injecter dans le DOM) ── */
function renderSessionUI() {
    if (!document.body) {
        window.addEventListener('DOMContentLoaded', renderSessionUI, { once: true });
        return;
    }

    const existing = document.getElementById('sessionBar');

    if (existing) {
        // La barre existe déjà dans le HTML :
        // on recharge quand même la liste depuis Firebase.
        loadSessionList();

        const sel = document.getElementById('sessionSelect');

        // Évite d'ajouter plusieurs fois le même événement.
        if (sel && !sel.dataset.firebaseHooked) {
            sel.dataset.firebaseHooked = 'true';

            sel.addEventListener('change', function() {
                if (this.value) {
                    joinSession(this.value);
                }
            });
        }

        return;
    }

    const bar = document.createElement('div');
    bar.id = 'sessionBar';
    bar.style.cssText = `
        position:fixed;top:0;left:0;right:0;z-index:9999;
        background:var(--bar-bg);border-bottom:2px solid var(--accent);
        padding:8px 20px;display:flex;align-items:center;gap:12px;
        font-family:'Segoe UI',sans-serif;font-size:0.9em;flex-wrap:wrap;`;

    bar.innerHTML = `
        <span id="teamBadge" style="font-size:0.9em;"></span>
        <button id="teamPanelBtn" onclick="openTeamPanel()" title="Membres et invitations"
            style="padding:4px 10px;background:transparent;color:var(--accent);border:1px solid var(--accent);
                   border-radius:6px;font-size:0.85em;cursor:pointer;">👥 Équipe</button>
        <span style="color:var(--accent);font-weight:bold;">🏎️ Session</span>
        <select id="sessionSelect"
            style="padding:4px 8px;border-radius:6px;border:1px solid var(--accent);
                   background:var(--input-bg);color:var(--text);font-size:0.9em;min-width:160px;">
            <option value="">— Choisir une session —</option>
        </select>
        <button data-requires-write onclick="createSession()"
            style="padding:4px 12px;background:var(--accent);color:#000;border:none;
                   border-radius:6px;font-weight:bold;cursor:pointer;">
            + Nouvelle
        </button>
        <input data-requires-write id="sessionNameInput" placeholder="Nom de la session"
            style="padding:4px 8px;border-radius:6px;border:1px solid #555;
                   background:var(--input-bg);color:var(--text);font-size:0.9em;width:140px;">
        <button data-requires-admin id="renameSessionBtn" onclick="renameSession()" title="Renommer la session sélectionnée"
            style="display:none;padding:4px 10px;background:transparent;color:var(--accent);border:1px solid var(--accent);
                   border-radius:6px;font-size:0.85em;cursor:pointer;">✏️ Renommer</button>
        <button data-requires-admin id="deleteSessionBtn" onclick="deleteSession()" title="Supprimer la session sélectionnée"
            style="display:none;padding:4px 10px;background:transparent;color:#ff6b6b;border:1px solid #ff6b6b;
                   border-radius:6px;font-size:0.85em;cursor:pointer;">🗑️ Supprimer</button>
        <div style="margin-left:auto;display:flex;flex-direction:column;align-items:flex-end;gap:1px;">
            <span id="syncStatus"
                style="font-size:0.8em;color:var(--text-4);">
                ⬤ Non connecté
            </span>
            <span id="syncTime"
                style="font-size:0.9em;color:#555;font-style:italic;white-space:nowrap;">
            </span>
        </div>`;

    document.body.prepend(bar);

    // Décaler le container pour ne pas être caché par la barre fixe
    const container = document.querySelector('.container');
    if (container) container.style.marginTop = '52px';

    loadSessionList();

    document.getElementById('sessionSelect').addEventListener('change', function() {
        if (this.value) joinSession(this.value);
    });
}
/* ── Charger la liste des sessions depuis Firebase ──
   Une fois l'équipe migrée (drapeau teams/{équipe}/meta/sessionIndexReady posé par tools/build_session_index.py),
   la liste lit l'INDEX léger teams/{équipe}/sessionIndex (identifiant → nom) et non le nœud « sessions » :
   celui-ci contient la télémétrie et la diffusion Mode Live du pilote (plusieurs mises à jour par seconde)
   que chaque visiteur du site téléchargerait en continu. Tant que le drapeau n'est pas posé (ou illisible),
   on garde l'ancienne lecture et on n'écrit pas l'index : une liste à moitié remplie masquerait des sessions. */
let _sessionFlagUnsub   = null;   // écouteur du drapeau « index prêt »
let _sessionIdxUnsub    = null;   // écouteur de l'index
let _sessionLegacyUnsub = null;   // écouteur de l'ancienne méthode
let _sessionListSig     = null;   // empreinte (id + nom) de la liste affichée
window._sessionIndexReady = false;

function sessionListSignature(data) {
    return JSON.stringify(Object.entries(data).map(([id, s]) => [id, (s && s.name) || id]));
}

function _stopUnsub(un) { if (un) { try { un(); } catch (e) { /* déjà arrêté */ } } }

function _stopListListeners() {
    _stopUnsub(_sessionIdxUnsub);    _sessionIdxUnsub = null;
    _stopUnsub(_sessionLegacyUnsub); _sessionLegacyUnsub = null;
}

/** data : { idSession: { name, … } } */
function _renderSessionList(data) {
    const sel = document.getElementById('sessionSelect');
    if (!sel) return;
    // On ne reconstruit la liste déroulante que si les noms/identifiants ont changé : une reconstruction
    // la refermait ou perdait la sélection pendant que le spectateur cliquait.
    const sig = sessionListSignature(data);
    if (sig === _sessionListSig) return;
    _sessionListSig = sig;
    const current = sel.value;
    sel.innerHTML = '<option value="">— Choisir une session —</option>';
    Object.entries(data).forEach(([id, s]) => {
        const opt = document.createElement('option');
        opt.value       = id;
        opt.textContent = (s && s.name) || id;
        if (id === current) opt.selected = true;
        sel.appendChild(opt);
    });
}

function _useSessionListSource(indexReady) {
    window._sessionIndexReady = !!indexReady;
    _stopListListeners();
    _sessionListSig = null;
    const db = window._firebaseDb;
    if (indexReady) {
        _sessionIdxUnsub = window._firebaseOnValue(window._firebaseRef(db, teamPath('sessionIndex')),
            snap => _renderSessionList(snap.val() || {}),
            () => _useSessionListSource(false));                  // index illisible : ancienne méthode
    } else {
        _sessionLegacyUnsub = window._firebaseOnValue(window._firebaseRef(db, teamPath('sessions')),
            snap => _renderSessionList(snap.val() || {}));
    }
}

function loadSessionList() {
    if (!window._firebaseDb) return;
    _stopUnsub(_sessionFlagUnsub); _sessionFlagUnsub = null;
    _stopListListeners();
    let last = null;
    _sessionFlagUnsub = window._firebaseOnValue(window._firebaseRef(window._firebaseDb, teamPath('meta/sessionIndexReady')),
        snap => {
            const ready = snap.val() === true;
            if (ready !== last) { last = ready; _useSessionListSource(ready); }
        },
        () => { if (last !== false) { last = false; _useSessionListSource(false); } });
}

/** Écrit session + index en UNE écriture atomique (les règles contrôlent chaque chemin) quand l'index est prêt ;
 *  sinon la session seule, comme avant. */
function _sessionUpdate(withIndex, sessionOnly) {
    const root = window._firebaseRef(window._firebaseDb, teamPath('').replace(/\/$/, ''));
    return window._firebaseUpdate(root, window._sessionIndexReady ? withIndex : sessionOnly);
}

/* ── Créer une nouvelle session ── */

function createSession() {
    if (!window._firebaseDb) {
        alert("Firebase non connecté — attendez quelques secondes et réessayez.");
        return;
    }
    if (!canWriteTeamData()) {
        alert("Votre rôle (lecture seule) ne permet pas de créer une session.");
        return;
    }

    const nameInput = document.getElementById('sessionNameInput');
    if (!nameInput) {
        alert("Erreur : barre de session introuvable.");
        return;
    }

    const name = nameInput.value.trim()
        || `Session ${new Date().toLocaleTimeString('fr')}`;

    const id = 'sess_' + Date.now();

    // Collecter les données MAINTENANT (DOM disponible)
    let formData = {};
    try {
        formData = collectFormData();
        // Firebase refuse toute valeur « undefined » (ex. état des pneus pas encore renseigné) : on les retire.
        formData = JSON.parse(JSON.stringify(formData));
    } catch(e) {
        console.warn('collectFormData error:', e);
    }

    setSyncStatus('🔄 Création…', '#ffaa00');

    const createdAt = Date.now();
    const sessionRec = {
        name,
        createdAt,
        createdBy: window._firebaseAuth?.currentUser?.uid || null,
        data:      formData
    };
    _sessionUpdate(
        { [`sessions/${id}`]: sessionRec, [`sessionIndex/${id}`]: { name: name.slice(0, 200), createdAt } },
        { [`sessions/${id}`]: sessionRec }
    )
    .then(() => {
        nameInput.value = '';
        setSyncStatus('✅ Session créée', '#00ff88');
        // Sélectionner automatiquement la nouvelle session dans le dropdown
        setTimeout(() => {
            const sel = document.getElementById('sessionSelect');
            if (sel) sel.value = id;
            joinSession(id);
        }, 500);
    })
    .catch(err => {
        console.error('Erreur création session:', err);
        setSyncStatus('🔴 Erreur création', '#ff4444');
        alert('Erreur lors de la création : ' + err.message);
    });
}

/* ── Renommer / supprimer la session sélectionnée (admin d'équipe uniquement) ──
   L'interface masque ces boutons aux autres rôles ; c'est surtout une commodité :
   les règles Firebase (sessions/$sessionId .write) refusent de toute façon l'écriture
   à un non-admin. */
function _selectedSession() {
    const sel = document.getElementById('sessionSelect');
    if (!sel || !sel.value) return null;
    const opt = sel.options[sel.selectedIndex];
    return { id: sel.value, name: opt ? opt.textContent : sel.value };
}

function renameSession() {
    if (!window._firebaseDb) { alert("Firebase non connecté — réessayez dans un instant."); return; }
    if (window._teamRole !== 'admin') { alert("Seul un admin de l'équipe peut renommer une session."); return; }
    const cur = _selectedSession();
    if (!cur) { alert("Choisissez d'abord une session dans la liste."); return; }

    const input = prompt('Nouveau nom de la session :', cur.name);
    if (input === null) return;                       // annulé
    const name = input.trim();
    if (!name) { alert('Le nom ne peut pas être vide.'); return; }
    if (name.length > 80) { alert('Nom trop long (80 caractères maximum).'); return; }
    if (name === cur.name) return;

    setSyncStatus('🔄 Renommage…', '#ffaa00');
    _sessionUpdate(
        { [`sessions/${cur.id}/name`]: name, [`sessionIndex/${cur.id}/name`]: name },
        { [`sessions/${cur.id}/name`]: name }
    )
        .then(() => setSyncStatus('🟢 Session renommée', '#00ff88'))
        .catch(err => {
            console.error('Erreur renommage session:', err);
            setSyncStatus('🔴 Erreur renommage', '#ff4444');
            alert('Renommage refusé : ' + err.message);
        });
}

function deleteSession() {
    if (!window._firebaseDb) { alert("Firebase non connecté — réessayez dans un instant."); return; }
    if (window._teamRole !== 'admin') { alert("Seul un admin de l'équipe peut supprimer une session."); return; }
    const cur = _selectedSession();
    if (!cur) { alert("Choisissez d'abord une session dans la liste."); return; }

    if (!confirm(`Supprimer définitivement la session « ${cur.name} » ?\n\n`
        + `Toutes ses données (stratégie, pneus, télémétrie de l'équipe) seront perdues pour toute l'équipe. `
        + `Cette action est irréversible.`)) return;

    // Si c'est la session ouverte : couper l'écoute et l'envoi AVANT la suppression,
    // sinon un envoi tardif recréerait une session fantôme.
    if (cur.id === _sessionId) {
        if (_unsubscribe) { _unsubscribe(); _unsubscribe = null; }
        if (typeof stopTeamTelemetryWatch === 'function') stopTeamTelemetryWatch();
        clearTimeout(_syncTimeout);
        _dirtyFields.clear(); _dirtyPitState = false; _dirtyTyreWear = false; _dirtyDrivers = false;
        _pendingPushAfterLock = false;
        _sessionId = null;
    }

    setSyncStatus('🔄 Suppression…', '#ffaa00');
    _sessionUpdate(
        { [`sessions/${cur.id}`]: null, [`sessionIndex/${cur.id}`]: null },
        { [`sessions/${cur.id}`]: null }
    )
        .then(() => {
            const sel = document.getElementById('sessionSelect');
            if (sel) sel.value = '';
            setSyncStatus('🟢 Session supprimée', '#00ff88');
        })
        .catch(err => {
            console.error('Erreur suppression session:', err);
            setSyncStatus('🔴 Erreur suppression', '#ff4444');
            alert('Suppression refusée : ' + err.message);
        });
}

/* Vide tout l'état local propre à la session quittée : plans, pitState, pneus de départ,
   stints manuels, usure mesurée et envois en attente. Sans cela, les plans / pitState de
   l'ancienne session restaient en mémoire, « faisaient foi » à l'arrivée dans la nouvelle
   (voir plansApplyRemote) puis étaient renvoyés vers elle à la première modification. */
let _joinToken = 0;   // ignore les retours tardifs d'une session déjà quittée
/* Faux tant que les données de la session n'ont pas été reçues. Pendant ce temps le
   formulaire contient encore des valeurs par défaut (ou celles de la session
   précédente) : tout envoi les écrirait dans la session et effacerait le travail de
   l'équipe (tableau des stints remis à zéro à l'arrivée d'un autre utilisateur). */
let _sessionReady = false;
function _discardPendingPushes() {
    clearTimeout(_syncTimeout);
    _dirtyFields.clear(); _dirtyPitState = false; _dirtyTyreWear = false; _dirtyDrivers = false;
    window._dirtyPlans = false;
    if (window._plansDirty) window._plansDirty.clear();
    if (window._plansDeleted) window._plansDeleted.clear();
    window._dirtyRefPlan = false;
    _pendingPushAfterLock = false;
}
function _resetLocalSessionState() {
    clearTimeout(_syncTimeout);
    _dirtyFields.clear(); _dirtyPitState = false; _dirtyTyreWear = false; _dirtyDrivers = false;
    window._dirtyPlans = false;
    _pendingPushAfterLock = false;
    _isSyncing = false;
    _lastLocalPushTime = 0;
    Object.keys(pitState).forEach(k => delete pitState[k]);
    if (typeof plansReset === 'function') plansReset();
    window._startTyres = { left: 'none', right: 'none' };
    window._manualStintCount = 0;
    window._manualStintCountLive = 0;
    window._measuredWear = {};
    window._liveTyreState = null;
    window._plansFreshJoin = true;
}

/* ── Rejoindre une session (écoute temps réel) ── */
		let _unsubscribe = null;

		function joinSession(id) {
			if (_unsubscribe) { _unsubscribe(); _unsubscribe = null; }
			if (typeof stopTeamTelemetryWatch === 'function') stopTeamTelemetryWatch();
			if (typeof presenceSwitchTo === 'function') presenceSwitchTo(null);
			const joinToken = ++_joinToken;
			_resetLocalSessionState();
			_sessionReady = false;
			_sessionId = id;
			setSyncStatus('🟡 Connexion…', '#ffaa00');

			// L'accès est contrôlé côté serveur par les règles Firebase (appartenance
			// à l'équipe) : si la lecture réussit, l'utilisateur y a droit.
			const sessionRef = window._firebaseRef(window._firebaseDb, teamPath(`sessions/${id}`));
			window._firebaseOnValue(sessionRef, snap => {
					if (joinToken !== _joinToken) return;
				const sessionData = snap.val();
				if (!sessionData) { setSyncStatus('🔴 Session introuvable', '#ff4444'); return; }

				// Écoute temps réel des données de la session
				const dataRef = window._firebaseRef(window._firebaseDb, teamPath(`sessions/${id}/data`));
				let _hadRemoteData = false;
				_unsubscribe = window._firebaseOnValue(dataRef, snap2 => {
						if (joinToken !== _joinToken || _sessionId !== id) return;
					const remote = snap2.val();
					if (!remote && !_sessionReady) { _discardPendingPushes(); _sessionReady = true; }
					if (!remote) {
						// La session était là et vient de disparaître : un admin l'a supprimée.
						// On cesse d'écrire dedans, sinon un envoi tardif la recréerait sans nom.
						if (_hadRemoteData && _sessionId === id) {
							if (_unsubscribe) { _unsubscribe(); _unsubscribe = null; }
							if (typeof stopTeamTelemetryWatch === 'function') stopTeamTelemetryWatch();
							clearTimeout(_syncTimeout);
							_dirtyFields.clear(); _dirtyPitState = false; _dirtyTyreWear = false; _dirtyDrivers = false;
							_pendingPushAfterLock = false;
							_sessionId = null;
							if (typeof presenceSwitchTo === 'function') presenceSwitchTo(null);
							const sel = document.getElementById('sessionSelect');
							if (sel) sel.value = '';
							setSyncStatus('⚠️ Session supprimée par un admin', '#ffaa00');
						}
						return;
					}
					_hadRemoteData = true;
					// Première réception : les modifications en attente viennent d'un formulaire pas encore à jour, on les abandonne.
					if (!_sessionReady) { _discardPendingPushes(); _sessionReady = true; }
					if (_isSyncing) return;
					if (Date.now() - _lastLocalPushTime < 2000) return;
					_isSyncing = true;
					applyFormData(remote);
					setTimeout(() => {
						_isSyncing = false;
						// Si l'utilisateur a modifié des champs pendant le verrou,
						// on envoie maintenant ces changements au lieu de les perdre.
						if (_pendingPushAfterLock) {
							_pendingPushAfterLock = false;
							pushToFirebase(_dirtyPitState);
						}
					}, 2000);
					setSyncStatus('🟢 Synchronisé', '#00ff88');
				});

				setSyncStatus('🟢 Connecté', '#00ff88');
				if (typeof presenceSwitchTo === 'function') presenceSwitchTo(id);

				if (typeof startTeamTelemetryWatch === 'function') startTeamTelemetryWatch(id);

			}, err => {
				console.error('Accès à la session refusé :', err);
				setSyncStatus('🔴 Accès refusé', '#ff4444');
			}, { onlyOnce: true });
		}

            function pushToFirebase(includePitState = false) {
                if (!_sessionId || !_sessionReady || !window._firebaseDb || window._applyingRemote || !canWriteTeamData()) return;

                // Le verrou _isSyncing ne bloque plus que l'ENVOI réseau (anti-écho) :
                // la saisie / le commit dans pitState se font normalement pendant ce temps.
                // On mémorise juste qu'un push est en attente, pour le rejouer dès le
                // déverrouillage et ne jamais perdre une modification faite entre-temps.
                if (_isSyncing) {
                    _pendingPushAfterLock = true;
                    return;
                }

                // Pour les changements pit (checkboxes, refuel, pneus) :
                // on flush immédiatement sans debounce pour ne pas perdre les clics rapides.
                // Pour les autres champs (temps au tour, etc.) : debounce 300ms.
                if (includePitState) {
                    // Annuler tout debounce en cours et envoyer immédiatement
                    clearTimeout(_syncTimeout);
                    _doFirebasePush();
                } else {
                    clearTimeout(_syncTimeout);
                    _syncTimeout = setTimeout(_doFirebasePush, 300);
                }
            }

function _doFirebasePush() {
    if (!_sessionId || !_sessionReady || !window._firebaseDb || window._applyingRemote || !canWriteTeamData()) return;

    if (_isSyncing) {
        // Un push est arrivé pendant le verrou anti-écho : on le rejoue
        // automatiquement dès que le verrou sera levé (voir joinSession()).
        _pendingPushAfterLock = true;
        return;
    }

    // ── Construire une mise à jour PARTIELLE : uniquement ce qui a changé ──
    const full = collectFormData(true);
    const partial = {};

    _dirtyFields.forEach(id => {
        if (full[id] !== undefined) partial[id] = full[id];
    });
    if (_dirtyPitState)  partial.pitState = full.pitState;
    if (_dirtyTyreWear)  partial.tyreWear = full.tyreWear;
    // Plans : chaque utilisateur affiche son propre plan. On n'envoie que le plan
    // modifié (plans/{id}) et, s'il s'agit de la référence, sa copie à la racine.
    let plansPP = null;
    if (typeof plansPartial === 'function') {
        plansPP = plansPartial({ pit: _dirtyPitState, tyres: _dirtyFields.has('_startTyres') });
        delete partial.pitState; delete partial._startTyres;
        Object.assign(partial, plansPP.updates);
    }
    if (_dirtyDrivers) {
        partial.drivers     = full.drivers;
        partial.driverCount = full.driverCount;
    }

    // Rien à envoyer (ne devrait pas arriver, sécurité)
    if (Object.keys(partial).length === 0) return;

    const dirtySnapshot   = new Set(_dirtyFields);
    const pitStateSnapshot  = _dirtyPitState;
    const tyreWearSnapshot  = _dirtyTyreWear;
    const driversSnapshot   = _dirtyDrivers;

    _lastLocalPushTime = Date.now();
    setSyncStatus('🔄 Envoi…', '#ffaa00');
    const dataRef = window._firebaseRef(
        window._firebaseDb, teamPath(`sessions/${_sessionId}/data`)
    );
    // update() = fusion : seules les clés listées sont modifiées côté serveur,
    // les champs changés entre-temps par un·e autre utilisateur·ice restent intacts.
    window._firebaseUpdate(dataRef, partial)
        .then(() => {
            setSyncStatus('🟢 Synchronisé', '#00ff88');
            // On ne retire que ce qu'on vient d'envoyer avec succès : si l'utilisateur
            // a modifié d'autres champs entre-temps, ils restent marqués "dirty".
            dirtySnapshot.forEach(id => _dirtyFields.delete(id));
            if (pitStateSnapshot) _dirtyPitState = false;
            if (tyreWearSnapshot) _dirtyTyreWear = false;
            if (driversSnapshot)  _dirtyDrivers  = false;
            if (plansPP) plansPushed(plansPP);
        })
        .catch(() => setSyncStatus('🔴 Erreur sync', '#ff4444'));
}            
	/* ── Collecter toutes les valeurs du formulaire ── */
	function collectFormData(includePitState = true) {
        const ids = [
            'realStartHours','realStartMinutes',
            'gameStartHours','gameStartMinutes',
            'timeMultiplier','raceHours','raceMinutes',
            'lapMinutes','lapSeconds','lapMillis',
            'evRemaining','evPerLap','evRefuelPerStint',
            'refuelRate','driverCount',
            'evCurrent','evPerLapReal',
            'livelapMinutes','livelapSeconds','livelapMillis',
            'liveLapsCompleted',
            'tyreBudget',
            'circuitSelect','stratCarSelect'
        ];

		const form = {};
		ids.forEach(id => {
			const el = document.getElementById(id);
			if (el) form[id] = el.value;
		});

		const ydEl = document.getElementById('realStartYesterday');
		if (ydEl) form.realStartYesterday = ydEl.checked;

		form.drivers = [];
		const n = parseInt(document.getElementById('driverCount')?.value) || 2;
		for (let i = 0; i < n; i++) {
			form.drivers.push({
				name:  document.getElementById(`driverName_${i}`)?.value  || '',
				color: document.getElementById(`driverColor_${i}`)?.value || ''
			});
		}

		// pitState seulement quand explicitement demandé (changements pit/refuel/pneus)
		if (includePitState) {
			form.pitState = JSON.parse(JSON.stringify(pitState));
		}
		
        // ── État live à synchroniser ──
        form._liveModeActive = window._liveModeActive || false;
        form._liveEvAtAnchor = window._liveEvAtAnchor || 0;
        form._liveNowSec     = window._liveNowSec     || 0;
        form._startTyres     = window._startTyres || { left: 'none', right: 'none' };
        if (typeof plansCollect === 'function') Object.assign(form, plansCollect());

        // ── État pneus live ──
        if (window._liveTyreState) {
            form._liveTyreState = {
                compound:  window._liveTyreState.compound  || 'none',
                wearLeft:  window._liveTyreState.wearLeft,
                wearRight: window._liveTyreState.wearRight,
                budget:    window._liveTyreState.budget,
            };
        }
        const liveBudgetEl = document.getElementById('liveTyreBudget');
        if (liveBudgetEl) form.liveTyreBudget = liveBudgetEl.value;
        const liveCmpdLEl = document.getElementById('liveTyreCompoundLeft');
        if (liveCmpdLEl) form.liveTyreCompoundLeft = liveCmpdLEl.value;
        const liveCmpdREl = document.getElementById('liveTyreCompoundRight');
        if (liveCmpdREl) form.liveTyreCompoundRight = liveCmpdREl.value;        
        const ltwlEl = document.getElementById('liveTyreWearLeft');
        if (ltwlEl) form.liveTyreWearLeft = ltwlEl.value;
        const ltwrEl = document.getElementById('liveTyreWearRight');
        if (ltwrEl) form.liveTyreWearRight = ltwrEl.value;

        // ── Données usure pneus ──
        form.tyreWear = collectTyreWearData();
        form._measuredWear = window._measuredWear || {};   // usure mesurée live (par côté / composé)

		return form;
	    }

		/* ── Appliquer les données reçues au formulaire ── */
		
        function applyFormData(data) {
            // ← Activer le verrou : empêche savePitState() et hookSyncToInputs
            //   d'écraser pitState ou de renvoyer vers Firebase pendant l'application
            window._applyingRemote = true;

                const ids = [
                    'realStartHours','realStartMinutes',
                    'gameStartHours','gameStartMinutes',
                    'timeMultiplier','raceHours','raceMinutes',
                    'lapMinutes','lapSeconds','lapMillis',
                    'evRemaining','evPerLap','evRefuelPerStint',
                    'refuelRate',
                    'evCurrent','evPerLapReal',
                    'livelapMinutes','livelapSeconds','livelapMillis',
                    'liveLapsCompleted',
                    'tyreBudget',
                    'circuitSelect','stratCarSelect'
                ];

            // Circuit / voiture : sélection partagée par la session (sans recharger les
            // temps/usures, déjà présents dans les autres champs). Le circuit peut arriver
            // avant la liste des circuits : on le garde en attente pour refreshCircuitSelects.
            if (data.circuitSelect !== undefined) window._wantCircuit = data.circuitSelect;

            ids.forEach(id => {
                const el = document.getElementById(id);
                if (!el || data[id] === undefined) return;
                // Ne pas écraser un champ que l'utilisateur est en train de modifier
                // (saisie en cours ou champ actuellement focus).
                if (el.dataset.localEditing === 'true' || document.activeElement === el) return;
                el.value = data[id];
            });

            if (typeof updateRaceContextBadge === 'function') updateRaceContextBadge();

            // Checkbox "hier"
            const ydEl = document.getElementById('realStartYesterday');
            if (ydEl && data.realStartYesterday !== undefined) {
                ydEl.checked = data.realStartYesterday;
            }

        // Nombre de pilotes + noms/couleurs
        if (data.driverCount) {
            const sel = document.getElementById('driverCount');
            const currentCount = sel ? parseInt(sel.value) : -1;
            const newCount     = parseInt(data.driverCount);

            if (sel && currentCount !== newCount) {
                // Le nombre de pilotes a changé : reconstruction nécessaire
                sel.value = data.driverCount;
                renderDriverInputs(Array.isArray(data.drivers) ? data.drivers : undefined);
            } else {
                // Même nombre : on met à jour les valeurs SANS reconstruire le DOM
                if (Array.isArray(data.drivers)) {
                    data.drivers.forEach((d, i) => {
                        const nameEl  = document.getElementById(`driverName_${i}`);
                        const colorEl = document.getElementById(`driverColor_${i}`);
                        if (nameEl  && d.name  !== undefined
                            && document.activeElement !== nameEl)  nameEl.value  = d.name;
                        if (colorEl && d.color !== undefined)      colorEl.value = d.color;
                    });
                }
            }
        } else if (Array.isArray(data.drivers)) {
            data.drivers.forEach((d, i) => {
                const nameEl  = document.getElementById(`driverName_${i}`);
                const colorEl = document.getElementById(`driverColor_${i}`);
                if (nameEl  && d.name  !== undefined
                    && document.activeElement !== nameEl)  nameEl.value  = d.name;
                if (colorEl && d.color !== undefined)      colorEl.value = d.color;
            });
        }

            // Plans multiples : liste + plan actif (avant la fusion de pitState)
            if (typeof plansApplyRemote === 'function') plansApplyRemote(data);

            // pitState — ne pas écraser les stints dont un champ est en cours d'édition locale
            // Plan affiché par cet utilisateur : racine pour la référence, plans/{id} sinon
            const _rv = (typeof plansRemoteViewState === 'function')
                ? plansRemoteViewState(data) : { pitState: data.pitState, startTyres: data._startTyres };
            if (_rv.pitState) {
                // Collecter les indices de stints actuellement édités
                const editingIndices = new Set();
                document.querySelectorAll('[data-local-editing="true"]').forEach(el => {
                    const tr = el.closest('tr[data-stint-idx]');
                    if (tr) editingIndices.add(parseInt(tr.dataset.stintIdx));
                });

                Object.keys(_rv.pitState).forEach(k => {
                    if (!editingIndices.has(parseInt(k))) {
                        pitState[k] = _rv.pitState[k];
                    }
                    // Si l'indice est en cours d'édition, on garde le pitState local
                });
                // Ajouter les clés absentes du remote mais présentes localement (édition en cours)
                // → rien à faire, elles sont déjà dans pitState
            }
        
            // Restauration état live
            if (data._liveModeActive !== undefined) {
                window._liveModeActive = data._liveModeActive;
                window._liveEvAtAnchor = data._liveEvAtAnchor || 0;
                window._liveNowSec     = data._liveNowSec     || 0;
            }

            // Restauration pneus de départ
            if (_rv.startTyres) {
                window._startTyres = _rv.startTyres;
                const stlEl = document.getElementById('startTyreLeft');
                const strEl = document.getElementById('startTyreRight');
                if (stlEl) {
                    stlEl.value = _rv.startTyres.left || 'none';
                    _applyStartTyreSelectStyle('startTyreLeft', stlEl.value);
                }
                if (strEl) {
                    strEl.value = _rv.startTyres.right || 'none';
                    _applyStartTyreSelectStyle('startTyreRight', strEl.value);
                }
                _updateStartTyreLifeInfo();
            }
            // Restauration pneus live
            if (typeof _mwRestore === 'function') _mwRestore(data._measuredWear);
            if (data._liveTyreState) {
                window._liveTyreState = data._liveTyreState;
            }
            const liveFields = [
                ['liveTyreBudget',         data.liveTyreBudget],
                ['liveTyreCompoundLeft',   data.liveTyreCompoundLeft],
                ['liveTyreCompoundRight',  data.liveTyreCompoundRight],
                ['liveTyreWearLeft',       data.liveTyreWearLeft],
                ['liveTyreWearRight',      data.liveTyreWearRight],
            ];            
            liveFields.forEach(([id, val]) => {
                const el = document.getElementById(id);
                // Ne pas écraser un champ en cours d'édition (saisie ou select
                // ouvert) — sinon un retour Firebase pendant qu'on choisit une
                // gomme referme la liste déroulante avant de pouvoir cliquer.
                if (!el || val === undefined) return;
                if (el.dataset.localEditing === 'true' || document.activeElement === el) return;
                el.value = val;
            });
                if (data.liveTyreCompoundLeft || data.liveTyreCompoundRight
            || data.liveTyreWearLeft  || data.liveTyreWearRight) {
            _updateLiveTyreWearLabels();
            }

            // Restauration données pneus
            if (data.tyreWear) applyTyreWearData(data.tyreWear);

            // ← Désactiver le verrou AVANT le recalcul
            //   (calculate() doit pouvoir lire pitState normalement,
            //    mais savePitState() ne doit toujours pas écraser — on le laisse actif
            //    juste le temps du calculate(), puis on le coupe après)
            // On utilise setTimeout 0 pour laisser le recalcul se faire dans ce tick,
            // puis on libère le verrou dans le tick suivant.
            
                if (data._liveModeActive) {
            document.body.classList.add('live-mode');
            const btnStop   = document.getElementById('btnStopLive');
            const liveBadge = document.getElementById('liveModeBadge');
            const btnRecalc = document.getElementById('btnRecalcLive');
            const fields    = document.getElementById('liveInputFields');
            if (btnStop)   btnStop.style.display   = 'inline-block';
            if (liveBadge) liveBadge.style.display = 'inline-block';
            if (btnRecalc) btnRecalc.style.display = 'inline-block';
            if (fields)    fields.style.display    = 'flex';
            }

            if (data._liveModeActive) {
                setTimeout(() => {
                    _calculatingFromRemote = true;
                    recalculateLive();
                    _calculatingFromRemote = false;
                    window._applyingRemote = false;
                }, 800);
            } else {
                _calculatingFromRemote = true;
                calculate();
                _calculatingFromRemote = false;
                window._applyingRemote = false;
            }                        
        }		

		/* ── Indicateur de statut ── */

        function setSyncStatus(text, color) {
            const el = document.getElementById('syncStatus');
            if (el) { el.textContent = text; el.style.color = color; }

            // Mettre à jour l'heure uniquement sur les états positifs
            const timeEl = document.getElementById('syncTime');
            if (timeEl && (text.includes('Synchronisé') || text.includes('Connecté') || text.includes('créée'))) {
                const now  = new Date();
                const hh   = String(now.getHours()).padStart(2, '0');
                const mm   = String(now.getMinutes()).padStart(2, '0');
                const ss   = String(now.getSeconds()).padStart(2, '0');
                timeEl.textContent = `dernière sync : ${hh}:${mm}:${ss}`;
                timeEl.style.color = '#557755';
            }
        }

		/* ── Intercepter tous les changements pour pousser vers Firebase ── */
        function hookSyncToInputs() {
        document.addEventListener('change', e => {
                // _isSyncing ne bloque plus que l'ENVOI réseau (voir pushToFirebase) :
                // on continue de traiter la saisie localement pendant le verrou anti-écho,
                // sinon des changements de l'utilisateur seraient silencieusement perdus.
                if (window._applyingRemote) return;
                const t = e.target;

                const isPit = t.matches(
                    '.stop-check, .tyre-check, .tyre-compound-select, ' +
                    '.stop-dur-input, .refuel-pct-input, .driver-select, #refuelRate'
                );

                // Commit immédiat dans pitState AVANT le recalcul
                if (isPit) {
                    const tr = t.closest('tr[data-stint-idx]');
                    if (tr && tr.dataset.past !== 'true') {
                        const idx = parseInt(tr.dataset.stintIdx);
                        if (!pitState[idx]) pitState[idx] = defaultState();

                        if (t.classList.contains('stop-check'))      pitState[idx].stop      = t.checked;
                        if (t.classList.contains('tyre-check')) {
                            if (t.dataset.side === 'left')            pitState[idx].left      = t.checked;
                            else                                      pitState[idx].right     = t.checked;
                        }
                        if (t.classList.contains('tyre-compound-select')) {
                            if (t.dataset.side === 'left') {
                                pitState[idx].tyreLeft = t.value;
                                pitState[idx].left     = t.value !== 'none';
                            } else {
                                pitState[idx].tyreRight = t.value;
                                pitState[idx].right     = t.value !== 'none';
                            }
                            applyTyreSelectClass(t);
                            updateTyreGauge();
                            requestAnimationFrame(() => {
                                requestAnimationFrame(() => buildTyreLifeBars());
                            });                            
                        }

                        if (t.classList.contains('stop-dur-input'))   pitState[idx].stopDur   = parseFloat(t.value) || 0;
                        if (t.classList.contains('refuel-pct-input')) pitState[idx].refuelPct = parseFloat(t.value) || 0;
                        if (t.classList.contains('driver-select'))    pitState[idx].driver    = parseInt(t.value);

                        pitState[idx]._userSet = true;
                    }

                    // Déclencher le recalcul APRÈS le commit dans pitState
                    window._liveModeActive ? recalculateLive() : calculate();
                    _dirtyPitState = true;
                } else if (t.id === 'driverCount' || t.id?.startsWith('driverColor_')
                           || t.id?.startsWith('driverName_')) {
                    _dirtyDrivers = true;
                } else if (t.id) {
                    _dirtyFields.add(t.id);
                }

                // La valeur est validée (événement "change") : on peut relâcher
                // le verrou d'édition locale posé par le listener "input".
                delete t.dataset.localEditing;

                pushToFirebase(!!isPit);
            });

            /* Debounce pour les inputs numériques pit (refuel, durée stand) :
               on commit immédiatement dans pitState (pas de perte de valeur),
               mais on diffère le recalcul DOM de 800ms pour ne pas
               reconstruire le tableau à chaque frappe. */
            let _pitInputDebounce = null;

            document.addEventListener('input', e => {
                // Comme pour "change", _isSyncing ne doit plus empêcher la saisie
                // locale d'être prise en compte — seulement l'envoi réseau.
                if (window._applyingRemote) return;
                const t = e.target;

                const isPitNumeric = t.matches('.stop-dur-input, .refuel-pct-input')
                    || !!t.closest('.stop-dur-input, .refuel-pct-input');
                const isRefuelRate = t.matches('#refuelRate');

                if (isPitNumeric && t.closest) {
                    const tr = t.closest('tr[data-stint-idx]');
                    if (tr && tr.dataset.past !== 'true') {
                        const idx = parseInt(tr.dataset.stintIdx);
                        if (!pitState[idx]) pitState[idx] = defaultState();

                        // Commit immédiat dans pitState (valeur conservée)
                        if (t.classList.contains('stop-dur-input'))
                            pitState[idx].stopDur   = parseFloat(t.value) || 0;
                        if (t.classList.contains('refuel-pct-input'))
                            pitState[idx].refuelPct = parseFloat(t.value) || 0;
                        pitState[idx]._userSet = true;
                        _dirtyPitState = true;

                        // Bloquer l'écrasement par une mise à jour distante pendant la saisie :
                        // on marque le champ comme "en cours d'édition locale"
                        t.dataset.localEditing = 'true';

                        // Recalcul ET push différés — délai allongé à 1200ms
                        // pour laisser l'utilisateur finir de taper
                        clearTimeout(_pitInputDebounce);
                        _pitInputDebounce = setTimeout(() => {
                            delete t.dataset.localEditing;
                            window._liveModeActive ? recalculateLive() : calculate();
                            pushToFirebase(true);
                        }, 1200);

                        return;
                    }
                }

                if (isRefuelRate) {
                    t.dataset.localEditing = 'true';
                    _dirtyFields.add('refuelRate');
                    clearTimeout(_pitInputDebounce);
                    _pitInputDebounce = setTimeout(() => {
                        delete t.dataset.localEditing;
                        window._liveModeActive ? recalculateLive() : calculate();
                        pushToFirebase(true);
                    }, 1200);
                    return;
                }

                // Tous les autres inputs (non-pit) : on marque le champ comme
                // "en cours d'édition locale" pour éviter qu'une mise à jour distante
                // n'écrase la frappe en cours (applyFormData respecte ce verrou),
                // puis on envoie après un court débounce.
                if (t.id) {
                    t.dataset.localEditing = 'true';
                    if (t.classList.contains('tyre-wear-input')) {
                        _dirtyTyreWear = true;
                    } else if (t.id.startsWith('driverName_') || t.id.startsWith('driverColor_')) {
                        _dirtyDrivers = true;
                    } else {
                        _dirtyFields.add(t.id);
                    }
                    clearTimeout(t._syncEditDebounce);
                    t._syncEditDebounce = setTimeout(() => {
                        delete t.dataset.localEditing;
                    }, 600);
                }

                pushToFirebase(false);
            });

        }            

/* ── Démarrage ── */

let _firebaseInitDone = false;

function onFirebaseReady() {
    if (_firebaseInitDone) return;
    _firebaseInitDone = true;

    const initUI = () => {

        /*
         * Tant que l'écran "Accès équipe" est présent,
         * aucune initialisation interactive du calculateur
         * ni des sessions n'est lancée.
         */
        const gate = document.getElementById('accessGate');

        if (gate) {
            const passwordInput = document.getElementById('gatePassword');
            if (passwordInput) passwordInput.focus();
            return;
        }

        renderSessionUI();

        if (!document.body.dataset.hooksAttached) {
            hookSyncToInputs();
            document.body.dataset.hooksAttached = 'true';
        }

        loadCircuitsFromFirebase();
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initUI, { once: true });
    } else {
        initUI();
    }
}


		window.addEventListener('firebaseReady', onFirebaseReady);
		if (window._firebaseReady) onFirebaseReady();

// Remarque : le retrait du gate et l'initialisation de l'UI de session
// (renderSessionUI / hookSyncToInputs / loadCircuitsFromFirebase) sont
// désormais pilotés par l'état d'authentification Firebase, voir
// js/access-gate.js (_onAuthReady). Ce fichier n'a plus besoin de
// vérifier lui-même un mot de passe stocké en sessionStorage.


