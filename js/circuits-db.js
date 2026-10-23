const _CIRC_SAFE_ID = /^[\w-]+$/;

function saveCircuit() {
    const name = document.getElementById('circuitNameInput').value.trim();
    if (!name) { alert('Donnez un nom au circuit.'); return; }

    const carId = document.getElementById('circCarSelect').value;
    if (!carId) { alert('Sélectionnez une voiture avant d\'enregistrer.'); return; }

    const id = _editingCircuitId || ('circ_' + Date.now());

    const tyres = {};
    ['FL','FR','RL','RR'].forEach(corner => {
        tyres[corner] = {};
        ['soft','medium','hard','wet'].forEach(compound => {
            tyres[corner][compound] =
                parseFloat(document.getElementById(`circTyre_${corner}_${compound}`)?.value) || 0;
        });
    });

    const carData = {
        lapMin:   parseInt(document.getElementById('circLapMin').value) || 0,
        lapSec:   parseInt(document.getElementById('circLapSec').value) || 0,
        lapMil:   parseInt(document.getElementById('circLapMil').value) || 0,
        evPerLap: parseFloat(document.getElementById('circEvPerLap').value) || 8,
        tyres
    };

    // Initialiser le circuit s'il n'existe pas encore
    if (!_circuits[id]) _circuits[id] = { name, cars: {} };
    _circuits[id].name = name;
    if (!_circuits[id].cars) _circuits[id].cars = {};
    _circuits[id].cars[carId] = carData;

    _editingCircuitId = id;
    saveCircuitsToFirebase();
    refreshCircuitSelects();

    const carLabel = LMU_HYPERCARS.find(c => c.id === carId)?.label || carId;
    document.getElementById('circuitSaveInfo').textContent =
        `✅ "${name}" / ${carLabel} enregistré à ${new Date().toLocaleTimeString('fr')}`;
}

/* Charger un circuit dans l'éditeur */
function editCircuit(id) {
    _editingCircuitId = id || null;
    const c = _circuits[id];
    renderCircuitTyreGrid();
    buildCircCarSelector();  // reconstruire le select voiture

    if (!c) {
        document.getElementById('circuitNameInput').value = '';
        document.getElementById('circLapMin').value = 3;
        document.getElementById('circLapSec').value = 35;
        document.getElementById('circLapMil').value = 0;
        document.getElementById('circEvPerLap').value = 8.0;
        ['FL','FR','RL','RR'].forEach(corner => {
            ['soft','medium','hard','wet'].forEach(compound => {
                const el = document.getElementById(`circTyre_${corner}_${compound}`);
                if (el) el.value = 0;
            });
        });
        return;
    }
    document.getElementById('circuitNameInput').value = c.name || '';

    // Charger les données de la voiture actuellement sélectionnée (si dispo)
    const carId = document.getElementById('circCarSelect').value;
    _loadCircuitCarFields(c, carId);
}

/* Charge les champs temps/conso/pneus pour un couple circuit+voiture */
function _loadCircuitCarFields(c, carId) {
    const data = (carId && c.cars?.[carId]) ? c.cars[carId] : null;

    document.getElementById('circLapMin').value   = data?.lapMin   ?? 3;
    document.getElementById('circLapSec').value   = data?.lapSec   ?? 35;
    document.getElementById('circLapMil').value   = data?.lapMil   ?? 0;
    document.getElementById('circEvPerLap').value = data?.evPerLap ?? 8.0;

    ['FL','FR','RL','RR'].forEach(corner => {
        ['soft','medium','hard','wet'].forEach(compound => {
            const el = document.getElementById(`circTyre_${corner}_${compound}`);
            if (el) {
                el.value = data?.tyres?.[corner]?.[compound] ?? 0;
                updateCircTyreWearUI(corner, compound, el.value);
            }
        });
    });
}

/* Appelé quand on change de voiture dans l'éditeur */
function onCircCarChange() {
    if (!_editingCircuitId || !_circuits[_editingCircuitId]) return;
    const carId = document.getElementById('circCarSelect').value;
    _loadCircuitCarFields(_circuits[_editingCircuitId], carId);
}

