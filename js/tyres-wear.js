	/* ══════════════════════════════════════════════
   GESTION USURE DES PNEUS
   ══════════════════════════════════════════════ */

const TYRE_CORNERS   = ['FL', 'FR', 'RL', 'RR'];
const TYRE_COMPOUNDS = ['soft', 'medium', 'hard', 'wet'];
const TYRE_COLORS    = { soft: '#ff6060', medium: '#ffcc00', hard: '#dddddd', wet: '#3399ff' };
const TYRE_LABELS    = { soft: 'Soft', medium: 'Medium', hard: 'Hard', wet: 'Wet' };
const CORNER_LABELS  = { FL: 'Av G', FR: 'Av D', RL: 'Ar G', RR: 'Ar D' };

/* ── Constantes de dégradation ── */
const TYRE_WEAR_MARGIN = 60;   // % exploitable (100% - 40% seuil critique)

/* Retourne l'usure par tour (%) d'une gomme/coin.
   0 = non renseignée. */
function getTyreLife(corner, compound) {
    const el = document.getElementById(`tyre_${corner}_${compound}`);
    return el ? (parseFloat(el.value) || 0) : 0;
}

/* Calcule le nombre de tours max depuis l'usure/tour */
function getTyreMaxLaps(wearPerLap) {
    if (wearPerLap <= 0) return 0;
    return TYRE_WEAR_MARGIN / wearPerLap;
}

/* Met à jour la barre de progression et le label d'un champ */
function updateTyreWearUI(corner, compound, rawVal) {
    const wearPerLap = parseFloat(rawVal) || 0;
    const maxLaps    = getTyreMaxLaps(wearPerLap);

    // Pour la barre : plus l'usure/tour est élevée, plus la barre est "rouge/courte"
    // On normalise sur la pire gomme de ce coin (usure max = barre la plus courte)
    const maxWear = Math.max(0.01, ...TYRE_COMPOUNDS.map(c => getTyreLife(corner, c)));
    // Barre inversée : usure faible → barre longue (gomme durable)
    const ratio   = wearPerLap > 0 ? Math.min(1, (maxWear - wearPerLap) / maxWear + 0.15) : 0;

    const bar = document.getElementById(`tyre_${corner}_${compound}_bar`);
    const lbl = document.getElementById(`tyre_${corner}_${compound}_lbl`);

    if (bar) {
        bar.style.width      = wearPerLap > 0 ? `${Math.max(8, ratio * 100)}%` : '0%';
        bar.style.background = wearPerLap <= 0 ? 'rgba(255,255,255,0.1)' : TYRE_COLORS[compound];
    }

    if (lbl) {
        const toursParStint = (() => {
            const evRefuel = parseFloat(document.getElementById('evRefuelPerStint')?.value) || 100;
            const evPerLap = parseFloat(document.getElementById('evPerLap')?.value) || 8;
            return evRefuel / evPerLap;
        })();

        if (wearPerLap <= 0) {
            lbl.textContent = '—';
            lbl.style.color = '#555';
        } else {
            const stints = maxLaps / toursParStint;
            lbl.textContent = `${maxLaps.toFixed(1)}t · ${stints.toFixed(1)} stints`;
            lbl.style.color = stints < 1   ? '#ff6060'
                            : stints < 1.5 ? '#ffaa00'
                            : '#88cc88';
        }
    }

    updateTyreBudgetSummary();
    _dirtyTyreWear = true;
    pushToFirebase(false);
}

/* ── Helpers côté gauche / droit ── */

/* Retourne l'usure moyenne par tour d'un côté (G ou D) pour une gomme.
   En mode live, si l'usure restante réelle est renseignée pour ce composé,
   retourne un wear fictif calé sur l'état réel du pneu (% de vie restante).
   Côté G = moyenne(FL, RL) · Côté D = moyenne(FR, RR)
   Retourne 0 si aucune donnée. */

