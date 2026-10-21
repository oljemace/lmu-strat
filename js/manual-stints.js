/* ══════════════════════════════════════════════════════════════════
   GESTION DES STINTS MANUELS

   _manualStintCount     = compteur pour la table de PLANIFICATION
   _manualStintCountLive = compteur pour la table LIVE (indépendant)

   Ces stints extra sont intégrés dans le calcul de durée : le dernier
   stint (auto ou manuel) absorbe le temps restant pour garantir
   Σ(roulage + pits) = durée cible exactement — même logique dans les
   deux modes, voir calculate.js.
══════════════════════════════════════════════════════════════════ */
window._manualStintCount     = 0;
window._manualStintCountLive = 0;

function addManualStint(mode) {
    _stateUse(mode === 'live' ? 'live' : 'planning');
    if (mode === 'live') {
        window._manualStintCountLive++;
        recalculateLive();
        liveMarkEdited(); if (typeof pushToFirebase === 'function') pushToFirebase(true);
    } else {
        window._manualStintCount++;
        calculate();
    }
    _updateManualStintUI(mode);
}

function removeLastManualStint(mode) {
    const isLive = mode === 'live';
    _stateUse(isLive ? 'live' : 'planning');
    const count  = isLive ? window._manualStintCountLive : window._manualStintCount;
    if (count <= 0) return;

    // Supprimer le pitState du dernier stint (le dernier index = stints.length - 1
    // au moment de l'appel), pour libérer l'index lors du prochain recalcul.
    const tbody = document.getElementById(_tid('strategyTableBody', isLive));
    const rows  = tbody?.querySelectorAll('tr[data-stint-idx]');
    if (rows && rows.length > 0) {
        const lastIdx = parseInt(rows[rows.length - 1].dataset.stintIdx);
        delete pitState[lastIdx];
    }

    if (isLive) {
        window._manualStintCountLive = Math.max(0, window._manualStintCountLive - 1);
        recalculateLive();
        liveMarkEdited(); if (typeof pushToFirebase === 'function') pushToFirebase(true);
    } else {
        window._manualStintCount = Math.max(0, window._manualStintCount - 1);
        calculate();
    }
    _updateManualStintUI(mode);
}

function _updateManualStintUI(mode) {
    const isLive = mode === 'live';
    const count  = isLive ? window._manualStintCountLive : window._manualStintCount;

    const btnRemove = document.getElementById(_tid('btnRemoveStint', isLive));
    const infoSpan  = document.getElementById(_tid('manualStintInfo', isLive));
    if (btnRemove) {
        btnRemove.style.display = count > 0 ? 'inline-block' : 'none';
    }
    if (infoSpan) {
        infoSpan.textContent = count > 0
            ? `${count} stint(s) ajouté(s) manuellement`
            : '';
    }
}

/* Les stints manuels ne valent que pour la configuration où ils ont été ajoutés :
   si on change la durée de course, le temps au tour ou la consommation, le nombre
   de stints naturels change et un compteur resté en mémoire scinderait le dernier
   stint en deux (ex. 2 stints à 49 %) sans que l'utilisateur l'ait demandé. */
['raceHours', 'raceMinutes', 'lapMinutes', 'lapSeconds', 'lapMillis',
 'evPerLap', 'evRefuelPerStint', 'evRemaining'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => {
        if (window._manualStintCount > 0) {
            window._manualStintCount = 0;
            _updateManualStintUI('planning');
        }
    }, true);
});