/* Supprimer le circuit en cours d'édition */
function deleteCircuit() {
    if (!_editingCircuitId || !_circuits[_editingCircuitId]) {
        alert('Aucun circuit sélectionné à supprimer.');
        return;
    }
    const nom = _circuits[_editingCircuitId].name;
    if (!confirm(`Supprimer définitivement le circuit "${nom}" ?`)) return;

    delete _circuits[_editingCircuitId];
    _editingCircuitId = null;
    saveCircuitsToFirebase();
    refreshCircuitSelects();
    editCircuit('');   // réinitialise l'éditeur
    document.getElementById('circuitSaveInfo').textContent =
        `🗑️ "${nom}" supprimé.`;
}

/* ── Suppressions directement depuis la matrice Circuits × Voitures ──
   Permet de tenir la base à jour sans repasser par l'éditeur de circuit. */

function deleteMatrixCarEntry(circId, carId) {
    const c = _circuits[circId];
    if (!c || !c.cars || !c.cars[carId]) return;
    const carLabel = LMU_HYPERCARS.find(x => x.id === carId)?.label || carId;
    if (!confirm(`Supprimer toutes les données de "${carLabel}" pour le circuit "${c.name || circId}" ?\n(temps au tour, conso EV et usure des 3 gommes — irréversible)`)) return;
    delete c.cars[carId];
    saveCircuitsToFirebase();
    renderCircuitMatrix();
}

function deleteMatrixCompound(circId, carId, compound) {
    const c = _circuits[circId];
    const data = c?.cars?.[carId];
    if (!data || !data.tyres) return;
    const carLabel = LMU_HYPERCARS.find(x => x.id === carId)?.label || carId;
    const compoundLabel = {soft: 'Soft', medium: 'Medium', hard: 'Hard'}[compound] || compound;
    if (!confirm(`Supprimer les données d'usure "${compoundLabel}" de "${carLabel}" sur "${c.name || circId}" ?`)) return;
    ['FL', 'FR', 'RL', 'RR'].forEach(corner => {
        if (data.tyres[corner]) data.tyres[corner][compound] = 0;
    });
    saveCircuitsToFirebase();
    renderCircuitMatrix();
}

/* Rafraîchir les deux <select> (stratégie + éditeur) */
function refreshCircuitSelects() {
    const sel1 = document.getElementById('circuitSelect');       // page stratégie
    const sel2 = document.getElementById('circuitEditSelect');   // page éditeur

    if (sel1) {
        const cur = sel1.value || window._wantCircuit || '';
        sel1.innerHTML = '<option value="">— Aucun circuit —</option>';
        Object.entries(_circuits).forEach(([id, c]) => {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = c.name || id;
            if (id === cur) opt.selected = true;
            sel1.appendChild(opt);
        });
    }
    updateRaceContextBadge();

    if (sel2) {
        const cur = sel2.value;
        sel2.innerHTML = '<option value="">— Nouveau circuit —</option>';
        Object.entries(_circuits).forEach(([id, c]) => {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = c.name || id;
            if (id === cur) opt.selected = true;
            sel2.appendChild(opt);
        });
    }
}

/* ── Construit le select voiture dans l'éditeur circuit ── */
function buildCircCarSelector() {
    const select = document.getElementById('circCarSelect');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">— Choisir une voiture —</option>';
    const groups = { LMH: [], LMDh: [] };
    LMU_HYPERCARS.forEach(car => groups[car.ruleset].push(car));
    for (const [ruleset, cars] of Object.entries(groups)) {
        const optgroup = document.createElement('optgroup');
        optgroup.label = ruleset;
        cars.forEach(car => {
            const opt = document.createElement('option');
            opt.value = car.id;
            opt.textContent = car.label;
            if (car.id === current) opt.selected = true;
            optgroup.appendChild(opt);
        });
        select.appendChild(optgroup);
    }
}