function getSideWear(side, compound, stintIdx) {

    // ── Mode live : override uniquement pour le stint courant (index 0) ──
    // Les pneus futurs montés en stand ont une vie neuve → usure théorique uniquement.
    // Exception : si un pneu neuf est explicitement sélectionné dans pitState pour
    // le stint précédent (= changement prévu au stand), on utilise l'usure théorique.

    // Vérifie si, pour ce stint ou l'un des stints précédents en remontant depuis 0,
    // un changement de pneu a été programmé côté concerné.
    // Si oui, les pneus sont neufs → usure théorique uniquement.
    const _hasNewTyreBeforeStint = (() => {
        if (!window._liveModeActive) return false;
        // À partir du stint 1 : regarder si un changement est prévu au pit du stint précédent
        if (stintIdx <= 0) return false;
        // Remonter depuis le stint 1 jusqu'à stintIdx-1 inclus :
        // si l'un des pits intermédiaires a monté un pneu neuf côté concerné,
        // les pneus du stint stintIdx sont neufs.
        for (let k = 0; k < stintIdx; k++) {
            const st = pitState[k];
            if (!st || !st.stop) continue;
            const kCompound = side === 'left' ? st.tyreLeft : st.tyreRight;
            if (kCompound !== 'none' && kCompound !== undefined) return true;
        }
        return false;
    })();

if (window._liveModeActive && window._liveTyreState && stintIdx === 0 && !_hasNewTyreBeforeStint) {        
    const lts = window._liveTyreState;
    // Chaque côté a maintenant sa propre gomme
    const sideCompound = side === 'left'
        ? (lts.compoundLeft  || lts.compound || 'none')
        : (lts.compoundRight || lts.compound || 'none');
    if (sideCompound !== 'none' && sideCompound === compound) {            
            const pctRemaining = (side === 'left') ? lts.wearLeft : lts.wearRight;

            if (pctRemaining !== null) {                
                // pctRemaining = % de vie restante (100%=neuf, 40%=seuil critique)
                // marge restante exploitable = pctRemaining - 40
                const margeRestante = pctRemaining - 40;

                if (margeRestante <= 0) {
                    // Pneu au seuil ou dépassé → wear très élevé = barre minimale
                    return 999;
                }

                // Usure théorique de référence pour ce côté/composé
                const corners  = (side === 'left') ? ['FL', 'RL'] : ['FR', 'RR'];
                const wears    = corners
                    .map(c => {
                        const el = document.getElementById(`tyre_${c}_${compound}`);
                        return el ? (parseFloat(el.value) || 0) : 0;
                    })
                    .filter(v => v > 0);
                const wearRef  = wears.length > 0
                    ? wears.reduce((a, b) => a + b, 0) / wears.length
                    : 0;

                if (wearRef <= 0) {
                    // Pas de données théoriques → calcul direct depuis la marge
                    // On suppose 1%/tour par défaut pour donner une estimation
                    const toursRestants = margeRestante / 1;
                    return toursRestants > 0 ? (TYRE_WEAR_MARGIN / toursRestants) : 999;
                }

                // Tours restants réels = marge restante / usure par tour théorique
                const toursRestants = margeRestante / wearRef;

                // Wear fictif tel que getTyreMaxLaps(wearFictif) = toursRestants
                // getTyreMaxLaps(w) = TYRE_WEAR_MARGIN / w
                // → w = TYRE_WEAR_MARGIN / toursRestants
                return TYRE_WEAR_MARGIN / toursRestants;
            }
        }
    }

    // ── Mode normal ou stints futurs : usure théorique depuis les inputs ──
    const corners = (side === 'left') ? ['FL', 'RL'] : ['FR', 'RR'];
    const wears   = corners
        .map(c => {
            const el = document.getElementById(`tyre_${c}_${compound}`);
            return el ? (parseFloat(el.value) || 0) : 0;
        })
        .filter(v => v > 0);

    if (wears.length === 0) return 0;
    return wears.reduce((a, b) => a + b, 0) / wears.length;
}

/* Tours max pour un côté donné */
function getSideMaxLaps(side, compound) {
    const wear = getSideWear(side, compound);
    return wear > 0 ? getTyreMaxLaps(wear) : 0;
}

