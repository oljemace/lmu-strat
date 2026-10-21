        /* ── Résolution d'ID cible Planification / Live ──
           Les tables de stints, timelines et quelques contrôles associés
           existent en DEUX exemplaires dans le DOM (un par panneau). Tant
           que window._liveMode est actif (uniquement pendant l'exécution
           synchrone d'un calcul déclenché en mode live), _tid() redirige
           vers l'exemplaire "live" ; sinon vers l'exemplaire planification
           (id inchangé, pour ne rien casser côté planification). */
        function _tid(id, forceLive) {
            // forceLive permet de figer le choix AVANT un requestAnimationFrame :
            // window._liveMode redevient false dès que recalculateLive() a fini
            // (synchrone), donc un callback différé lu via window._liveMode
            // tomberait toujours sur la planification par erreur.
            const live = forceLive !== undefined ? forceLive : window._liveMode;
            return live ? 'live' + id.charAt(0).toUpperCase() + id.slice(1) : id;
        }

        /* ── Validation & ajustement ── */
        const MAX = {
            realStartHours:23, realStartMinutes:59,
            gameStartHours:23, gameStartMinutes:59,
            raceHours:99,      raceMinutes:59,
            lapMinutes:59,     lapSeconds:59,     lapMillis:9
        };

    function validateTime(input) {
        let v = parseInt(input.value);
        if (isNaN(v) || v < 0) v = 0;
        if (MAX[input.id] !== undefined && v > MAX[input.id]) v = MAX[input.id];
        input.value = v;
    }

	function adjustTime(id, delta) {
		const input = document.getElementById(id);
		let v = (parseInt(input.value) || 0) + delta;
		if (v < 0) v = 0;
		if (MAX[id] !== undefined && v > MAX[id]) v = MAX[id];
		input.value = v;
        const isPitField = ['stopDur', 'refuelPct'].some(k => id.includes(k));
        if (isPitField) _dirtyPitState = true; else _dirtyFields.add(id);
        pushToFirebase(isPitField);

		// ← Déclencher manuellement l'événement pour la sync Firebase
		input.dispatchEvent(new Event('input', { bubbles: true }));


	}

    /* ── Helpers temps ── */
    function getLapTimeInSeconds() {
        const m = parseInt(document.getElementById('lapMinutes').value) || 0;
        const s = parseInt(document.getElementById('lapSeconds').value) || 0;
        const d = parseInt(document.getElementById('lapMillis').value)  || 0;
        return m * 60 + s + d / 10;
    }

    function getLapTimeDisplay() {
        const m = parseInt(document.getElementById('lapMinutes').value) || 0;
        const s = parseInt(document.getElementById('lapSeconds').value) || 0;
        const d = parseInt(document.getElementById('lapMillis').value)  || 0;
        return `${m}:${String(s).padStart(2,'0')}.${d}`;
    }

    function getRaceTimeInSeconds() {
        const h = parseInt(document.getElementById('raceHours').value)   || 0;
        const m = parseInt(document.getElementById('raceMinutes').value) || 0;
        return h * 3600 + m * 60;
    }

    function toSec(h, m) { return h * 3600 + m * 60; }

	/* ── Retourne le realStart en secondes, avec décalage -86400s si "hier" coché ── */
	function getRealStart() {
		const h = parseInt(document.getElementById('realStartHours').value)   || 0;
		const m = parseInt(document.getElementById('realStartMinutes').value) || 0;
		const base = toSec(h, m);
		const yesterday = document.getElementById('realStartYesterday')?.checked;
		return yesterday ? base - 86400 : base;
	}

    function formatClock(s) {
        const n = ((s % 86400) + 86400) % 86400;
        return `${String(Math.floor(n/3600)).padStart(2,'0')}:${String(Math.floor((n%3600)/60)).padStart(2,'0')}`;
    }

    function formatDuration(s) {
        return `${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor((s%3600)/60)).padStart(2,'0')}:${String(Math.round(s%60)).padStart(2,'0')}`;
    }

    /* ── Couleurs stints ── */
    const COLORS = [
        ['#00ff88','#00cc6a','#000'],
        ['#00aaff','#0077cc','#000'],
        ['#ffaa00','#cc8800','#000'],
        ['#aa00ff','#7700cc','#fff'],
        ['#ff6600','#cc4400','#fff'],
        ['#00ffcc','#00ccaa','#000'],
    ];

    const TYRE_PENALTY = 6; // secondes par côté

    /* ── Liste des Hypercars LMU ── */
    const LMU_HYPERCARS = [
        // LMH
        { id: "toyota_gr010",      label: "Toyota GR010 Hybrid",           ruleset: "LMH" },
        { id: "ferrari_499p",      label: "Ferrari 499P",                  ruleset: "LMH" },
        { id: "peugeot_9x8_2024",  label: "Peugeot 9X8 (2024)",            ruleset: "LMH" },
        { id: "aston_valkyrie",    label: "Aston Martin Valkyrie AMR-LMH", ruleset: "LMH" },
        { id: "glickenhaus_007",   label: "Glickenhaus SCG 007",           ruleset: "LMH" },
        { id: "isotta_tipo6",      label: "Isotta Fraschini Tipo 6",       ruleset: "LMH" },
        { id: "vanwall_680",       label: "Vanwall Vandervell 680",        ruleset: "LMH" },
        // LMDh
        { id: "porsche_963",       label: "Porsche 963",                   ruleset: "LMDh" },
        { id: "cadillac_vseriesr", label: "Cadillac V-Series.R",           ruleset: "LMDh" },
        { id: "bmw_mhybridv8",     label: "BMW M Hybrid V8",               ruleset: "LMDh" },
        { id: "alpine_a424",       label: "Alpine A424",                   ruleset: "LMDh" },
        { id: "lamborghini_sc63",  label: "Lamborghini SC63",              ruleset: "LMDh" },
        { id: "genesis_gmr001",    label: "Genesis GMR-001",               ruleset: "LMDh" },
    ];    

    /* État persistant entre recalculs */
    let pitState = {};

    /* Pneus montés au départ de la course (roulent pendant le Stint 1) */
    window._startTyres = { left: 'none', right: 'none' };

	// ── État du mode live (persistant entre les mises à jour) ──
	
        window._liveModeActive  = false;
        window._liveMode        = false;
        window._liveNowSec      = 0;    // heure réelle au moment du clic "Recalculer"
        window._liveEvAtAnchor  = 0;    // EV saisie au moment du clic
        window._applyingRemote  = false;

	/* pitState[idx] = {
         stop: bool,       // arrêt au stand activé
         stopDur: number,  // durée passage au stand (s)
         refuel: bool,     // refuel activé
         refuelPct: number,// quantité refuel (%)
         left: bool,       // pneu gauche
         right: bool       // pneu droit
       }
    */

    function defaultState() {
        return {
            stop: true, stopDur: 45, refuel: true, refuelPct: 100,
            left: false, right: false, driver: -1,
            tyreLeft: 'none', tyreRight: 'none',
        };
    }

    /* Sauvegarde l'état des contrôles avant de vider le tbody */
    function savePitState() {
        // Ne pas écraser pitState si application de données distantes ou mode live actif
        if (window._applyingRemote) return;
        if (window._liveMode) return;

            document.querySelectorAll('tr[data-stint-idx]').forEach(tr => {
                const idx = parseInt(tr.dataset.stintIdx);
                if (!pitState[idx]) pitState[idx] = defaultState();

                if (tr.dataset.past === 'true') return;

                const stopCb    = tr.querySelector('.stop-check');
                const stopDurI  = tr.querySelector('.stop-dur-input');
                const refuelI   = tr.querySelector('.refuel-pct-input');
                const leftCb    = tr.querySelector('.tyre-check[data-side="left"]');
                const rightCb   = tr.querySelector('.tyre-check[data-side="right"]');
                const driverSel = tr.querySelector('.driver-select');

                const tyreLeftSel  = tr.querySelector('.tyre-compound-select[data-side="left"]');
                const tyreRightSel = tr.querySelector('.tyre-compound-select[data-side="right"]');

                if (driverSel)   pitState[idx].driver     = parseInt(driverSel.value);
                if (stopCb)      pitState[idx].stop        = stopCb.checked;
                if (stopDurI)    pitState[idx].stopDur     = parseFloat(stopDurI.value) || 30;
                if (refuelI)     pitState[idx].refuelPct   = parseFloat(refuelI.value)  || 25;
                if (tyreLeftSel) pitState[idx].tyreLeft    = tyreLeftSel.value  || 'none';
                if (tyreRightSel)pitState[idx].tyreRight   = tyreRightSel.value || 'none';
                // left/right restent vrais si une gomme est sélectionnée
                pitState[idx].left  = pitState[idx].tyreLeft  !== 'none';
                pitState[idx].right = pitState[idx].tyreRight !== 'none';
                pitState[idx]._userSet = true;

            });
        }

        

    /* Calcule la durée totale du pit stop pour un stint donné (secondes) */
    function getPitDuration(idx) {
        const s    = pitState[idx] || defaultState();
        const rate = parseFloat(document.getElementById('refuelRate')?.value) || 5;
        if (!s.stop) return 0;
        const stopSec   = s.stopDur || 0;
        const refuelSec = (s.refuelPct || 0) * rate;
        const tyreSec   = (s.left ? TYRE_PENALTY : 0) + (s.right ? TYRE_PENALTY : 0);
        return stopSec + refuelSec + tyreSec;
    }