/* ── Construit le select voiture dans l'onglet Stratégie ── */
function buildStratCarSelector() {
    const select = document.getElementById('stratCarSelect');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">— Choisir une voiture —</option>';
    const groups = { LMH: [], LMDh: [] };
    LMU_HYPERCARS.forEach(car => groups[car.ruleset].push(car));
    for (const [ruleset, cars] of Object.entries(groups)) {
        const optgroup = document.createElement('optgroup');
        optgroup.label = ruleset;
        cars.forEach(car => {
            const opt = document.createElement('option');
            opt.value = car.id;
            opt.textContent = car.label;
            if (car.id === current) opt.selected = true;
            optgroup.appendChild(opt);
        });
        select.appendChild(optgroup);
    }
    updateRaceContextBadge();
}

/* ── Bandeau « circuit + voiture » du mode planification ── */
function updateRaceContextBadge() {
    const el = document.getElementById('raceContextBadge');
    if (!el) return;
    const cId = document.getElementById('circuitSelect')?.value || '';
    const carId = document.getElementById('stratCarSelect')?.value || '';
    const circuit = cId ? (_circuits[cId]?.name || cId) : '';
    const car = carId ? (LMU_HYPERCARS.find(c => c.id === carId)?.label || carId) : '';
    el.innerHTML = '';
    if (circuit) {
        const s = document.createElement('span');
        s.textContent = '🏁 ' + circuit;
        el.appendChild(s);
    }
    if (car) {
        const s = document.createElement('span');
        s.textContent = '🏎️ ' + car;
        el.appendChild(s);
    }
    el.style.display = (circuit || car) ? 'flex' : 'none';
}

/* ══════════════════════════════════════════════
   CHARGEMENT D'UN CIRCUIT DANS LA STRATÉGIE   
   ══════════════════════════════════════════════ */

function loadCircuitData() {
    const id    = document.getElementById('circuitSelect').value;
    const carId = document.getElementById('stratCarSelect').value;
    const info  = document.getElementById('circuitLoadInfo');

    updateRaceContextBadge();
    if (!id || !_circuits[id]) {
        if (info) info.textContent = '';
        return;
    }
    const c    = _circuits[id];
    const data = (carId && c.cars?.[carId]) ? c.cars[carId] : null;

    // Temps au tour
    document.getElementById('lapMinutes').value = data?.lapMin ?? 3;
    document.getElementById('lapSeconds').value = data?.lapSec ?? 35;
    document.getElementById('lapMillis').value  = data?.lapMil ?? 0;

    // Conso EV/tour
    document.getElementById('evPerLap').value = data?.evPerLap ?? 8.0;

    // Usure pneus
    const tyres = data?.tyres ?? null;
    ['FL','FR','RL','RR'].forEach(corner => {
        ['soft','medium','hard','wet'].forEach(compound => {
            const val = tyres?.[corner]?.[compound] ?? 0;
            const el  = document.getElementById(`tyre_${corner}_${compound}`);
            if (el) {
                el.value = val;
                updateTyreWearUI(corner, compound, val);
            }
        });
    });

    if (info) {
        const carLabel = LMU_HYPERCARS.find(c => c.id === carId)?.label || '';
        const lapMin   = data?.lapMin ?? '?';
        const lapSec   = String(data?.lapSec ?? '??').padStart(2,'0');
        const lapMil   = data?.lapMil ?? '?';
        const evLabel  = data ? `${data.evPerLap}%/tour` : 'données voiture manquantes';
        info.textContent = data
            ? `✅ "${c.name}" / ${carLabel} — ${lapMin}:${lapSec}.${lapMil} · ${evLabel}`
            : `⚠️ "${c.name}" chargé — aucune donnée pour ${carLabel || 'cette voiture'}`;
        info.style.color = data ? '#88ccff' : '#ffaa00';
    }

    window._liveModeActive ? recalculateLive() : calculate();
}

/* ══════════════════════════════════════════════
   PERSISTANCE FIREBASE DES CIRCUITS
   Les circuits sont partagés par toute l'équipe,
   stockés sous teams/{équipe}/circuits plutôt que
   dans une session.
   ══════════════════════════════════════════════ */
function saveCircuitsToFirebase() {
    if (!window._firebaseDb || !canWriteTeamData()) return;
    const ref = window._firebaseRef(window._firebaseDb, teamPath('circuits'));
    window._firebaseSet(ref, _circuits)
        .then(() => console.log('Circuits sauvegardés'))
        .catch(err => console.error('Erreur sauvegarde circuits:', err));
}