/* Calcule et affiche le récapitulatif global des gommes — séparé G / D */
function updateTyreBudgetSummary() {
    const summary = document.getElementById('tyreBudgetSummary');
    if (!summary) return;

    const evRefuel      = parseFloat(document.getElementById('evRefuelPerStint')?.value) || 100;
    const evPerLap      = parseFloat(document.getElementById('evPerLap')?.value) || 8;
    const toursParStint = evRefuel / evPerLap;

    // Pour chaque gomme : calcul séparé côté G et côté D
    const results = TYRE_COMPOUNDS.map(compound => {
        // Récapitulatif global → toujours usure théorique (pas d'override live)
        const wearL = getSideWear('left',  compound, -1);
        const wearR = getSideWear('right', compound, -1);
        // Au moins un côté doit être renseigné
        if (wearL <= 0 && wearR <= 0) return null;

        const maxLapsL  = wearL > 0 ? getTyreMaxLaps(wearL) : null;
        const maxLapsR  = wearR > 0 ? getTyreMaxLaps(wearR) : null;

        // Facteur limitant global = côté le plus usé
        const worstWear = Math.max(wearL || 0, wearR || 0);
        const maxLaps   = getTyreMaxLaps(worstWear);
        const stints    = maxLaps / toursParStint;

        // Coin limitant détaillé
        const limitSide = (wearL >= wearR) ? 'Gauche' : 'Droite';

        return {
            compound, wearL, wearR, maxLapsL, maxLapsR,
            worstWear, maxLaps, stints, limitSide
        };
    }).filter(Boolean);

    if (results.length === 0) {
        summary.innerHTML = `
            <div style="color:#aaa;font-size:0.85em;font-style:italic;">
                ℹ️ Renseignez les usures/tour ci-dessus pour voir les recommandations.
            </div>`;
        return;
    }

    results.sort((a, b) => b.stints - a.stints);

    let html = `
        <div style="width:100%;margin-bottom:10px;color:#00ff88;
            font-weight:bold;font-size:0.9em;">
            📊 Durée de vie par gomme — usure séparée G / D
            <span style="color:#555;font-size:0.78em;font-weight:normal;">
                (marge exploitable 60% · seuil critique 40%)
            </span>
        </div>`;

    results.forEach(r => {
        const color   = TYRE_COLORS[r.compound];
        const label   = TYRE_LABELS[r.compound];
        const barW    = Math.min(100, r.stints / 5 * 100);
        const warnTxt = r.stints < 1   ? '⚠️ Moins d\'un stint !'
                      : r.stints < 1.5 ? '⚠️ Durée limite'
                      : '';

        // Détail côté G
        const leftDetail = r.wearL > 0
            ? `<span style="color:#88ccff;font-size:0.8em;">
                🔵 G : ${r.wearL.toFixed(2)}%/t
                → <strong style="color:#fff;">${r.maxLapsL.toFixed(1)}t</strong>
                (${(r.maxLapsL / toursParStint).toFixed(1)} stints)
               </span>`
            : `<span style="color:#444;font-size:0.8em;">🔵 G : —</span>`;

        // Détail côté D
        const rightDetail = r.wearR > 0
            ? `<span style="color:#ffaa66;font-size:0.8em;">
                🟠 D : ${r.wearR.toFixed(2)}%/t
                → <strong style="color:#fff;">${r.maxLapsR.toFixed(1)}t</strong>
                (${(r.maxLapsR / toursParStint).toFixed(1)} stints)
               </span>`
            : `<span style="color:#444;font-size:0.8em;">🟠 D : —</span>`;

        // Déséquilibre G/D
        let desequilibre = '';
        if (r.wearL > 0 && r.wearR > 0) {
            const diff = Math.abs(r.maxLapsL - r.maxLapsR);
            if (diff > 2) {
                const plusUseSide = r.wearL > r.wearR ? 'Gauche' : 'Droite';
                desequilibre = `<span style="color:#ff8800;font-size:0.75em;">
                    ⚠ Déséquilibre : côté ${plusUseSide} s'use
                    ${((Math.max(r.wearL,r.wearR)/Math.min(r.wearL,r.wearR)-1)*100).toFixed(0)}%
                    plus vite
                </span>`;
            }
        }

        html += `
        <div style="flex:1;min-width:220px;padding:8px 10px;
            background:rgba(0,0,0,0.15);border-radius:8px;
            border:1px solid ${color}33;">

            <!-- Titre gomme + tours limitants -->
            <div style="display:flex;align-items:center;gap:8px;
                margin-bottom:6px;flex-wrap:wrap;">
                <span style="background:${color}22;color:${color};
                    border:1px solid ${color}55;border-radius:4px;
                    padding:2px 10px;font-size:0.85em;font-weight:bold;">
                    ${label}
                </span>
                <span style="color:#fff;font-weight:bold;font-size:1.0em;">
                    ${r.maxLaps.toFixed(1)} tours
                </span>
                <span style="color:#aaa;font-size:0.82em;">
                    = ${r.stints.toFixed(1)} stints
                </span>
                <span style="color:#888;font-size:0.75em;">
                    ⚠ limitant : ${r.limitSide}
                    (${r.worstWear.toFixed(2)}%/t)
                </span>
                ${warnTxt
                    ? `<span style="color:#ff6600;font-size:0.78em;">${warnTxt}</span>`
                    : ''}
            </div>

            <!-- Détail G / D -->
            <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:6px;">
                ${leftDetail}
                ${rightDetail}
            </div>

            <!-- Déséquilibre -->
            ${desequilibre}

            <!-- Barre de durée de vie -->
            <div style="background:rgba(255,255,255,0.07);
                border-radius:3px;height:5px;overflow:hidden;margin-top:5px;">
                <div style="width:${barW}%;height:5px;background:${color};
                    border-radius:3px;transition:width 0.3s;"></div>
            </div>

            <!-- Barres G/D comparatives -->
            ${(r.wearL > 0 && r.wearR > 0) ? `
            <div style="display:flex;gap:6px;margin-top:4px;align-items:center;">
                <span style="color:#88ccff;font-size:0.7em;width:12px;">G</span>
                <div style="flex:1;background:rgba(255,255,255,0.06);
                    border-radius:2px;height:3px;overflow:hidden;">
                    <div style="width:${Math.min(100,r.maxLapsL/r.maxLaps*100)}%;
                        height:3px;background:#88ccff;border-radius:2px;"></div>
                </div>
                <div style="flex:1;background:rgba(255,255,255,0.06);
                    border-radius:2px;height:3px;overflow:hidden;">
                    <div style="width:${Math.min(100,r.maxLapsR/r.maxLaps*100)}%;
                        height:3px;background:#ffaa66;border-radius:2px;"></div>
                </div>
                <span style="color:#ffaa66;font-size:0.7em;width:12px;text-align:right;">D</span>
            </div>` : ''}
        </div>`;
    });

    // Recommandation globale
    const best      = results[0];
    const bestColor = TYRE_COLORS[best.compound];

    // Recommandation différenciée si déséquilibre important
    let recoDetail = '';
    if (best.wearL > 0 && best.wearR > 0) {
        const diff = Math.abs(best.maxLapsL - best.maxLapsR);
        if (diff > toursParStint * 0.5) {
            // Le côté qui tient plus longtemps peut sauter un changement
            const longerSide  = best.maxLapsL > best.maxLapsR ? 'Gauche' : 'Droite';
            const longerLaps  = Math.max(best.maxLapsL, best.maxLapsR);
            const longerStints = longerLaps / toursParStint;
            recoDetail = `<br><span style="color:#88ccff;font-size:0.9em;">
                💡 Côté ${longerSide} tient
                <strong style="color:#fff;">${longerStints.toFixed(1)} stints</strong>
                — envisager un changement asymétrique.
            </span>`;
        }
    }

    html += `
        <div style="width:100%;margin-top:12px;padding:10px 14px;
            background:rgba(0,255,136,0.06);border-radius:8px;
            border-left:3px solid #00ff88;font-size:0.84em;line-height:1.8;">
            🏆 <strong style="color:#00ff88;">Recommandation :</strong>
            Gomme <strong style="color:${bestColor};">${TYRE_LABELS[best.compound]}</strong>
            — facteur limitant <strong style="color:#fff;">${best.maxLaps.toFixed(1)} tours</strong>
            (côté ${best.limitSide} · ${best.worstWear.toFixed(2)}%/tour).
            <br>
            ${best.stints >= 2
                ? `✅ Couvre <strong style="color:#fff;">
                    ${Math.floor(best.stints)} stints complets</strong> sans changement.`
                : `⚠️ Changement nécessaire
                    <strong style="color:#ffaa00;">avant la fin du 1er stint</strong>.`}
            ${recoDetail}
            ${results.length > 1
                ? `<br><span style="color:#666;font-size:0.9em;">
                    Gain vs ${TYRE_LABELS[results[results.length-1].compound]} :
                    +${(best.maxLaps - results[results.length-1].maxLaps).toFixed(1)} tours
                    (+${(best.stints  - results[results.length-1].stints).toFixed(1)} stints)
                   </span>`
                : ''}
        </div>`;

    summary.innerHTML = html;
}

