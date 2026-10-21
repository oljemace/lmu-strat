/* ── Calculer depuis le bouton principal : stoppe le mode live si actif ── */

function calculateFromButton() {
    // Animation rideau descendant vers la timeline
    const timelineSection = document.querySelector('.timeline-section');
    if (timelineSection) {
        // Masquer temporairement la section pour éviter un flash
        timelineSection.style.transition = 'none';
        
        // Lancer l'animation après un court délai (laisser le recalcul se faire)
        setTimeout(() => {
            const targetY = timelineSection.getBoundingClientRect().top + window.scrollY;
            
            // Créer l'overlay rideau
            const curtain = document.createElement('div');
            curtain.id = 'calcCurtain';
            curtain.style.cssText = `
                position: fixed;
                top: 0; left: 0; right: 0;
                height: 0%;
                background: linear-gradient(135deg, var(--bg-1) 0%, var(--bg-2) 100%);
                z-index: 99998;
                transition: height 0.35s cubic-bezier(0.4, 0, 0.2, 1);
                display: flex;
                align-items: center;
                justify-content: center;
                overflow: hidden;
            `;

            const curtainLabel = document.createElement('div');
            curtainLabel.style.cssText = `
                color: var(--accent);
                font-size: 1.6em;
                font-weight: bold;
                opacity: 0;
                transition: opacity 0.2s ease 0.15s;
                text-shadow: 0 0 20px rgba(0,255,136,0.5);
                letter-spacing: 0.05em;
            `;
            curtainLabel.textContent = '🏎️ Calcul en cours…';
            curtain.appendChild(curtainLabel);
            document.body.appendChild(curtain);

            // Phase 1 : rideau descend (couvre l'écran)
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    curtain.style.height = '100%';
                    curtainLabel.style.opacity = '1';
                });
            });

            // Phase 2 : scroll + recalcul pendant que le rideau couvre tout
            setTimeout(() => {
                window.scrollTo({ top: targetY - 60, behavior: 'instant' });
            }, 300);

            // Phase 3 : rideau remonte (révèle la timeline)
            setTimeout(() => {
                curtain.style.transition = 'height 0.45s cubic-bezier(0.4, 0, 0.2, 1)';
                curtain.style.height = '0%';
                curtainLabel.style.opacity = '0';
                setTimeout(() => curtain.remove(), 500);
            }, 600);

        }, 50);
    }

    // Planification et Live sont deux tables indépendantes désormais : ce bouton
    // ne touche plus qu'à la table de planification, et ne doit plus interférer
    // avec un éventuel mode live en cours dans l'autre panneau.
    calculate();

    _dirtyPitState = true;
    pushToFirebase(true);
}