/* Compteur de pneus neufs — tient compte du stock live si renseigné */
function updateTyreGauge() {
    // ── Déterminer le budget à utiliser ──
    let budget;
    let isLiveBudget = false;

    if (window._liveModeActive) {
        const liveBudgetEl = document.getElementById('liveTyreBudget');
        if (liveBudgetEl && liveBudgetEl.value !== '') {
            budget       = parseInt(liveBudgetEl.value);
            isLiveBudget = true;
        }
    }

    if (!isLiveBudget) {
        budget = parseInt(document.getElementById('tyreBudget')?.value) || 0;
    }

    // ── Compter les pneus utilisés ──
    // Pneus de départ (comptés sauf si mode live avec budget live ; en live,
    // la gomme de départ réelle vient de la mémoire partagée, pas de
    // window._startTyres — voir _liveTyreState plus bas)
    let used = 0;
    if (!isLiveBudget) {
        if ((window._startTyres?.left  || 'none') !== 'none') used += 2;
        if ((window._startTyres?.right || 'none') !== 'none') used += 2;
    } else if (window._liveTyreState) {
        if ((window._liveTyreState.compoundLeft  || 'none') !== 'none') used += 2;
        if ((window._liveTyreState.compoundRight || 'none') !== 'none') used += 2;
    }
    // Pneus changés en course — uniquement dans LA table concernée (planification
    // ou live ont chacune leur propre tbody depuis la séparation des deux modes).
    const tbodyTG = document.getElementById(_tid('strategyTableBody'));
    tbodyTG?.querySelectorAll('tr[data-stint-idx]').forEach(tr => {
        if (isLiveBudget && tr.dataset.past === 'true') return;
        const leftSel  = tr.querySelector('.tyre-compound-select[data-side="left"]');
        const rightSel = tr.querySelector('.tyre-compound-select[data-side="right"]');
        if (leftSel  && leftSel.value  !== 'none') used += 2;
        if (rightSel && rightSel.value !== 'none') used += 2;
    });

    const remaining = budget - used;
    const container = document.getElementById(_tid('tyreGaugeContainer'));
    const bar       = document.getElementById(_tid('tyreGaugeBar'));
    const label     = document.getElementById(_tid('tyreGaugeLabel'));

    if (!container || !bar || !label) return;

    if (budget <= 0) {
        container.style.display = 'none';
        return;
    }

    container.style.display = 'block';
    const ratio = Math.max(0, Math.min(1, remaining / budget));
    bar.style.width = `${ratio * 100}%`;

    const liveSuffix = isLiveBudget ? ' — LIVE' : '';
    const usedLabel  = isLiveBudget
        ? `${used} futurs prévus`
        : `${used} utilisés`;

    if (remaining < 0) {
        bar.style.background = '#ff2222';
        label.style.color    = '#ff4444';
        label.textContent    = `⚠️ ${Math.abs(remaining)} pneus à réutilisés !${liveSuffix}`;
    } else if (ratio <= 0.25) {
        bar.style.background = '#ff6600';
        label.style.color    = '#ff8800';
        label.textContent    = `🔴 ${remaining} pneus restants (${usedLabel})${liveSuffix}`;
    } else if (ratio <= 0.5) {
        bar.style.background = '#ffaa00';
        label.style.color    = '#ffcc00';
        label.textContent    = `🟡 ${remaining} pneus restants (${usedLabel})${liveSuffix}`;
    } else {
        bar.style.background = 'var(--accent)';
        label.style.color    = 'var(--accent)';
        label.textContent    = `🟢 ${remaining} pneus restants (${usedLabel})${liveSuffix}`;
    }
}