/* Collecte les données pneus pour Firebase */
function collectTyreWearData() {
    const data = {};
    TYRE_CORNERS.forEach(corner => {
        data[corner] = {};
        TYRE_COMPOUNDS.forEach(compound => {
            data[corner][compound] = getTyreLife(corner, compound);
        });
    });
    return data;
}

/* Applique les données pneus reçues depuis Firebase */
function applyTyreWearData(data) {
    if (!data) return;
    TYRE_CORNERS.forEach(corner => {
        if (!data[corner]) return;
        TYRE_COMPOUNDS.forEach(compound => {
            const el = document.getElementById(`tyre_${corner}_${compound}`);
            if (el && data[corner][compound] !== undefined) {
                el.value = data[corner][compound];
                updateTyreWearUI(corner, compound, data[corner][compound]);
            }
        });
    });
}

/* Met à jour la classe couleur d'un select gomme */
function applyTyreSelectClass(sel) {
    sel.classList.remove(
        'has-tyre-none','has-tyre-soft','has-tyre-medium','has-tyre-hard','has-tyre-wet'
    );
    sel.classList.add(`has-tyre-${sel.value || 'none'}`);
}

/* Retourne l'usure théorique d'un côté/composé depuis les inputs,
   SANS aucun override live. Toujours équivalent à un pneu neuf. */
function getSideWearTheoretical(side, compound) {
    const corners = (side === 'left') ? ['FL', 'RL'] : ['FR', 'RR'];
    const wears   = corners
        .map(c => {
            const el = document.getElementById(`tyre_${c}_${compound}`);
            return el ? (parseFloat(el.value) || 0) : 0;
        })
        .filter(v => v > 0);

    if (wears.length === 0) return window._liveModeActive ? _getLiveCircuitDbWear(corners, compound) : 0;
    return wears.reduce((a, b) => a + b, 0) / wears.length;
}

