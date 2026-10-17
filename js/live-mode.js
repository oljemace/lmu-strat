/* ── Appelé quand on change la gomme G ou D en live ── */
function onLiveTyreCompoundChange() {
    const cL = document.getElementById('liveTyreCompoundLeft')?.value  || 'none';
    const cR = document.getElementById('liveTyreCompoundRight')?.value || 'none';
    window._liveTyreState.compoundLeft  = cL;
    window._liveTyreState.compoundRight = cR;
    // Rétrocompatibilité : compound = côté le plus contraignant ou left par défaut
    window._liveTyreState.compound = cL !== 'none' ? cL : cR;
    _updateLiveTyreWearLabels();
    if (window._liveModeActive) recalculateLive();
}

function recalculateLive(silent) {
    const evCurrent  = parseFloat(document.getElementById('evCurrent').value);
    const evPerLapR  = parseFloat(document.getElementById('evPerLapReal').value);
    const evRefuel   = parseFloat(document.getElementById('evRefuelPerStint').value);

    // Nombre de tours complets déjà effectués au moment du recalcul live
    const liveLapsCompleted = Math.max(
        0,
        parseInt(document.getElementById('liveLapsCompleted')?.value) || 0
    );

    // ── Activer l'UI mode live ──
    document.body.classList.add('live-mode');
    const btnStop   = document.getElementById('btnStopLive');
    const liveBadge = document.getElementById('liveModeBadge');
    if (btnStop)   btnStop.style.display   = 'inline-block';
    if (liveBadge) liveBadge.style.display = 'inline-block';

    const ltM = parseInt(document.getElementById('livelapMinutes').value) || 0;
    const ltS = parseInt(document.getElementById('livelapSeconds').value) || 0;
    const ltD = parseInt(document.getElementById('livelapMillis').value)  || 0;
    const liveLapTime = ltM * 60 + ltS + ltD / 10;

    // En mode silencieux (appel automatique depuis le poll live, voir
    // live-telemetry.js), une donnée pas encore disponible (ex: aucun tour
    // terminé donc pas de conso EV/tour mesurée) n'est PAS une erreur à faire
    // remonter à l'utilisateur via alert() — ça bloquerait l'UI en boucle à
    // chaque poll (jusqu'à 50x/s) tant que la donnée manque. On attend juste
    // le prochain poll avec des données exploitables.
    const fail = msg => { if (!silent) alert(msg); return; };
    if (isNaN(evPerLapR) || evPerLapR <= 0) { fail("Conso EV réelle invalide");    return; }
    if (isNaN(evRefuel)  || evRefuel  <= 0) { fail("Recharge EV invalide");        return; }
    if (liveLapTime <= 0)                   { fail("Temps au tour réel invalide"); return; }
    if (isNaN(evCurrent) || evCurrent < 0)  { fail("EV actuelle invalide");        return; }

    const realStart    = getRealStart();
    const totalRaceSec = getRaceTimeInSeconds();
    const raceEndSec   = realStart + totalRaceSec;

    const _now = new Date();
    let nowSec = _now.getHours() * 3600 + _now.getMinutes() * 60 + _now.getSeconds();

    // Normalisation cross-midnight :
    // Si la course finit après minuit (raceEndSec > 86400)
    // ET que l'heure actuelle est après minuit mais avant realStart
    // (ex: realStart=18h30, maintenant=17h01 → c'est bien le même jour,
    //  mais si maintenant=00h30 → c'est le lendemain → +86400)
    if (!(window._liveSessionTimeRemainingSec != null && !isNaN(window._liveSessionTimeRemainingSec)) && raceEndSec > 86400 && nowSec < realStart && nowSec < 43200) {
        nowSec += 86400;
    }

    // Durée restante : priorité à la valeur renvoyée EN DIRECT par le jeu
    // (window._liveSessionTimeRemainingSec, alimentée dans live-telemetry.js —
    // c'est la même valeur que "Durée de course restante" affichée en haut du
    // panneau live). L'ancien calcul heure de départ/durée saisies en
    // Planification ne décrit QUE la course planifiée et dérive dès qu'on est
    // en direct sur une séance réelle (retard/avance au départ, essais,
    // qualifs…) — il n'est gardé qu'en repli, pour le mode live "manuel" sans
    // connexion décrit dans le panneau ("Sans connexion, les champs restent
    // modifiables à la main").
    const liveSessionRemaining = window._liveSessionTimeRemainingSec;
    const hasLiveSessionTime   = liveSessionRemaining != null && !isNaN(liveSessionRemaining);
    const liveRaceSec = hasLiveSessionTime
        ? Math.max(0, liveSessionRemaining)
        : Math.max(0, raceEndSec - nowSec);
    if (liveRaceSec <= 0) { fail("Durée de course restante nulle ou déjà écoulée."); return; }

    // "Durée de course" effective (écoulé + restant) utilisée pour calculate()
    // ci-dessous, pour que le tableau de stints détaillé reste cohérent avec ce
    // récapitulatif plutôt que de recalculer sa propre fin de course à partir de
    // totalRaceSec saisi en Planification.
    const anchorRealStart = hasLiveSessionTime ? nowSec : realStart;
    const effectiveTotalRaceSec = hasLiveSessionTime
        ? liveRaceSec
        : totalRaceSec;

    // Mémoriser l'ancrage
    window._liveNowSec     = nowSec;
    window._liveEvAtAnchor = evCurrent;
    window._liveModeActive = true;

    // Mettre à jour l'état pneus live depuis les champs
    const _ltsCmpdL = document.getElementById('liveTyreCompoundLeft')?.value  || 'none';
    const _ltsCmpdR = document.getElementById('liveTyreCompoundRight')?.value || 'none';
    const _ltsCmpd  = _ltsCmpdL !== 'none' ? _ltsCmpdL : _ltsCmpdR; // rétrocompat    
    const _ltsWL   = parseFloat(document.getElementById('liveTyreWearLeft')?.value);
    const _ltsWR   = parseFloat(document.getElementById('liveTyreWearRight')?.value);
    const _ltsBudg = document.getElementById('liveTyreBudget')?.value;

    window._liveTyreState = {
        compound:      _ltsCmpd,
        compoundLeft:  _ltsCmpdL,
        compoundRight: _ltsCmpdR,
        wearLeft:      isNaN(_ltsWL) ? null : Math.min(100, Math.max(0, _ltsWL)),
        wearRight:     isNaN(_ltsWR) ? null : Math.min(100, Math.max(0, _ltsWR)),
        budget:        (_ltsBudg !== '' && _ltsBudg !== undefined) ? parseInt(_ltsBudg) : null,
    };    
    _updateLiveTyreWearLabels();

    /* ── Calcul du récapitulatif live (panneau résultats) ── */
    const toursParStintRef  = evRefuel / evPerLapR;
    const toursStintCourant = Math.min(evCurrent / evPerLapR, liveRaceSec / liveLapTime);
    const dureeStintCourant = toursStintCourant * liveLapTime;

    // Le récapitulatif reprend le plan que calculate() construit ci-dessous
    // (recharge du pit précédant le dernier stint ajustée comme en
    // planification), pour que le nombre de stints colle exactement à la table.
    _runLiveCalculate();
    const futurePlan        = (window._livePlanStints || []).filter(s => !s.current);
    const stintsFutursCount = futurePlan.length;
    const toursFuturs       = futurePlan.reduce((t, s) => t + s.tours, 0);

    const toursRestantsTotal = toursStintCourant + toursFuturs;
    // Stints restants en dixièmes : stint courant (fraction) + stints futurs entiers
    const toursParStintRef2  = evRefuel / evPerLapR;   // tours max par stint complet
    const fractionStintCourant = toursParStintRef2 > 0
        ? toursStintCourant / toursParStintRef2
        : 1;
    const stintsRestants = fractionStintCourant + stintsFutursCount;
    
    const result = document.getElementById('liveRecalcResult');
    result.style.display = 'block';
    document.getElementById('liveTempsRestant').textContent  = formatDuration(liveRaceSec);
    document.getElementById('liveToursRestants').textContent = toursRestantsTotal.toFixed(1) + ' tours';
    document.getElementById('liveToursParStint').textContent =
        toursStintCourant.toFixed(1) + ' tours (' + formatDuration(dureeStintCourant) + ')';
    document.getElementById('liveStintsRestants').textContent = stintsRestants.toFixed(1);
    document.getElementById('liveDureeStint').textContent     = formatDuration(toursParStintRef * liveLapTime);

    const elConsoTarget       = document.getElementById('liveConsoTarget');
    const elConsoTargetDetail = document.getElementById('liveConsoTargetDetail');
    const stintsCibleMoins1   = stintsRestants - 1;

    if (stintsCibleMoins1 <= 0 || toursRestantsTotal <= 0) {
        if (elConsoTarget)       elConsoTarget.textContent       = '—';
        if (elConsoTargetDetail) elConsoTargetDetail.textContent = 'Dernier stint en cours';
    } else {
        const toursParStintCible = toursRestantsTotal / stintsCibleMoins1;
        const evPerLapCible      = evRefuel / toursParStintCible;
        const economiePct        = evPerLapR - evPerLapCible;
        const ratio              = Math.abs(economiePct) / evPerLapR;

        const message = ratio <= 0.02 ? '🟢 Lift & Coast'
                      : ratio <= 0.04 ? '🟡 Lift & Coast possible'
                      :                 '🔴 Pas de Lift & Coast';

        if (elConsoTarget) {
            elConsoTarget.textContent = `${evPerLapCible.toFixed(2)}%/tour ${message}`;
            elConsoTarget.style.color = ratio > 0.04 ? '#ff4444'
                                      : ratio > 0.02 ? '#ffaa00'
                                      : '#00ff88';
        }
    }

    document.getElementById('liveRecalcNote').textContent =
        `Ancrage : ${formatClock(nowSec)} · EV : ${evCurrent.toFixed(1)}% · `
      + `Fin prévue : ${formatClock(hasLiveSessionTime ? nowSec + liveRaceSec : raceEndSec)}`;

    // Recalcul complet de la table et de la timeline (appelé plus haut, avant
    // le récapitulatif, dont les chiffres en dépendent).
    function _runLiveCalculate() {
    window._liveMode = true;
    _dirtyPitState = true;
    ['_liveModeActive','_liveEvAtAnchor','_liveNowSec','evCurrent','evPerLapReal',
     'livelapMinutes','livelapSeconds','livelapMillis','liveLapsCompleted']
        .forEach(k => _dirtyFields.add(k));
    pushToFirebase(true);

    window._livePlanStints = null;
calculate({
    lapTime:            liveLapTime,
    evPerLap:           evPerLapR,
    realStart:          anchorRealStart,
    // Durée effective (écoulé + restant mesuré en direct quand dispo, voir
    // effectiveTotalRaceSec plus haut) : garde le tableau de stints détaillé
    // cohérent avec le récapitulatif ci-dessus plutôt que de recalculer sa
    // propre fin de course à partir de la durée saisie en Planification.
    totalRaceSec:       effectiveTotalRaceSec,
    _liveNowSec:        nowSec,
    _liveEvCurrent:     evCurrent,
    _liveLapsCompleted: liveLapsCompleted,
    // Horloge ingame lue en direct dans la mémoire partagée (voir
    // live-telemetry.js) ; absent tant qu'aucune connexion live n'a
    // encore été établie, auquel cas calculate() se replie sur l'heure
    // de départ ingame configurée manuellement en planification.
    _liveGameClockNow:  window._liveGameClockNow,
    _fromPoll:          !!silent,
});

    window._liveMode = false;
    }
}