function loadCircuitsFromFirebase() {
    if (!window._firebaseDb) return;
    const ref = window._firebaseRef(window._firebaseDb, teamPath('circuits'));
    window._firebaseOnValue(ref, snap => {
        _circuits = snap.val() || {};
        refreshCircuitSelects();
        buildStratCarSelector();
        buildCircCarSelector();
        // Rafraîchir la matrice si elle est ouverte
        if (document.getElementById('matrixPanel')?.dataset.open === 'true') {
            renderCircuitMatrix();
        }
    }, { onlyOnce: false });
}

/* ══════════════════════════════════════════════
   MATRICE CIRCUITS × VOITURES
══════════════════════════════════════════════ */

function toggleCircuitMatrix() {
    const panel   = document.getElementById('matrixPanel');
    const icon    = document.getElementById('matrixToggleIcon');
    const filter  = document.getElementById('matrixFilterBar');
    const isOpen  = panel.dataset.open === 'true';

    if (!isOpen) {
        // Ouverture
        panel.dataset.open      = 'true';
        filter.style.display    = 'flex';
        icon.style.transform    = 'rotate(180deg)';

        renderCircuitMatrix();   // construire le tableau

        panel.style.opacity     = '0';
        panel.style.maxHeight   = '0px';

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                panel.style.maxHeight = panel.scrollHeight + 'px';
                panel.style.opacity   = '1';
            });
        });

        panel.addEventListener('transitionend', function _clean(e) {
            if (e.propertyName === 'max-height') {
                panel.style.maxHeight = 'none';
                panel.removeEventListener('transitionend', _clean);
            }
        });

    } else {
        // Fermeture
        panel.dataset.open    = 'false';
        filter.style.display  = 'none';
        icon.style.transform  = 'rotate(0deg)';

        panel.style.maxHeight = panel.scrollHeight + 'px';
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                panel.style.maxHeight = '0px';
                panel.style.opacity   = '0';
            });
        });
    }
}