/* Live : quand aucun circuit/voiture n'est sélectionné en Planification (champs
   d'usure à 0), retrouve la base circuits à partir du circuit et de la voiture
   détectés par le jeu (noms comparés comme à l'import de télémétrie). */
function _getLiveCircuitCarData() {
    const track = (window._liveTrackName || '').trim().toLowerCase();
    const car   = (window._liveVehicleName || '').toLowerCase();
    if (!track || typeof _circuits === 'undefined') return null;

    const circuit = Object.values(_circuits).find(c => (c.name || '').trim().toLowerCase() === track);
    if (!circuit?.cars) return null;

    const hyper = car && LMU_HYPERCARS.find(h => car.includes(h.label.toLowerCase()))
        || car && LMU_HYPERCARS.find(h => car.includes(h.label.replace(/\s*\(.*?\)\s*/g, '').toLowerCase().trim()));
    return (hyper && circuit.cars[hyper.id]) || null;
}

function _getLiveCircuitDbWear(corners, compound) {
    const carData = _getLiveCircuitCarData();
    if (!carData?.tyres) return 0;

    const wears = corners
        .map(c => parseFloat(carData.tyres?.[c]?.[compound]) || 0)
        .filter(v => v > 0);
    return wears.length ? wears.reduce((a, b) => a + b, 0) / wears.length : 0;
}

/* ══════════════════════════════════════════════
   BARRES VERTICALES DURÉE DE VIE DES GOMMES
   ══════════════════════════════════════════════

   Pour chaque stint où une gomme est montée,
   on dessine une barre verticale qui s'étend
   sur N lignes = durée de vie en stints.

   La hauteur est calculée en pixels en sommant
   les hauteurs réelles des lignes TR concernées.
══════════════════════════════════════════════ */