/* ── Calcul principal ── */
function calculate(overrides) {
    savePitState();

    const ov = overrides || {};
    // Capturé une fois pour toutes ici : utilisé par les callbacks différés
    // (requestAnimationFrame) plus bas, car window._liveMode redevient false
    // dès le retour de recalculateLive(), avant que ces callbacks ne s'exécutent.
    const _isLiveCalc = window._liveMode;

    // ── Purger les anciens "derniers stints" automatiques ──
    Object.keys(pitState).forEach(k => {
        if (pitState[k]._autoLast) delete pitState[k];
    });

    const lapTime          = ov.lapTime   || getLapTimeInSeconds();
    const evPerLap         = ov.evPerLap  || parseFloat(document.getElementById('evPerLap').value);
    const evRemaining      = parseFloat(document.getElementById('evRemaining').value);
    const evRefuelPerStint = parseFloat(document.getElementById('evRefuelPerStint').value);
    const multiplier       = parseInt(document.getElementById('timeMultiplier').value);

    const realStart = ov.realStart !== undefined ? ov.realStart : getRealStart();
    // Mode live : l'horloge ingame vient de la mémoire partagée (lue en direct), pas
    // d'un champ "Heure de départ ingame" saisi à la main. gameStart représente alors
    // directement l'heure ingame ACTUELLE (ancrage "maintenant"), d'où cG forcé à 0
    // plus bas — même principe que realStart/cR pour l'horloge réelle.
    const gameStart = (window._liveMode && ov._liveGameClockNow !== undefined)
        ? ov._liveGameClockNow
        : toSec(
            parseInt(document.getElementById('gameStartHours').value)   || 0,
            parseInt(document.getElementById('gameStartMinutes').value) || 0
        );

    if (isNaN(lapTime)          || lapTime <= 0)          { alert("Temps au tour invalide");  return; }
    if (isNaN(evPerLap)         || evPerLap <= 0)         { alert("Conso EV/tour invalide");  return; }
    if (isNaN(evRefuelPerStint) || evRefuelPerStint <= 0) { alert("Recharge EV invalide");    return; }

    const totalRaceSec   = ov.totalRaceSec !== undefined ? ov.totalRaceSec : getRaceTimeInSeconds();
    const toursParStint  = evRefuelPerStint / evPerLap;
    const dureeStintReel = toursParStint * lapTime;

    // ── Garde-fou cross-midnight pour le mode live ──
    // Si la course passe minuit et que nowSec est après minuit,
    // il faut s'assurer que raceEndSec = realStart + totalRaceSec
    // est bien dans l'espace "étendu" (> 86400).
    // Le realStart peut être négatif (case "hier") ou normal.
    // Dans tous les cas, on vérifie la cohérence ici une seule fois.

    /* ══════════════════════════════════════════════════════════════════
       CALCUL ITÉRATIF — pits déduits du temps de course
       Converge en ≤ 2 itérations sur 5.
    ══════════════════════════════════════════════════════════════════ */
    let toursTheorique  = 0;
    let stintsTheorique = 0;
    let totalPitTheoSec = 0;
    let tempsRoulageNet = totalRaceSec;
    let nbPitsTheo      = 0;
    let stintsNaturelsPlan = 0;   // nb de stints sans stint manuel (planification)

    if (!window._liveMode) {

        // 1) Plan "naturel" (sans stint manuel) : point fixe stints ↔ pits.
        let stintsEstime = totalRaceSec / (toursParStint * lapTime);

        for (let iter = 0; iter < 5; iter++) {
            const nbStintsVises = Math.ceil(stintsEstime);
            nbPitsTheo = Math.max(0, nbStintsVises - 1);

            totalPitTheoSec = 0;
            for (let i = 0; i < nbPitsTheo; i++) {
                totalPitTheoSec += getPitDuration(i);
            }

            tempsRoulageNet = Math.max(0, totalRaceSec - totalPitTheoSec);
            toursTheorique  = tempsRoulageNet / lapTime;
            stintsEstime    = toursTheorique  / toursParStint;
        }

        stintsTheorique = stintsEstime;
        stintsNaturelsPlan = Math.ceil(stintsEstime);

        // 2) Stints manuels : chaque stint manuel ajoute un arrêt EN FIN de course
        //    (les stints pleins ne bougent pas, la fin est scindée en stints plus
        //    courts). Le temps des pits supplémentaires est retiré du roulage.
        if (window._manualStintCount > 0) {
            const stintsTotal = stintsNaturelsPlan + window._manualStintCount;
            nbPitsTheo      = stintsTotal - 1;
            totalPitTheoSec = 0;
            for (let i = 0; i < nbPitsTheo; i++) {
                totalPitTheoSec += getPitDuration(i);
            }
            tempsRoulageNet = Math.max(0, totalRaceSec - totalPitTheoSec);
            toursTheorique  = tempsRoulageNet / lapTime;
            stintsTheorique = stintsTotal;
        }

    } else {
        const nowSecLive      = ov._liveNowSec !== undefined ? ov._liveNowSec : (window._liveNowSec || 0);
        const raceEndLive     = realStart + totalRaceSec;
        const liveRaceSecCalc = Math.max(0, raceEndLive - nowSecLive);

        toursTheorique  = liveRaceSecCalc / lapTime;
        stintsTheorique = toursTheorique  / toursParStint;
    }

    /* ── Affichage résultats ── */
    const totalPitMin  = Math.floor(totalPitTheoSec / 60);
    const totalPitSecR = Math.round(totalPitTheoSec % 60);
    const pitLabel     = totalPitTheoSec > 0
        ? `${totalPitMin > 0 ? totalPitMin + 'min ' : ''}${totalPitSecR}s de pits déduits`
        : 'Aucun pit';

    // En mode live, le récapitulatif "tours/stints restants" est déjà affiché
    // dans le panneau Live (liveRecalcResult, géré par recalculateLive()) :
    // on n'écrit pas ici pour ne pas écraser le récapitulatif de planification.
    if (!window._liveMode) {
        document.getElementById('toursRemaining').textContent       = toursTheorique.toFixed(2);
        document.getElementById('stintsRemaining').textContent      = stintsTheorique.toFixed(2);
        document.getElementById('toursRemainingDetail').textContent =
            `Temps au tour : ${getLapTimeDisplay()} · Roulage net : ${formatDuration(tempsRoulageNet)}`;
        document.getElementById('stintsRemainingDetail').textContent =
            `${nbPitsTheo} pit(s) · ${pitLabel}`;
        document.getElementById('calcStintLaps').textContent        = toursParStint.toFixed(2) + ' tours';
        document.getElementById('calcStintTime').textContent        = formatDuration(dureeStintReel);
    }

    /* ══════════════════════════════════════════════════════════════════
       CONSTRUCTION DE LA LISTE DES STINTS
    ══════════════════════════════════════════════════════════════════ */
    const stints = [];

    // Valeur EV d'ancrage pour l'affichage colonne EV Conso en mode live
    const _liveEvDisplay = window._liveMode
        ? (ov._liveEvCurrent !== undefined
            ? ov._liveEvCurrent
            : parseFloat(document.getElementById('evCurrent').value) || 0)
        : null;

      if (window._liveMode) {
        /* ══════════════════════════════════════════════════════════════════
           MODE LIVE — Construction des stints à partir de l'ancrage courant.
           
           Stint 0  = stint en cours   (EV actuelle → jusqu'à épuisement EV ou fin de course)
           Stint 1+ = stints futurs    (EV rechargée selon pitState[idx].refuelPct)
           
           pitState est PRÉSERVÉ : l'utilisateur garde la main sur
           stop/refuel/pneus pour chaque stint futur.
        ══════════════════════════════════════════════════════════════════ */
        // Restaure les recharges ajustées automatiquement au recalcul précédent :
        // le plan est recalculé de zéro, sinon le refuel réduit fausserait la
        // détection du dernier stint (recharge pleine) et le nombre de stints.
        Object.keys(pitState).forEach(k => {
            const p = pitState[k];
            if (!p._autoRefuel) return;
            if (!p._userSet) p.refuelPct = p._autoRefuelOrig;
            delete p._autoRefuel;
            delete p._autoRefuelOrig;
        });

        const nowSecLive    = ov._liveNowSec !== undefined ? ov._liveNowSec : (window._liveNowSec || 0);
        const evCurrentLive = ov._liveEvCurrent !== undefined
                            ? ov._liveEvCurrent
                            : (parseFloat(document.getElementById('evCurrent').value) || 0);

        const raceEndLive     = realStart + totalRaceSec;
        const liveRaceSecCalc = Math.max(0, raceEndLive - nowSecLive);

        /* ── Stint 0 : en cours ── */
        const toursMaxEV0       = evCurrentLive / evPerLap;
        const toursStintCourant = Math.min(toursMaxEV0, liveRaceSecCalc / lapTime);

        if (toursStintCourant > 0.01) {
            stints.push({
                tours:    toursStintCourant,
                fraction: toursMaxEV0 > 0 ? Math.min(1, toursStintCourant / toursMaxEV0) : 1,
                evDebut:  evCurrentLive,
                _current: true,
            });
        }

        /* ── Stints suivants : propagation EV via pitState ── */
        // Pit après stint courant
        const pitApres0  = getPitDuration(0);
        const ps0Live    = pitState[0] || defaultState();
        const evFin0     = Math.max(0, evCurrentLive - toursStintCourant * evPerLap);

        // Comme en planification, le dernier stint n'absorbe que le roulage
        // restant : si, avec une recharge pleine, le stint suivant finirait la
        // course avant d'avoir vidé son EV, on réduit la recharge du pit qui le
        // précède au strict nécessaire (le pit raccourcit d'autant, le dernier
        // stint gagne ce temps). Sans cela le plan compterait un stint de trop
        // ou immobiliserait la voiture pour de l'énergie jamais consommée.
        // Ne touche jamais un pit modifié à la main (_userSet).
        const _adjustRefuelBeforeLast = (pitIdx, evFin, tempsApresStint) => {
            let ps = pitState[pitIdx];
            if (!ps) ps = pitState[pitIdx] = defaultState();
            if (ps._userSet || !ps.stop || !ps.refuel) return;
            const rateL    = parseFloat(document.getElementById('refuelRate')?.value) || 5;
            const base     = (ps.stopDur || 0)
                           + (ps.left ? TYRE_PENALTY : 0) + (ps.right ? TYRE_PENALTY : 0);
            const full     = ps.refuelPct || 0;
            const evFull   = Math.min(100, evFin + full);
            const dispo    = tempsApresStint - base - full * rateL;
            // Le stint suivant n'est pas le dernier (EV insuffisante) ou pas de temps
            if (dispo <= 0 || (evFull / evPerLap) * lapTime < dispo) return;
            const k = rateL * evPerLap / lapTime;
            let r = (((tempsApresStint - base) / lapTime) * evPerLap - evFin) / (1 + k);
            r = Math.min(full, Math.max(0, Math.ceil(r * 10) / 10));
            if (r >= full) return;
            ps._autoRefuelOrig = full;
            ps._autoRefuel     = true;
            ps.refuelPct       = r;
        };

        _adjustRefuelBeforeLast(0, evFin0, liveRaceSecCalc - toursStintCourant * lapTime);
        const refuel0    = (ps0Live.stop && ps0Live.refuel) ? ((pitState[0] || ps0Live).refuelPct || 0) : 0;
        const pitApres0b = getPitDuration(0);
        const evFuturStart      = Math.min(100, evFin0 + refuel0);
        const tempsRestantStart = Math.max(0, liveRaceSecCalc - toursStintCourant * lapTime - pitApres0b);

        // ── Nombre de stints futurs "naturels" (sans stint manuel forcé) ──
        // Rejoue la même boucle que ci-dessous, en ne faisant QUE compter, pour
        // connaître le nombre cible une fois les stints manuels live ajoutés.
        const _countNaturalFutureStints = () => {
            let evF = evFuturStart, tR = tempsRestantStart, idx = 1, n = 0;
            while (tR > lapTime * 0.1 && idx < 60) {
                if (evF < 0.01) break;
                const toursMaxEVi = evF / evPerLap;
                const dureeIci    = Math.min(toursMaxEVi * lapTime, tR);
                if (dureeIci / lapTime < 0.01) break;
                n++;
                if (dureeIci >= tR - 0.1) break;
                tR -= dureeIci + getPitDuration(idx);
                const evFinIci = Math.max(0, evF - (dureeIci / lapTime) * evPerLap);
                const psNext   = pitState[idx] || defaultState();
                evF = Math.min(100, evFinIci + ((psNext.stop && psNext.refuel) ? (psNext.refuelPct || 0) : 0));
                idx++;
            }
            return n;
        };

        const manualCountLive         = Math.max(0, window._manualStintCountLive || 0);
        const stintsNaturalFutureLive = _countNaturalFutureStints();
        // Cible = naturel + manuel, SAUF si aucun stint manuel : dans ce cas on garde
        // la cible "illimitée" (Infinity) pour ne RIEN changer au comportement déjà
        // vérifié en conditions réelles — le plafonnement par toursParStint ci-dessous
        // ne s'active que lorsqu'un stint manuel a effectivement été demandé.
        const stintsCibleFutureLive = manualCountLive > 0
            ? stintsNaturalFutureLive + manualCountLive
            : Infinity;

        let evFutur      = evFuturStart;
        let tempsRestant = tempsRestantStart;
        let idxLive      = 1;

        while (tempsRestant > lapTime * 0.1 && idxLive < 60) {
            if (evFutur < 0.01) break;

            const toursMaxEVi  = evFutur / evPerLap;
            // Plafond supplémentaire à toursParStint sur les stints non-derniers
            // UNIQUEMENT quand des stints manuels live forcent une répartition plus
            // fine (comportement identique à avant sinon, voir stintsCibleFutureLive).
            // Stints manuels : chaque stint manuel ajoute un arrêt EN FIN de course.
            // Les stints pleins sont plafonnés à toursParStint ; le groupe final
            // (dernier stint naturel + stints manuels) se partage à parts égales le
            // temps restant, une fois déduits les pits qui les séparent.
            let dureeMaxEVi = toursMaxEVi * lapTime;
            if (manualCountLive > 0) {
                if (idxLive >= Math.max(1, stintsNaturalFutureLive)) {
                    let pitsApres = 0;
                    for (let j = idxLive; j < stintsCibleFutureLive; j++) pitsApres += getPitDuration(j);
                    const restants = stintsCibleFutureLive - idxLive + 1;
                    dureeMaxEVi = Math.min(dureeMaxEVi, Math.max(0, tempsRestant - pitsApres) / restants);
                } else {
                    dureeMaxEVi = Math.min(dureeMaxEVi, toursParStint * lapTime);
                }
            }
            const dureeIci     = Math.min(dureeMaxEVi, tempsRestant);
            const toursIci     = dureeIci / lapTime;

            if (toursIci < 0.01) break;

            stints.push({
                tours:    toursIci,
                fraction: toursMaxEVi > 0 ? Math.min(1, toursIci / toursMaxEVi) : 0,
                evDebut:  evFutur,
                _manual:  manualCountLive > 0 && idxLive > stintsNaturalFutureLive,
            });

            // Dernier stint : on s'arrête
            if (dureeIci >= tempsRestant - 0.1) break;

            // Pit suivant + propagation EV (recharge ajustée si le stint d'après est le dernier)
            const evFinIci   = Math.max(0, evFutur - toursIci * evPerLap);
            if (manualCountLive === 0) {
                _adjustRefuelBeforeLast(idxLive, evFinIci, tempsRestant - dureeIci);
            }
            const pitSuivant = getPitDuration(idxLive);
            tempsRestant    -= dureeIci + pitSuivant;

            const psNext     = pitState[idxLive] || defaultState();
            const refuelNext = (psNext.stop && psNext.refuel) ? (psNext.refuelPct || 0) : 0;
            evFutur          = Math.min(100, evFinIci + refuelNext);

            idxLive++;
        }

        // Plan exposé au récapitulatif du panneau live (recalculateLive) pour que
        // le nombre de stints affiché colle exactement à la table.
        window._livePlanStints = stints.map(s => ({ tours: s.tours, current: !!s._current }));

        /* ── Désactiver stop/refuel sur le dernier stint si pas userSet ── */
        const lastLiveIdx = stints.length - 1;
        if (lastLiveIdx >= 0) {
            if (!pitState[lastLiveIdx]) {
                pitState[lastLiveIdx] = defaultState();
                pitState[lastLiveIdx].stop   = false;
                pitState[lastLiveIdx].refuel = false;
            } else if (!pitState[lastLiveIdx]._userSet) {
                pitState[lastLiveIdx].stop   = false;
                pitState[lastLiveIdx].refuel = false;
            }
        }

    } else {

        /* ── MODE NORMAL avec stints manuels ──
            Principe :
           - On génère d'abord les stints "naturels" (limités par EV, toursParStint)
           - On ajoute ensuite les _manualStintCount stints supplémentaires
           - Le DERNIER stint de la liste (auto ou manuel) absorbe exactement
             le roulage restant pour que Σ(roulage + pits) = totalRaceSec
        ──────────────────────────────────────────────────────────────── */
        let evDebut     = evRemaining;
        let roulageRest = tempsRoulageNet;
        let idx         = 0;

        // ── Nombre cible de stints (auto + manuels) ──
        // On calcule combien de stints "naturels" on aurait sans contrainte manuelle
        const stintsNaturels      = stintsNaturelsPlan;
        const stintsCibleTotal    = stintsNaturels + window._manualStintCount;

        // ← NOUVEAU : purger les pitState au-delà du nombre de stints cible
        // Cela évite les stints fantômes lors d'un recalcul sans réinitialisation
        Object.keys(pitState).forEach(k => {
            if (parseInt(k) >= stintsCibleTotal) {
                delete pitState[k];
            }
        });

    // ── Génération des stints ──
    while (idx < stintsCibleTotal && idx < 60) {
        const ps     = pitState[idx] || defaultState();
        // Contrainte EV
        const toursEV = evDebut / evPerLap;

        // Stints pleins (plafonnés par l'EV) ; seul le tout dernier stint (auto ou
        // manuel) absorbe exactement le roulage restant.
        let toursStint;
        if (idx === stintsCibleTotal - 1) {
            toursStint = Math.min(toursEV, roulageRest / lapTime);
        } else {
            toursStint = Math.min(toursEV, toursParStint);
        }
        // ← Skip si rien à rouler (EV épuisée et pas de roulage restant)
         if (toursStint < 0.01) {
        idx++;
        continue;
        }
        // ← CORRECTION : on pousse quand même un stint à 0 tour
        // pour les stints manuels excédentaires, plutôt que de rompre
        const dureeRoule = toursStint * lapTime;
        const fraction   = toursStint / toursParStint;

        stints.push({
            tours:    Math.max(0, toursStint),
            fraction: Math.min(1, Math.max(0, fraction)),
            evDebut:  evDebut,
            _manual:  idx >= stintsNaturels
        });

        // Propagation EV
        const evFin  = Math.max(0, evDebut - toursStint * evPerLap);
        const refuel = ps.stop && ps.refuel ? (ps.refuelPct || 0) : 0;
        evDebut      = Math.min(100, evFin + refuel);

        roulageRest -= dureeRoule;

        idx++;

        // Arrêt anticipé uniquement si on a épuisé EV ET temps,
        // ET qu'il ne reste plus de stints manuels à forcer
        if (evDebut <= 0.01 && roulageRest < lapTime * 0.1 && idx >= stintsCibleTotal) break;
    }    
}

    /* ══════════════════════════════════════════════════════════════════
       GÉNÉRATION DE LA TABLE
    ══════════════════════════════════════════════════════════════════ */
    const tbody = document.getElementById(_tid('strategyTableBody'));

    // Mémoriser le focus avant de vider le tbody
    const _focusedEl    = document.activeElement;
    const _focusedTr    = _focusedEl ? _focusedEl.closest('tr[data-stint-idx]') : null;
    const _focusedStint = _focusedTr ? parseInt(_focusedTr.dataset.stintIdx) : -1;
    const _focusedClass = _focusedEl ? (_focusedEl.className || '') : '';
    const _focusedSide  = _focusedEl ? (_focusedEl.dataset?.side || '') : '';
    const _focusedVal   = (_focusedEl && _focusedEl.tagName === 'INPUT') ? _focusedEl.value : null;
    const _focusedSelStart = (_focusedEl && _focusedEl.type === 'text' && _focusedEl.selectionStart != null)
        ? _focusedEl.selectionStart : null;
    const _focusedSelEnd   = (_focusedEl && _focusedEl.type === 'text' && _focusedEl.selectionEnd != null)
        ? _focusedEl.selectionEnd   : null;

    // En live, recalculateLive() rappelle calculate() plusieurs fois par
    // seconde (poll télémétrie). Si l'utilisateur a actuellement un <select>
    // de la table ouvert (gomme, pilote…), reconstruire tbody.innerHTML sous
    // ses pieds détruit le popup natif avant qu'il ait pu cliquer une option.
    // On saute juste ce cycle : le "change" du select redéclenchera lui-même
    // le recalcul une fois le choix fait.
    // Uniquement pour le poll : le "change" d'un select garde le focus (le select reste
    // actif après le choix), donc son propre recalcul ne doit PAS être sauté, sinon ni la
    // table ni la timeline ne reflètent le choix.
    if (ov._fromPoll && _focusedEl && _focusedEl.tagName === 'SELECT' && tbody.contains(_focusedEl)) {
        return;
    }

    // Même principe pour un champ de saisie (refuel, durée d'arrêt…) : le poll
    // live ne doit pas détruire/recréer l'input en cours d'édition (clignotement
    // + perte de frappe). Les saisies manuelles relancent elles-mêmes calculate().
    if (ov._fromPoll && _focusedEl && _focusedEl.tagName === 'INPUT' && tbody.contains(_focusedEl)) {
        return;
    }

    // Reconstruction déclenchée par le poll live : on fige la hauteur de la page le
    // temps du rebuild, sinon elle s'effondre un instant (tbody vidé), le navigateur
    // ramène le scroll en arrière et l'écran saute/tremble à chaque rafraîchissement.
    if (ov._fromPoll) {
        const _h = document.documentElement.scrollHeight;
        document.body.style.minHeight = _h + 'px';
        requestAnimationFrame(() => requestAnimationFrame(() => { document.body.style.minHeight = ''; }));
        // Mesuré en direct : la table des stints est reconstruite en deux temps (lignes,
        // puis barres pneus/redimensionneurs dans des rAF) et se raccourcit d'environ
        // 22px pendant ~3ms, ce qui fait remonter puis redescendre tout ce qui est en
        // dessous. On fige donc la hauteur du bloc de la table jusqu'à la fin du rebuild.
        const _wrap = tbody.closest('.strategy-table-wrapper');
        if (_wrap) {
            _wrap.style.minHeight = _wrap.offsetHeight + 'px';
            clearTimeout(_wrap._unfreezeT);
            _wrap._unfreezeT = setTimeout(() => { _wrap.style.minHeight = ''; }, 400);
        }
    }

    tbody.innerHTML = '';

    // ── En mode live, cR part de nowSec - realStart (temps déjà écoulé).
    //    MAIS : si realStart + totalRaceSec > 86400 (course passant minuit)
    //    ET que nowSec est après minuit (ex: 01:00 = 3600s),
    //    il faut normaliser nowSec dans le même espace que realStart.
    //    Sans ça, cR serait négatif ou faux.
    let _liveNowSecNorm = 0;
    if (window._liveMode) {
        // Priorité : valeur passée en override (fraîche du recalculateLive)
        // Fallback : valeur mémorisée sur window
        _liveNowSecNorm = ov._liveNowSec !== undefined ? ov._liveNowSec : (window._liveNowSec || 0);

        // Normalisation cross-midnight
        const _raceEnd = realStart + totalRaceSec;
        if (_raceEnd > 86400 && _liveNowSecNorm < realStart && _liveNowSecNorm < 43200) {
            _liveNowSecNorm += 86400;
        }
    }
    
    let cR = window._liveMode ? Math.max(0, _liveNowSecNorm - realStart) : 0;
    // cG : si l'horloge ingame live est connue, gameStart EST déjà "maintenant"
    // (voir plus haut), donc cG démarre à 0, comme cR démarre à 0 par rapport à
    // realStart. Sans donnée live (repli manuel), gameStart reste l'heure de
    // départ ingame configurée : on retrouve alors l'ancien calcul par écart.
    let cG = (window._liveMode && ov._liveGameClockNow === undefined)
        ? Math.max(0, (_liveNowSecNorm - realStart) * multiplier)
        : 0;
    const rate = parseFloat(document.getElementById('refuelRate')?.value) || 5;
    
// En mode live, le tableau commence à partir du nombre réel de tours déjà effectués.
// En mode normal, la stratégie commence toujours au tour 0.
const liveLapsBase = window._liveMode
    ? Math.max(0, parseInt(ov._liveLapsCompleted) || 0)
    : 0;

let cumulTours = liveLapsBase;

stints.forEach((stint, idx) => {

    // ── Durée du pit QUI SUIT le stint précédent ──
    // Ce pit est affiché comme faisant partie du BLOC du stint précédent
    // (il termine ce stint-là), donc on l'ajoute à la durée du stint précédent,
    // pas à celle du stint courant.
    //
    // Pour l'affichage de la DURÉE RÉELLE d'un bloc (stint + son pit de sortie) :
    //   dR = tours × lapTime + pit_qui_suit_CE_stint
    //
    // Le pit qui PRÉCÈDE ce stint (= pit de sortie du stint idx-1)
    // est déjà comptabilisé dans le bloc précédent.
    //
    // Exception mode live : stints passés ont leur _durReelle calculée en amont.

    const pitAfter = (idx < stints.length - 1)   // pas de pit après le dernier stint
        ? getPitDuration(idx)
        : 0;

    const dR = (window._liveMode && stint._past && stint._durReelle !== undefined)
        ? stint._durReelle
        : stint.tours * lapTime + pitAfter;

    const dG  = dR * multiplier;
    const bR  = realStart + cR;
    const bG  = gameStart + cG;
    
        // Dernier stint : désactiver stop/refuel par défaut si pas déjà userSet
        const isLastStint = (idx === stints.length - 1);
        if (isLastStint) {
            if (!pitState[idx]) {
                pitState[idx] = defaultState();
                pitState[idx].stop   = false;
                pitState[idx].refuel = false;
            } else if (!pitState[idx]._userSet) {
                pitState[idx].stop   = false;
                pitState[idx].refuel = false;
            }
        }

        const st     = pitState[idx] || defaultState();
        cumulTours  += stint.tours;
        // Math.ceil : si le pit est prévu après 12.5 tours,
        // il est affiché au prochain tour entier, jamais au tour précédent.
        const tourPitDisplay = (idx < stints.length - 1)
        ? `T.${Math.ceil(cumulTours - 0.001)}`
        : '—';

        const evDebutStint = stint.evDebut !== undefined ? stint.evDebut : null;

        const dIdx   = st.driver ?? -1;
        const dColor = dIdx >= 0 ? getDriverColor(dIdx) : COLORS[idx % COLORS.length][0];
        const c      = dIdx >= 0
            ? [dColor, dColor + 'bb',
               parseInt(dColor.slice(1,3),16)*0.299
               + parseInt(dColor.slice(3,5),16)*0.587
               + parseInt(dColor.slice(5,7),16)*0.114 > 128 ? '#000' : '#fff']
            : COLORS[idx % COLORS.length];

        const pitThis    = getPitDuration(idx);
        const pitTxt     = pitThis > 0 ? `+${pitThis}s` : '—';
        const hasPitThis = pitThis > 0;

        let pitDetail = [];
        if (st.stop) {
            pitDetail.push(`Stand: ${st.stopDur}s`);
            if (st.refuel) pitDetail.push(`Refuel: ${(st.refuelPct * rate).toFixed(0)}s`);
            if (st.left)   pitDetail.push(`Pneu G: ${TYRE_PENALTY}s`);
            if (st.right)  pitDetail.push(`Pneu D: ${TYRE_PENALTY}s`);
        }

        // Label stint : badge "✏️ Manuel" pour les stints ajoutés manuellement
        const stintLabel = stint._manual
            ? `<span style="color:#00aaff;font-weight:bold;">Stint ${idx+1}</span>
               <span style="font-size:0.7em;color:#00aaff;opacity:0.8;"> ✏️</span>`
            : `<span style="color:${c[0]};font-weight:bold;">Stint ${idx+1}${stint.fraction < 1 ? ' ⚑' : ''}</span>`;

        const tr = document.createElement('tr');
        tr.dataset.stintIdx = idx;
        if (stint._manual) tr.dataset.manual = 'true';

        tr.innerHTML = `
            <td>${stintLabel}</td>

            <td>
                <select class="driver-select pit-input"
                    data-stint="${idx}"
                    style="width:90px;padding:4px 6px;">
                    ${getDriverOptions(pitState[idx]?.driver ?? -1)}
                </select>
            </td>

            <td style="text-align:center;">
                <span style="font-weight:bold;color:var(--text);font-size:0.95em;">
                    ${stint.tours.toFixed(2)}
                </span>
                ${evDebutStint !== null ? `
                <div style="font-size:0.68em;color:#88ccff;margin-top:1px;"
                    title="EV de départ de ce stint">
                    ⚡${evDebutStint.toFixed(1)}%
                </div>` : ''}
            </td>
            <td style="color:#aaffcc;font-weight:bold;font-size:0.82em;"
                title="Tour auquel a lieu ce pit stop">
                ${tourPitDisplay}
            </td>
            <td>${formatDuration(dR)}</td>
            <td>${formatDuration(dG)}</td>
            <td>${formatClock(bR)}</td>
            <td>${formatClock(bR + dR)}</td>
            <td>
                ${(window._liveMode && stint._current && _liveEvDisplay !== null)
                    ? `<strong style="color:var(--accent);">${_liveEvDisplay.toFixed(1)}%</strong>
                    <div style="font-size:0.7em;color:var(--text-3);">actuelle</div>`
                    : `${(stint.tours * evPerLap).toFixed(1)}%`
                }
            </td>
            <td class="pit-cell">
                <div class="pit-cell-inner">
                    <div class="pit-row">
                        <input type="checkbox" class="stop-check"
                            ${st.stop ? 'checked' : ''}
                            title="Activer arrêt au stand">
                    </div>
                    <div class="pit-row">
                        <input type="number" class="pit-input stop-dur-input"
                            value="${st.stopDur}" min="0" max="300" step="1"
                            title="Durée au stand (s)">
                        <span class="pit-unit">s</span>
                    </div>
                </div>
            </td>

            <td class="pit-cell">
                <div class="pit-cell-inner">
                ${st.stop ? `
                <div class="pit-row">
                    <input type="number" class="refuel-pct-input"
                        value="${st.refuelPct}" min="0" max="100" step="1"
                        title="Quantité refuel (%)">
                    <span class="pit-unit">%</span>
                </div>
                <div style="text-align:center;margin-top:2px;">
                    <span class="pit-duration">(${(st.refuelPct * rate).toFixed(0)}s)</span>
                </div>
            ` : '<div class="pit-row"><span style="color:#333;font-size:0.9em;">—</span></div>'}
                </div>
            </td>

            <td class="tyre-cell">
                <div class="pit-cell-inner">
                    ${st.stop ? `
                        <select class="tyre-compound-select has-tyre-${st.tyreLeft || 'none'}"
                            data-stint="${idx}" data-side="left"
                            title="Gomme côté gauche (+${TYRE_PENALTY}s si changement)">
                            <option value="none"  ${(st.tyreLeft||'none')==='none'   ?'selected':''}>—</option>
                            <option value="soft"  ${st.tyreLeft==='soft'  ?'selected':''}
                                style="color:var(--text-2);background:var(--input-bg);">⚪ Soft</option>
                            <option value="medium"${st.tyreLeft==='medium'?'selected':''}
                                style="color:#ffcc00;background:#1a1400;">🟡 Med</option>
                            <option value="hard"  ${st.tyreLeft==='hard'  ?'selected':''}
                                style="color:#ff6060;background:#1a0000;">🔴 Hard</option>
                            <option value="wet"   ${st.tyreLeft==='wet'   ?'selected':''}
                                style="color:#3399ff;background:#00101a;">🔵 Wet</option>
                        </select>
                    ` : '<span style="color:#333;font-size:0.9em;">—</span>'}
                </div>
            </td>

            <td class="tyre-cell">
                <div class="pit-cell-inner">
                    ${st.stop ? `
                        <select class="tyre-compound-select has-tyre-${st.tyreRight || 'none'}"
                            data-stint="${idx}" data-side="right"
                            title="Gomme côté droit (+${TYRE_PENALTY}s si changement)">
                            <option value="none"  ${(st.tyreRight||'none')==='none'   ?'selected':''}>—</option>
                            <option value="soft"  ${st.tyreRight==='soft'  ?'selected':''}
                                style="color:var(--text-2);background:var(--input-bg);">⚪ Soft</option>
                            <option value="medium"${st.tyreRight==='medium'?'selected':''}
                                style="color:#ffcc00;background:#1a1400;">🟡 Med</option>
                            <option value="hard"  ${st.tyreRight==='hard'  ?'selected':''}
                                style="color:#ff6060;background:#1a0000;">🔴 Hard</option>
                            <option value="wet"   ${st.tyreRight==='wet'   ?'selected':''}
                                style="color:#3399ff;background:#00101a;">🔵 Wet</option>
                        </select>
                    ` : '<span style="color:#333;font-size:0.9em;">—</span>'}
                </div>
            </td>

            <td class="pit-extra ${hasPitThis ? '' : 'none'}"
                title="${pitDetail.join(' | ')}">
                ${pitTxt}
            </td>`;

        tbody.appendChild(tr);

        // Mettre à jour les classes couleur des selects gomme
        ['left','right'].forEach(side => {
            const sel = tr.querySelector(`.tyre-compound-select[data-side="${side}"]`);
            if (sel) applyTyreSelectClass(sel);
        });

        if (window._liveMode) {            
            // cR est déjà la position AVANT ce stint (avant le += dR ci-dessous)
            const stintAbsStart = realStart + cR;
            const stintAbsEnd   = stintAbsStart + dR;
            // Normaliser liveNow dans le même espace que realStart
            let liveNow = window._liveNowSec || 0;
            const _raceEndChk = realStart + totalRaceSec;
            if (_raceEndChk > 86400 && liveNow < realStart && liveNow < 43200) {
                liveNow += 86400;
            }

            if (stintAbsEnd <= liveNow) {
                // Stint entièrement passé
                tr.dataset.past        = 'true';
                tr.style.opacity       = '0.45';
                tr.style.background    = 'rgba(60,60,60,0.25)';
                tr.style.pointerEvents = 'none';
                tr.querySelectorAll('input, select, button').forEach(el => {
                    el.disabled      = true;
                    el.style.cursor  = 'not-allowed';
                    el.style.opacity = '0.35';
                });
            } else if (stint._current) {
                // Stint courant : surligné
                tr.style.background  = 'rgba(var(--accent-rgb),0.07)';
                tr.style.borderLeft  = '3px solid var(--accent)';
                tr.style.boxShadow   = 'inset 0 0 12px rgba(var(--accent-rgb),0.08)';
            }
        }

        cR += dR;
        cG += dG;
    });

    updateTyreGauge();

    // Barres verticales durée de vie des gommes
    // On attend le layout pour avoir les hauteurs réelles des lignes
    requestAnimationFrame(() => {
        requestAnimationFrame(() => buildTyreLifeBars(_isLiveCalc));
    });

    // Afficher les contrôles manuels une fois la table générée

    const manualControls = document.getElementById(_tid('stintManualControls'));
    if (manualControls) manualControls.style.display = 'flex';
    _updateManualStintUI(window._liveMode ? 'live' : 'planning');

    /* ══════════════════════════════════════════════════════════════════
       INDICATEUR DE COHÉRENCE
    ══════════════════════════════════════════════════════════════════ */
    if (!window._liveMode) {
        let totalRoulageReel = 0;
        let totalPitReel     = 0;

        stints.forEach((stint, idx) => {
            totalRoulageReel += stint.tours * lapTime;
            if (idx < stints.length - 1) totalPitReel += getPitDuration(idx);
        });

        const totalReel = totalRoulageReel + totalPitReel;
        const ecartSec  = totalRaceSec - totalReel;
        const ecartAbs  = Math.abs(ecartSec);
        const ecartMin  = Math.floor(ecartAbs / 60);
        const ecartSecR = Math.round(ecartAbs % 60);

        const pitMin     = Math.floor(totalPitReel / 60);
        const pitSecR    = Math.round(totalPitReel % 60);
        const roulageH   = Math.floor(totalRoulageReel / 3600);
        const roulageMin = Math.floor((totalRoulageReel % 3600) / 60);
        const roulageSec = Math.round(totalRoulageReel % 60);

        let badgeColor, badgeBorder, icon, ecartLabel;
        if (ecartAbs < 10) {
            badgeColor  = 'rgba(0,255,136,0.12)';
            badgeBorder = '#00ff88';
            icon        = '✅';
            ecartLabel  = `Écart : ${ecartAbs.toFixed(1)}s — Stratégie cohérente`;
        } else if (ecartAbs < 60) {
            badgeColor  = 'rgba(255,170,0,0.12)';
            badgeBorder = '#ffaa00';
            icon        = '⚠️';
            ecartLabel  = `Écart : ${ecartAbs.toFixed(1)}s — Ajustez le refuel ou les durées de pit`;
        } else {
            badgeColor  = 'rgba(255,60,60,0.15)';
            badgeBorder = '#ff4444';
            icon        = '🔴';
            ecartLabel  = `Écart : ${ecartMin > 0 ? ecartMin + 'min ' : ''}${ecartSecR}s — `
                        + (ecartSec > 0
                            ? 'Temps non couvert par les stints'
                            : 'Stints dépassent la durée de course');
        }

        let coherenceBox = document.getElementById(_tid('coherenceBox'));
        if (!coherenceBox) {
            coherenceBox = document.createElement('div');
            coherenceBox.id = _tid('coherenceBox');
            coherenceBox.style.cssText =
                'margin-top:16px;padding:14px 18px;border-radius:10px;'
              + 'border-left:4px solid;display:flex;flex-wrap:wrap;'
              + 'gap:20px;align-items:center;font-size:0.88em;';
            tbody.closest('.strategy-table-wrapper').insertAdjacentElement('afterend', coherenceBox);
        }

        coherenceBox.style.display    = 'flex';
        coherenceBox.style.background  = badgeColor;
        coherenceBox.style.borderColor = badgeBorder;
        coherenceBox.innerHTML = `
            <div style="font-size:1.3em;">${icon}</div>
            <div style="flex:1;min-width:180px;">
                <div style="color:${badgeBorder};font-weight:bold;margin-bottom:4px;">
                    ${ecartLabel}
                </div>
                <div style="color:var(--text-3);font-size:0.9em;">
                    Durée cible : <strong style="color:var(--text)">${formatDuration(totalRaceSec)}</strong>
                    &nbsp;·&nbsp;
                    Total calculé : <strong style="color:var(--text)">${formatDuration(totalReel)}</strong>
                    ${window._manualStintCount > 0
                        ? `&nbsp;·&nbsp;<span style="color:#00aaff;">
                            ✏️ ${window._manualStintCount} stint(s) manuel(s)
                          </span>`
                        : ''}
                </div>
            </div>
            <div style="display:flex;gap:24px;flex-wrap:wrap;">
                <div style="text-align:center;">
                    <div style="color:var(--text-3);font-size:0.85em;text-transform:uppercase;letter-spacing:0.5px;">
                        🏎 Roulage net
                    </div>
                    <div style="color:var(--text);font-weight:bold;font-size:1.15em;">
                        ${String(roulageH).padStart(2,'0')}:${String(roulageMin).padStart(2,'0')}:${String(roulageSec).padStart(2,'0')}
                    </div>
                </div>
                <div style="text-align:center;">
                    <div style="color:var(--text-3);font-size:0.85em;text-transform:uppercase;letter-spacing:0.5px;">
                        🔧 Temps pits
                    </div>
                    <div style="color:#ffaa00;font-weight:bold;font-size:1.15em;">
                        ${pitMin > 0 ? pitMin + 'min ' : ''}${pitSecR}s
                    </div>
                </div>
                <div style="text-align:center;">
                    <div style="color:var(--text-3);font-size:0.85em;text-transform:uppercase;letter-spacing:0.5px;">
                        ⛽ Pits prévus
                    </div>
                    <div style="color:var(--text);font-weight:bold;font-size:1.15em;">
                        ${stints.length - 1}
                    </div>
                </div>
            </div>`;

    } else {
        // ── MODE LIVE : indicateur de cohérence adapté ──
        let totalRoulageLive = 0;
        let totalPitLive     = 0;

        stints.forEach((stint, idx) => {
            const pitAfterLive = (idx < stints.length - 1) ? getPitDuration(idx) : 0;
            const durLive      = (stint._past && stint._durReelle !== undefined)
                ? stint._durReelle
                : stint.tours * lapTime + pitAfterLive;
            if (!stint._past) {
                totalRoulageLive += stint.tours * lapTime;
                if (idx < stints.length - 1) totalPitLive += getPitDuration(idx);
            }
        });

        // Temps déjà écoulé depuis le début de la course (réel)
        const _nowCoh   = new Date();
        let   nowSecCoh = _nowCoh.getHours() * 3600
                        + _nowCoh.getMinutes() * 60
                        + _nowCoh.getSeconds();
        if (realStart + totalRaceSec > 86400 && nowSecCoh < realStart) nowSecCoh += 86400;
        const tempsEcoule     = Math.max(0, nowSecCoh - realStart);
        const tempsRestantCoh = Math.max(0, totalRaceSec - tempsEcoule);

        // Total projeté = roulage futur + pits futurs
        const totalProjeteLive = totalRoulageLive + totalPitLive;
        const ecartLiveSec     = tempsRestantCoh - totalProjeteLive;
        const ecartLiveAbs     = Math.abs(ecartLiveSec);
        const ecartLiveMin     = Math.floor(ecartLiveAbs / 60);
        const ecartLiveSecR    = Math.round(ecartLiveAbs % 60);

        const pitMinL  = Math.floor(totalPitLive / 60);
        const pitSecRL = Math.round(totalPitLive % 60);
        const rolH     = Math.floor(totalRoulageLive / 3600);
        const rolMin   = Math.floor((totalRoulageLive % 3600) / 60);
        const rolSec   = Math.round(totalRoulageLive % 60);

        let badgeColorL, badgeBorderL, iconL, ecartLabelL;
        if (ecartLiveAbs < 10) {
            badgeColorL  = 'rgba(0,255,136,0.12)';
            badgeBorderL = '#00ff88';
            iconL        = '✅';
            ecartLabelL  = `Écart : ${ecartLiveAbs.toFixed(1)}s — Stratégie live cohérente`;
        } else if (ecartLiveAbs < 60) {
            badgeColorL  = 'rgba(255,170,0,0.12)';
            badgeBorderL = '#ffaa00';
            iconL        = '⚠️';
            ecartLabelL  = `Écart : ${ecartLiveAbs.toFixed(1)}s — Ajustez le refuel ou les pits`;
        } else {
            badgeColorL  = 'rgba(255,60,60,0.15)';
            badgeBorderL = '#ff4444';
            iconL        = '🔴';
            ecartLabelL  = `Écart : ${ecartLiveMin > 0 ? ecartLiveMin + 'min ' : ''}${ecartLiveSecR}s — `
                         + (ecartLiveSec > 0
                             ? 'Temps restant non couvert'
                             : 'Stints futurs dépassent le temps restant');
        }

        let coherenceBox = document.getElementById(_tid('coherenceBox'));
        if (!coherenceBox) {
            coherenceBox = document.createElement('div');
            coherenceBox.id = _tid('coherenceBox');
            coherenceBox.style.cssText =
                'margin-top:16px;padding:14px 18px;border-radius:10px;'
              + 'border-left:4px solid;display:flex;flex-wrap:wrap;'
              + 'gap:20px;align-items:center;font-size:0.88em;';
            tbody.closest('.strategy-table-wrapper').insertAdjacentElement('afterend', coherenceBox);
        }

        coherenceBox.style.display    = 'flex';
        coherenceBox.style.background  = badgeColorL;
        coherenceBox.style.borderColor = badgeBorderL;
        coherenceBox.innerHTML = `
            <div style="font-size:1.3em;">${iconL}</div>
            <div style="flex:1;min-width:180px;">
                <div style="color:${badgeBorderL};font-weight:bold;margin-bottom:4px;">
                    🔴 LIVE — ${ecartLabelL}
                </div>
                <div style="color:var(--text-3);font-size:0.9em;">
                    Temps restant : <strong style="color:var(--text)">${formatDuration(tempsRestantCoh)}</strong>
                    &nbsp;·&nbsp;
                    Projeté futur : <strong style="color:var(--text)">${formatDuration(totalProjeteLive)}</strong>
                </div>
            </div>
            <div style="display:flex;gap:24px;flex-wrap:wrap;">
                <div style="text-align:center;">
                    <div style="color:var(--text-3);font-size:0.85em;text-transform:uppercase;letter-spacing:0.5px;">
                        🏎 Roulage futur
                    </div>
                    <div style="color:var(--text);font-weight:bold;font-size:1.15em;">
                        ${String(rolH).padStart(2,'0')}:${String(rolMin).padStart(2,'0')}:${String(rolSec).padStart(2,'0')}
                    </div>
                </div>
                <div style="text-align:center;">
                    <div style="color:var(--text-3);font-size:0.85em;text-transform:uppercase;letter-spacing:0.5px;">
                        🔧 Pits futurs
                    </div>
                    <div style="color:#ffaa00;font-weight:bold;font-size:1.15em;">
                        ${pitMinL > 0 ? pitMinL + 'min ' : ''}${pitSecRL}s
                    </div>
                </div>
                <div style="text-align:center;">
                    <div style="color:var(--text-3);font-size:0.85em;text-transform:uppercase;letter-spacing:0.5px;">
                        ⛽ Pits restants
                    </div>
                    <div style="color:var(--text);font-weight:bold;font-size:1.15em;">
                        ${stints.filter(s => !s._past).length - 1}
                    </div>
                </div>
            </div>`;
    }

    /* ── Total temps pit dans le header ── */
    let totalPitSec = 0;
    stints.forEach((_, idx) => {
        if (idx < stints.length - 1) totalPitSec += getPitDuration(idx);
    });
    if (!_isLiveCalc && typeof plansSetPitTotal === 'function') plansSetPitTotal(totalPitSec);
    const pitHeaderEl = document.getElementById(_tid('pitPlusHeader'));
    if (pitHeaderEl) {
        const pitMin = Math.floor(totalPitSec / 60);
        const pitSec = Math.round(totalPitSec % 60);
        pitHeaderEl.innerHTML = `⏱️ Pit +<br>
            <span style="color:#ffaa00;font-size:0.85em;font-weight:normal;">
                Σ ${pitMin > 0 ? pitMin + 'min ' : ''}${pitSec}s
            </span>`;
    }

     buildTimeline(stints, lapTime, multiplier, realStart, gameStart, totalRaceSec);
    // Léger délai pour laisser le DOM se stabiliser avant de mesurer les largeurs
    requestAnimationFrame(() => initColumnResizers(_isLiveCalc));

    if (!window._liveMode) {
        document.querySelectorAll('.result-value').forEach(el => {
            el.style.transform = 'scale(1.1)';
            setTimeout(() => el.style.transform = 'scale(1)', 300);
        });
    }

        // Restaurer le focus sur l'élément qui était actif avant la reconstruction
    if (_focusedStint >= 0 && _focusedClass) {
        requestAnimationFrame(() => {
            const newTr = tbody.querySelector(`tr[data-stint-idx="${_focusedStint}"]`);
            if (!newTr) return;

            let target = null;

            if (_focusedClass.includes('stop-dur-input')) {
                target = newTr.querySelector('.stop-dur-input');
            } else if (_focusedClass.includes('refuel-pct-input')) {
                target = newTr.querySelector('.refuel-pct-input');
            } else if (_focusedClass.includes('driver-name-input')) {
                // Récupérer l'index pilote depuis l'id du champ (driverName_0, etc.)
                const match = _focusedEl?.id?.match(/driverName_(\d+)/);
                if (match) target = document.getElementById(`driverName_${match[1]}`);
            } else if (_focusedClass.includes('tyre-check') && _focusedSide) {
                target = newTr.querySelector(`.tyre-check[data-side="${_focusedSide}"]`);
            }

            if (target) {
                target.focus();
                // Restaurer la valeur et la sélection pour les inputs texte/nombre
                if (_focusedVal !== null && target.tagName === 'INPUT'
                    && target.type !== 'checkbox' && target.type !== 'color') {
                    target.value = _focusedVal;
                    if (_focusedSelStart !== null && target.setSelectionRange) {
                        try { target.setSelectionRange(_focusedSelStart, _focusedSelEnd); } catch(e) {}
                    }
                }
            }
        });
    }

    if (!window._liveMode && !_calculatingFromRemote) {
        _dirtyPitState = true;
        pushToFirebase(true);
    }
}
    