function renderCircuitMatrix() {
    const table       = document.getElementById('circuitMatrix');
    table.style.borderCollapse = 'separate';
    table.style.borderSpacing  = '0';    
    const filterCar   = document.getElementById('matrixCarFilter')?.value || '';
    const countLabel  = document.getElementById('matrixCountLabel');
    if (!table) return;

    // Assurer que le conteneur scrollable est correctement configuré
    const scrollContainer = table.closest('div[style*="overflow-x"]');
    if (scrollContainer) {
        scrollContainer.style.position = 'relative';
    }

    // ── Collecte des données ──
    // Toutes les voitures présentes dans la base
    const allCarIds = new Set();
    // Les circuits sont saisis par les membres de l'équipe (Firebase) : identifiants
    // limités à des caractères sûrs (ils finissent dans des onclick) et noms échappés.
    Object.values(_circuits).forEach(c => {
        Object.keys(c.cars || {}).forEach(carId => { if (_CIRC_SAFE_ID.test(carId)) allCarIds.add(carId); });
    });

    // Remplir le filtre voiture si vide
    const matrixFilter = document.getElementById('matrixCarFilter');
    if (matrixFilter && matrixFilter.options.length <= 1) {
        allCarIds.forEach(carId => {
            const label = LMU_HYPERCARS.find(c => c.id === carId)?.label || carId;
            const opt   = document.createElement('option');
            opt.value   = carId;
            opt.textContent = label;
            matrixFilter.appendChild(opt);
        });
    }

    // Voitures à afficher (filtrées ou toutes)
    const carIds = filterCar
        ? [filterCar]
        : [...allCarIds].sort((a, b) => {
            const la = LMU_HYPERCARS.find(c => c.id === a)?.label || a;
            const lb = LMU_HYPERCARS.find(c => c.id === b)?.label || b;
            return la.localeCompare(lb);
        });

    // Circuits triés par nom
    const circuitEntries = Object.entries(_circuits)
        .filter(([id]) => _CIRC_SAFE_ID.test(id))
        .sort((a, b) => (a[1].name || '').localeCompare(b[1].name || ''));

    if (circuitEntries.length === 0) {
        table.innerHTML = `<tr><td style="color:var(--text-4);padding:20px;text-align:center;">
            Aucun circuit enregistré.</td></tr>`;
        if (countLabel) countLabel.textContent = '';
        return;
    }

    // Compteur
    let entryCount = 0;
    circuitEntries.forEach(([, c]) => {
        carIds.forEach(carId => {
            if (c.cars?.[carId]) entryCount++;
        });
    });
    if (countLabel) {
        countLabel.textContent =
            `${circuitEntries.length} circuit(s) · ${entryCount} entrée(s) voiture`;
    }

    // ── Helpers ──
    const COMPOUND_COLORS = {
        soft:   { color: '#dddddd', bg: 'rgba(220,220,220,0.08)', label: '⚪ S' },
        medium: { color: '#ffcc00', bg: 'rgba(255,200,0,0.12)',   label: '🟡 M' },
        hard:   { color: '#ff6060', bg: 'rgba(255,60,60,0.12)',   label: '🔴 H' },
    };

    // Calcul durée de vie pour un couple circuit+voiture+gomme
    function getCompoundLife(carData, compound) {
        if (!carData?.tyres) return null;
        const corners  = ['FL', 'FR', 'RL', 'RR'];
        const wears    = corners
            .map(c => parseFloat(carData.tyres?.[c]?.[compound]) || 0)
            .filter(v => v > 0);
        if (wears.length === 0) return null;

        // Usure maximale (côté limitant)
        const worstWear = Math.max(...wears);
        const maxLaps   = 60 / worstWear;   // TYRE_WEAR_MARGIN = 60

        const evPerLap      = carData.evPerLap || 8;
        const toursParStint = 100 / evPerLap;
        const stints        = maxLaps / toursParStint;

        // Déséquilibre G/D
        const wearsL = ['FL','RL'].map(c => parseFloat(carData.tyres?.[c]?.[compound]) || 0).filter(v=>v>0);
        const wearsR = ['FR','RR'].map(c => parseFloat(carData.tyres?.[c]?.[compound]) || 0).filter(v=>v>0);
        const avgL   = wearsL.length ? wearsL.reduce((a,b)=>a+b)/wearsL.length : 0;
        const avgR   = wearsR.length ? wearsR.reduce((a,b)=>a+b)/wearsR.length : 0;
        const asymmetric = avgL > 0 && avgR > 0 && Math.abs(avgL - avgR) / Math.max(avgL, avgR) > 0.12;

        return { worstWear, maxLaps, stints, asymmetric };
    }

    function lapTimeStr(d) {
        if (!d) return '—';
        const min = d.lapMin ?? '?';
        const sec = String(d.lapSec ?? '??').padStart(2, '0');
        const mil = d.lapMil ?? '?';
        return `${min}:${sec}.${mil}`;
    }

    // ── Génération du HTML ──
    let html = '<thead><tr>';

    // Colonne 1 : voiture + colonne 2 : gomme
    html += `
        <th style="
            background:#0d1a2e;color:var(--accent);
            font-size:0.85em;padding:8px 10px;
            white-space:nowrap;border-bottom:2px solid rgba(var(--accent-rgb),0.3);
            position:sticky;left:0;z-index:4;
            box-shadow:2px 0 6px rgba(0,0,0,0.8);
            border-right:1px solid rgba(var(--accent-rgb),0.15);">
            🏎️ Voiture
        </th>
        <th id="matrixColGomme" style="
            background:#0d1a2e;color:var(--accent);
            font-size:0.85em;padding:8px 10px;
            white-space:nowrap;border-bottom:2px solid rgba(var(--accent-rgb),0.3);
            position:sticky;left:140px;z-index:4;
            box-shadow:2px 0 6px rgba(0,0,0,0.8);
            border-right:1px solid rgba(var(--accent-rgb),0.1);">
            🔘 Gomme
        </th>`;
        
    // Colonnes circuits
    circuitEntries.forEach(([, c]) => {
        html += `
            <th style="
                background:rgba(var(--accent-rgb),0.12);color:var(--accent);
                font-size:0.85em;padding:8px 12px;text-align:center;
                white-space:nowrap;border-bottom:2px solid rgba(var(--accent-rgb),0.3);
                min-width:130px;">
                🏁 ${_teamTelemetryEscapeHtml(c.name || '?')}
            </th>`;
    });
    html += '</tr></thead><tbody>';

    // Lignes : une voiture = 3 lignes (S, M, H) + 1 ligne ⏱/🔋
    carIds.forEach((carId, carIdx) => {
        const carLabel = _teamTelemetryEscapeHtml(LMU_HYPERCARS.find(c => c.id === carId)?.label || carId);
        const rowBg    = carIdx % 2 === 0
            ? 'rgba(255,255,255,0.02)'
            : 'rgba(0,0,0,0.12)';

        // Largeur de la colonne "Voiture" — mesurée après premier rendu,
        // sinon on pose une valeur fixe raisonnable.
        const col1W = 140;

        const stickyStyle = `
            position:sticky;left:0;z-index:2;
            background:#0d1a2e;
            box-shadow:2px 0 6px rgba(0,0,0,0.8);
            border-right:1px solid rgba(var(--accent-rgb),0.15);`;

        const stickyStyle2 = `
            position:sticky;left:${col1W}px;z-index:2;
            background:#0d1a2e;
            box-shadow:2px 0 6px rgba(0,0,0,0.8);
            border-right:1px solid rgba(var(--accent-rgb),0.1);`;

        // ── Ligne ⏱ Temps au tour + 🔋 Conso ──
        html += `<tr style="background:${rowBg};">`;
        html += `
            <td rowspan="4"
                style="${stickyStyle}
                    color:var(--text);font-weight:bold;font-size:0.82em;
                    padding:8px 10px;vertical-align:middle;
                    border-top:2px solid rgba(var(--fg-rgb),0.08);
                    white-space:nowrap;min-width:${col1W}px;width:${col1W}px;">
                ${carLabel}
            </td>
            <td style="${stickyStyle2}
                color:var(--text-3);font-size:0.78em;padding:6px 10px;
                border-top:2px solid rgba(var(--fg-rgb),0.08);
                white-space:nowrap;">
                ⏱ T.Tour<br>🔋 EV/t
            </td>`;

        circuitEntries.forEach(([circId, c]) => {
            const data = c.cars?.[carId];
            if (!data) {
                html += `<td style="
                    text-align:center;color:#333;font-size:0.78em;
                    padding:6px 8px;
                    border-top:2px solid rgba(var(--fg-rgb),0.08);">—</td>`;
            } else {
                const hasData = data.lapMin || data.lapSec || data.evPerLap;
                html += `<td style="
                    position:relative;
                    text-align:center;padding:6px 8px;
                    border-top:2px solid rgba(var(--fg-rgb),0.08);
                    cursor:pointer;"
                    title="Cliquer pour charger dans la stratégie"
                    onclick="loadCircuitIntoStrategy('${circId}','${carId}')">
                    <button
                        onclick="event.stopPropagation(); deleteMatrixCarEntry('${circId}','${carId}')"
                        title="Supprimer toutes les données de cette voiture sur ce circuit"
                        style="position:absolute;top:1px;right:1px;width:16px;height:16px;line-height:14px;
                            padding:0;border:none;border-radius:3px;background:rgba(255,68,102,0.15);
                            color:#ff6688;font-size:0.72em;cursor:pointer;z-index:1;">🗑</button>
                    <div style="color:var(--text);font-weight:bold;font-size:0.88em;">
                        ${lapTimeStr(data)}
                    </div>
                    <div style="color:#88ccff;font-size:0.75em;margin-top:2px;">
                        ${data.evPerLap ?? '?'}%/t
                    </div>
                </td>`;
            }
        });
        html += '</tr>';

        // ── Lignes S, M, H ──
        ['soft', 'medium', 'hard'].forEach(compound => {
            const cp = COMPOUND_COLORS[compound];
            html += `<tr style="background:${rowBg};">`;
            html += `
                <td style="${stickyStyle2}
                    color:${cp.color};font-size:0.78em;
                    padding:5px 10px;font-weight:bold;
                    white-space:nowrap;">
                    ${cp.label}
                    <span style="color:#555;font-size:0.75em;font-weight:normal;">
                        %/tour
                    </span>
                </td>`;

            circuitEntries.forEach(([circId, c]) => {
                const data = c.cars?.[carId];
                const life = data ? getCompoundLife(data, compound) : null;

                if (!life) {
                    html += `<td style="
                        text-align:center;color:#2a2a2a;font-size:0.78em;
                        padding:5px 8px;">—</td>`;
                } else {
                    // Couleur de la cellule selon durabilité
                    const stintColor = life.stints >= 2   ? '#88cc88'
                                     : life.stints >= 1   ? '#ffaa00'
                                     :                      '#ff6060';

                    // Badge asymétrie G/D
                    const asymBadge = life.asymmetric
                        ? `<span title="Déséquilibre G/D notable"
                               style="color:#ff8800;font-size:0.75em;"> ⚠</span>`
                        : '';

                    html += `
                        <td style="
                            position:relative;
                            text-align:center;
                            padding:5px 8px;
                            background:${cp.bg};">
                            <button
                                onclick="event.stopPropagation(); deleteMatrixCompound('${circId}','${carId}','${compound}')"
                                title="Supprimer les données d'usure ${cp.label} de cette voiture sur ce circuit"
                                style="position:absolute;top:1px;right:1px;width:16px;height:16px;line-height:14px;
                                    padding:0;border:none;border-radius:3px;background:rgba(255,68,102,0.15);
                                    color:#ff6688;font-size:0.72em;cursor:pointer;z-index:1;">🗑</button>
                            <div style="color:var(--text);font-size:0.82em;font-weight:bold;">
                                ${life.worstWear.toFixed(2)}%/t
                            </div>
                            <div style="color:${stintColor};font-size:0.72em;margin-top:1px;">
                                ${life.maxLaps.toFixed(0)}t · ${life.stints.toFixed(1)} stints
                                ${asymBadge}
                            </div>
                        </td>`;
                }
            });
            html += '</tr>';
        });
    });

    html += '</tbody>';
    table.innerHTML = html;

    // Ajuster la hauteur du panel si déjà ouvert
    const panel = document.getElementById('matrixPanel');
    if (panel?.dataset.open === 'true') {
        panel.style.maxHeight = 'none';
    }

    // ── Mesurer la vraie largeur de la col1 après rendu
    //    et corriger le left des cellules col2 ──
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            const firstTh = table.querySelector('thead th:first-child');
            if (!firstTh) return;
            const realW = firstTh.getBoundingClientRect().width;
            if (realW <= 0) return;

            table.querySelectorAll('thead th:nth-child(2)').forEach(th => {
                th.style.left = `${realW}px`;
            });
            table.querySelectorAll('tbody td:nth-child(2)').forEach(td => {
                td.style.left = `${realW}px`;
            });
            // Forcer background opaque sur col1 du thead également
            table.querySelectorAll('thead th:first-child').forEach(th => {
                th.style.background = '#0d1a2e';
            });
        });
    });
}

/* Charge un circuit+voiture directement dans l'onglet Stratégie */
function loadCircuitIntoStrategy(circuitId, carId) {
    // Sélectionner le circuit et la voiture dans les selects
    const sel1 = document.getElementById('circuitSelect');
    const sel2 = document.getElementById('stratCarSelect');
    if (sel1) sel1.value = circuitId;
    if (sel2) sel2.value = carId;

    // Charger les données
    loadCircuitData();

    // Basculer vers l'onglet stratégie avec un feedback visuel
    switchTab('strategy');

    // Flash de confirmation sur le bloc circuit
    const circBlock = document.getElementById('circuitLoadInfo');
    if (circBlock) {
        circBlock.style.transition = 'background 0.2s';
        circBlock.style.background = 'rgba(var(--accent-rgb),0.18)';
        setTimeout(() => circBlock.style.background = 'transparent', 800);
    }
}