function buildTyreLifeBars(isLive) {
    const tbody = document.getElementById(_tid('strategyTableBody', isLive));
    if (!tbody) return;

    const rows = Array.from(tbody.querySelectorAll('tr[data-stint-idx]'));
    if (rows.length === 0) return;

    // Supprimer les anciennes barres
    tbody.querySelectorAll('.tyre-life-bar, .tyre-life-info').forEach(b => b.remove());

    const toursParStint = (() => {
        const evRefuel = parseFloat(document.getElementById('evRefuelPerStint')?.value) || 100;
        const evPerLap = parseFloat(document.getElementById(isLive ? 'evPerLapReal' : 'evPerLap')?.value) || 8;
        return evRefuel / evPerLap;
    })();

    ['left', 'right'].forEach(side => {
        // Pneus G = 12e td, Pneus D = 13e td
        const colNth = side === 'left' ? 12 : 13;

        /* ══════════════════════════════════════════════════════
           PASS 0 : Pneus de DÉPART.
           En planification : window._startTyres (sélection "Départ S1").
           En live : la gomme réellement détectée par la mémoire partagée
           (window._liveTyreState), puisque le choix "Départ S1" n'existe
           pas dans ce panneau.
           Ces pneus roulent dès la ligne 0 (anchorRowIdx = 0).
           Ils sont indépendants de pitState.
        ══════════════════════════════════════════════════════ */
        const startCompound = isLive
            ? (side === 'left'
                ? (window._liveTyreState?.compoundLeft  || 'none')
                : (window._liveTyreState?.compoundRight || 'none'))
            : (side === 'left'
                ? (window._startTyres?.left  || 'none')
                : (window._startTyres?.right || 'none'));

        if (startCompound !== 'none' && rows.length > 0) {
            let maxLapsStart;
            if (isLive) {
                // Live : usure mesurée (≥ 3 tours) sinon base circuits, appliquée à la
                // vie restante réelle des pneus (100% si inconnue). Sans aucune donnée
                // d'usure : pas de barre, un message d'information à la place.
                const measuredStart = window._liveMeasuredWearPerLap?.[side];
                const rateStart = (measuredStart != null && measuredStart > 0)
                    ? measuredStart
                    : getSideWearTheoretical(side, startCompound);
                if (rateStart > 0) {
                    const pctStart = side === 'left' ? window._liveTyreState?.wearLeft
                                                     : window._liveTyreState?.wearRight;
                    maxLapsStart = Math.max(0, (pctStart != null ? pctStart : 100) - 40) / rateStart;
                } else {
                    maxLapsStart = 0;
                    const infoCellStart = rows[0].querySelector(`td:nth-child(${colNth})`);
                    if (infoCellStart) {
                        const info = document.createElement('div');
                        info.className = 'tyre-life-info';
                        info.textContent = 'roulez 3 tours minimum pour afficher la durée de vie';
                        info.style.cssText = 'font-size:10px;line-height:1.2;color:#999;font-style:italic;margin-top:2px;';
                        infoCellStart.appendChild(info);
                    }
                }
            } else {
                const wearPerLapStart = getSideWear(side, startCompound, 0);
                maxLapsStart = wearPerLapStart > 0 ? getTyreMaxLaps(wearPerLapStart) : 0;
            }
            const lifeInStintsStart = maxLapsStart > 0 ? maxLapsStart / toursParStint : 0;

            if (lifeInStintsStart > 0) {
                const anchorRowStart  = rows[0];
                const anchorCellStart = anchorRowStart.querySelector(`td:nth-child(${colNth})`);

                if (anchorCellStart) {
                    let pixelHeightStart = 0;
                    let stintsRemainStart = lifeInStintsStart;
                    let j = 0;

                    while (j < rows.length && stintsRemainStart > 0.01) {
                        const rowH     = rows[j].getBoundingClientRect().height;
                        const toursCell = rows[j].querySelector('td:nth-child(3)');
                        let stintTours = toursParStint;
                        if (toursCell) {
                            for (const sp of toursCell.querySelectorAll('span')) {
                                const v = parseFloat(sp.textContent.trim());
                                if (!isNaN(v) && v > 0 && v <= toursParStint * 1.05) {
                                    stintTours = v; break;
                                }
                            }
                            if (stintTours === toursParStint) {
                                for (const node of toursCell.childNodes) {
                                    if (node.nodeType === Node.TEXT_NODE) {
                                        const v = parseFloat(node.textContent.trim());
                                        if (!isNaN(v) && v > 0) { stintTours = v; break; }
                                    }
                                }
                            }
                        }
                        const toursRestantsVie = stintsRemainStart * toursParStint;
                        const toursConsommes   = Math.min(stintTours, toursRestantsVie);
                        const fractionLigne    = stintTours > 0 ? toursConsommes / stintTours : 0;
                        pixelHeightStart  += rowH * fractionLigne;
                        stintsRemainStart -= toursConsommes / toursParStint;
                        j++;
                    }

                    const overrunStart = lifeInStintsStart < 1;
                    anchorCellStart.style.overflow = 'visible';

                    const barStart = document.createElement('div');
                    barStart.className = [
                        'tyre-life-bar',
                        `side-${side}`,
                        `compound-${startCompound}`,
                        overrunStart ? 'overrun' : ''
                    ].filter(Boolean).join(' ');
                    barStart.style.height = `${Math.max(4, pixelHeightStart)}px`;
                    barStart.title = `${startCompound.charAt(0).toUpperCase() + startCompound.slice(1)}`
                                   + ` — ${maxLapsStart.toFixed(1)} tours · ${lifeInStintsStart.toFixed(1)} stints`
                                   + ` (pneus de départ — dès S1)`;
                    anchorCellStart.appendChild(barStart);
                }
            }
        }

        /* ══════════════════════════════════════════════════════
           PASS 1 : Pneus montés en cours de course (pitState)
           Logique inchangée : les pneus du pit stop du stint i
           roulent à partir du stint i+1.
           On exclut désormais le stint 0 de ce pass
           (les pneus de départ sont gérés au PASS 0).
        ══════════════════════════════════════════════════════ */
        let i = 0;
        while (i < rows.length) {
            const tr  = rows[i];
            const idx = parseInt(tr.dataset.stintIdx);
            const st  = pitState[idx] || defaultState();

            const compound = side === 'left'
                ? (st.tyreLeft  || 'none')
                : (st.tyreRight || 'none');

            if (compound === 'none') { i++; continue; }

            // Les pneus du pit stop du stint i roulent à partir du stint i+1
            // (pour le stint 0, les pneus DE DÉPART sont gérés ci-dessus ;
            //  les pneus sélectionnés dans la colonne du stint 0 = changement
            //  effectué au pit stop de fin de stint 1 → roulent dès le stint 2 = i+1)
            const anchorRowIdx = i + 1;

            if (anchorRowIdx >= rows.length) { i++; continue; }

            // En live : usure mesurée (≥ 3 tours) si dispo, sinon valeur de la base
            // circuits (champs tyre_*), sinon message d'information.
            const liveMeasured = isLive ? window._liveMeasuredWearPerLap?.[side] : null;
            const wearPerLap   = (liveMeasured != null && liveMeasured > 0)
                ? liveMeasured
                : getSideWearTheoretical(side, compound);
            const maxLaps      = wearPerLap > 0 ? getTyreMaxLaps(wearPerLap) : 0;
            const lifeInStints = maxLaps > 0 ? maxLaps / toursParStint : 0;

            if (lifeInStints <= 0) {
                if (isLive) {
                    const infoCell = tr.querySelector(`td:nth-child(${colNth})`);
                    if (infoCell) {
                        const info = document.createElement('div');
                        info.className = 'tyre-life-info';
                        info.textContent = 'roulez 3 tours minimum pour afficher la durée de vie';
                        info.style.cssText = 'font-size:10px;line-height:1.2;color:#999;font-style:italic;margin-top:2px;';
                        infoCell.appendChild(info);
                    }
                }
                i++; continue;
            }

            const anchorRow  = rows[anchorRowIdx];
            const anchorCell = anchorRow.querySelector(`td:nth-child(${colNth})`);
            if (!anchorCell) { i++; continue; }

            let pixelHeight  = 0;
            let stintsRemain = lifeInStints;
            let j            = anchorRowIdx;

            while (j < rows.length && stintsRemain > 0.01) {
                const rowH      = rows[j].getBoundingClientRect().height;
                const toursCell = rows[j].querySelector('td:nth-child(3)');
                let stintTours  = toursParStint;
                if (toursCell) {
                    const spans = toursCell.querySelectorAll('span');
                    for (const sp of spans) {
                        const v = parseFloat(sp.textContent.trim());
                        if (!isNaN(v) && v > 0 && v <= toursParStint * 1.05) {
                            stintTours = v; break;
                        }
                    }
                    if (stintTours === toursParStint) {
                        for (const node of toursCell.childNodes) {
                            if (node.nodeType === Node.TEXT_NODE) {
                                const v = parseFloat(node.textContent.trim());
                                if (!isNaN(v) && v > 0) { stintTours = v; break; }
                            }
                        }
                    }
                }

                const toursRestantsVie = stintsRemain * toursParStint;
                const toursConsommes   = Math.min(stintTours, toursRestantsVie);
                const fractionLigne    = stintTours > 0 ? toursConsommes / stintTours : 0;

                pixelHeight  += rowH * fractionLigne;
                stintsRemain -= toursConsommes / toursParStint;
                j++;
            }

            const overrun = lifeInStints < 1;
            anchorCell.style.overflow = 'visible';

            const bar = document.createElement('div');
            bar.className = [
                'tyre-life-bar',
                `side-${side}`,
                `compound-${compound}`,
                overrun ? 'overrun' : ''
            ].filter(Boolean).join(' ');
            bar.style.height = `${Math.max(4, pixelHeight)}px`;
            bar.title = `${compound.charAt(0).toUpperCase() + compound.slice(1)}`
                      + ` — ${maxLaps.toFixed(1)} tours · ${lifeInStints.toFixed(1)} stints`
                      + ` (montés au stand S${idx + 1}, roulent dès S${anchorRowIdx + 1})`;
            anchorCell.appendChild(bar);
            i++;
        }
    });
}

/* ══════════════════════════════════════════════
   MODE LIVE — GESTION PNEUS ACTUELS
   ══════════════════════════════════════════════ */

/* État pneus live — initialisé à null (= utiliser les données globales) */
window._liveTyreState = {
    compound:      'none',   // rétrocompat
    compoundLeft:  'none',   // gomme côté G
    compoundRight: 'none',   // gomme côté D
    wearLeft:      null,
    wearRight:     null,
    budget:        null,
};


/* Appelé à chaque frappe dans les champs d'usure live */
function onLiveTyreWearInput() {
    // Bug corrigé : #liveTyreCompound n'existe pas (seuls Left/Right existent) —
    // même repli "rétrocompat" que onLiveTyreCompoundChange().
    const cL = document.getElementById('liveTyreCompoundLeft')?.value  || 'none';
    const cR = document.getElementById('liveTyreCompoundRight')?.value || 'none';
    const compound = cL !== 'none' ? cL : cR;
    const wL = parseFloat(document.getElementById('liveTyreWearLeft')?.value);
    const wR = parseFloat(document.getElementById('liveTyreWearRight')?.value);

    window._liveTyreState.compound  = compound;
    window._liveTyreState.wearLeft  = isNaN(wL) ? null : Math.min(100, Math.max(0, wL));
    window._liveTyreState.wearRight = isNaN(wR) ? null : Math.min(100, Math.max(0, wR));

    // Calcul dynamique des tours restants pour affichage immédiat
    _updateLiveTyreWearLabels();

    // Recalcul live si actif
    if (window._liveModeActive) recalculateLive();
}


/* Met à jour les labels "X tours restants" à côté des champs */
function _updateLiveTyreWearLabels() {
    const toursParStint = (() => {
        const evRefuel = parseFloat(document.getElementById('evRefuelPerStint')?.value) || 100;
        const evPerLap = parseFloat(document.getElementById('evPerLap')?.value) || 8;
        return evRefuel / evPerLap;
    })();

    ['Left', 'Right'].forEach(side => {
        const compound = side === 'Left'
            ? (document.getElementById('liveTyreCompoundLeft')?.value  || 'none')
            : (document.getElementById('liveTyreCompoundRight')?.value || 'none');

        const lbl = document.getElementById(`liveTyreWear${side}Laps`);
        if (!lbl) return;

        const wearInputEl = document.getElementById(`liveTyreWear${side}`);
        const pct = wearInputEl ? parseFloat(wearInputEl.value) : NaN;

        if (compound === 'none' || isNaN(pct)) {
            lbl.textContent = '';
            return;
        }

        const wearSide = side === 'Left' ? 'left' : 'right';
        // Préfère le delta d'usure réellement MESURÉ en live (moyenne glissante
        // calculée par _liveStatsPollOnce à partir de recentLaps) à la valeur
        // théorique de la base circuits, quand elle est disponible — plus fiable
        // puisqu'elle reflète la session en cours plutôt qu'un relevé antérieur.
        const measured   = window._liveMeasuredWearPerLap?.[wearSide];
        const wearPerLap = (measured != null && measured > 0) ? measured : getSideWear(wearSide, compound, -1);

        if (wearPerLap <= 0) {
            const toursRest = Math.max(0, (pct - 40) / 1);
            lbl.textContent = `≈${toursRest.toFixed(0)}t ?`;
            lbl.style.color = '#888';
            return;
        }

        const toursRest  = Math.max(0, (pct - 40) / wearPerLap);
        const stintsRest = toursRest / toursParStint;

        lbl.textContent = `${toursRest.toFixed(1)}t · ${stintsRest.toFixed(1)} stints`;
        lbl.style.color = stintsRest < 0.5  ? '#ff4444'
                        : stintsRest < 1    ? '#ffaa00'
                        : '#88cc88';
    });
}

/* ── Réinitialisation du mode live ── */

		function resetLiveMode() {
			// Réinitialiser tous les flags live
            window._liveModeActive = false;
            window._liveMode       = false;
            window._liveNowSec     = 0;
            window._liveEvAtAnchor = 0;
				
			// Remettre les champs live à zéro
			
            document.getElementById('evCurrent').value      = '100';
            document.getElementById('evPerLapReal').value   = document.getElementById('evPerLap').value;
            document.getElementById('livelapMinutes').value = document.getElementById('lapMinutes').value;
            document.getElementById('livelapSeconds').value = document.getElementById('lapSeconds').value;
            document.getElementById('livelapMillis').value  = document.getElementById('lapMillis').value;

            const liveLapsCompletedEl = document.getElementById('liveLapsCompleted');
            if (liveLapsCompletedEl) liveLapsCompletedEl.value = '0';

            // Remettre les champs pneus live à zéro
            const liveTyreBudgetEl = document.getElementById('liveTyreBudget');
            if (liveTyreBudgetEl) liveTyreBudgetEl.value = '';
            const liveTyreCmpdLEl = document.getElementById('liveTyreCompoundLeft');
            if (liveTyreCmpdLEl) liveTyreCmpdLEl.value = 'none';
            const liveTyreCmpdREl = document.getElementById('liveTyreCompoundRight');
            if (liveTyreCmpdREl) liveTyreCmpdREl.value = 'none';            
            const liveTyreWLEl = document.getElementById('liveTyreWearLeft');
            if (liveTyreWLEl) liveTyreWLEl.value = '';
            const liveTyreWREl = document.getElementById('liveTyreWearRight');
            if (liveTyreWREl) liveTyreWREl.value = '';
            const ltwLblL = document.getElementById('liveTyreWearLeftLaps');
            if (ltwLblL) ltwLblL.textContent = '';
            const ltwLblR = document.getElementById('liveTyreWearRightLaps');
            if (ltwLblR) ltwLblR.textContent = '';

            // Masquer les champs live et remettre les boutons
            const liveFields   = document.getElementById('liveInputFields');
            const btnRecalc    = document.getElementById('btnRecalcLive');
            const btnStop      = document.getElementById('btnStopLive');
            const liveBadge    = document.getElementById('liveModeBadge');
            if (liveFields) liveFields.style.display = 'none';
            if (btnRecalc)  btnRecalc.style.display  = 'none';
            if (btnStop)    btnStop.style.display     = 'none';
            if (liveBadge)  liveBadge.style.display   = 'none';
            document.body.classList.remove('live-mode');

            // Réinitialiser l'état pneus live
            window._liveTyreState = {
                compound: 'none', wearLeft: null, wearRight: null, budget: null,
            };

			// Masquer le bloc résultats live
			const result = document.getElementById('liveRecalcResult');
			if (result) result.style.display = 'none';

	        // Recalculer en mode normal
	        calculate();
	        
	        // ── Synchroniser l'arrêt du mode live vers Firebase ──
	        // On attend que calculate() ait fini avant de pousser
	        // (suivi à distance : « Fin live » ne concerne que cet écran, la session partagée n'est pas touchée)
	        if (!(typeof liveRemoteReadOnly === 'function' && liveRemoteReadOnly())) {
	            _dirtyPitState = true;
	            _dirtyFields.add('_liveModeActive');
	            _dirtyFields.add('_liveTyreState');
	            setTimeout(() => pushToFirebase(true), 300);
	        }
		}
	
