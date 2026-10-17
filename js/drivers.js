/* ── Driver defaults ── */
const DRIVER_COLORS = [    
    '#00ff88', '#00aaff', '#ffaa00',
    '#aa00ff', '#ff6600', '#ff4444'
];
const DEFAULT_DRIVER_NAMES = ['Pilote 1', 'Pilote 2', 'Pilote 3', 'Pilote 4', 'Pilote 5', 'Pilote 6'];

function getDriverCount() {
    return parseInt(document.getElementById('driverCount').value) || 1;
}

function getDriverName(i) {
    const el = document.getElementById(`driverName_${i}`);
    return el ? el.value.trim() || DEFAULT_DRIVER_NAMES[i] : DEFAULT_DRIVER_NAMES[i];
}

function getDriverColor(i) {
    const el = document.getElementById(`driverColor_${i}`);
    return el ? el.value : DRIVER_COLORS[i % DRIVER_COLORS.length];
}

function getDriverOptions(selectedIdx) {
    let html = `<option value="-1" ${selectedIdx === -1 ? 'selected' : ''}>—</option>`;
    for (let i = 0; i < getDriverCount(); i++) {
        html += `<option value="${i}" ${selectedIdx === i ? 'selected' : ''}>${getDriverName(i)}</option>`;
    }
    return html;
}

/* Debounce timer pour les noms de pilotes */
let _driverNameDebounce = null;

function renderDriverInputs(preserveValues) {
    const n = getDriverCount();
    const container = document.getElementById('driverInputsContainer');

    /* Sauvegarder les valeurs actuelles avant de vider le container */
    const savedNames  = [];
    const savedColors = [];
    for (let i = 0; i < n; i++) {
        const nameEl  = document.getElementById(`driverName_${i}`);
        const colorEl = document.getElementById(`driverColor_${i}`);
        savedNames[i]  = nameEl  ? nameEl.value  : (DEFAULT_DRIVER_NAMES[i]);
        savedColors[i] = colorEl ? colorEl.value : (DRIVER_COLORS[i % DRIVER_COLORS.length]);
    }

    container.innerHTML = '';
    for (let i = 0; i < n; i++) {
        const row = document.createElement('div');
        row.className = 'driver-input-row';

        /* Utiliser preserveValues (données distantes) si fourni,
           sinon les valeurs sauvegardées localement */
        const nameVal  = (preserveValues && preserveValues[i]?.name  !== undefined)
            ? preserveValues[i].name
            : savedNames[i];
        const colorVal = (preserveValues && preserveValues[i]?.color !== undefined)
            ? preserveValues[i].color
            : savedColors[i];

        row.innerHTML = `
            <input type="color" id="driverColor_${i}"
                class="driver-color-swatch"
                value="${colorVal}"
                onchange="window._liveModeActive ? recalculateLive() : calculate()"
                title="Couleur du pilote ${i+1}">
            <input type="text" id="driverName_${i}"
                class="driver-name-input"
                placeholder="${DEFAULT_DRIVER_NAMES[i]}"
                value="${nameVal}"
                oninput="onDriverNameInput()">
        `;
        container.appendChild(row);
    }
    calculate();
}

/* Appelé à chaque frappe dans un champ nom de pilote.
   Le recalcul est différé de 1000ms pour ne pas reconstruire
   le DOM (et perdre le focus) à chaque caractère. */
function onDriverNameInput() {
    _dirtyDrivers = true;
    clearTimeout(_driverNameDebounce);
    _driverNameDebounce = setTimeout(() => {
        window._liveModeActive ? recalculateLive() : calculate();
    }, 1000);
}

window.onload = () => {
    renderDriverInputs();

// ── Compte à rebours à la seconde ──
        setInterval(() => {
            if (!window._liveModeActive) return;
            // Valeur du jeu disponible : c'est recalculateLive() (poll télémétrie)
            // qui affiche le temps restant. Ne pas l'écraser ici avec le calcul
            // heure de départ + durée planifiée (sinon clignotement entre les deux).
            const _lsr = window._liveSessionTimeRemainingSec;
            if (_lsr != null && !isNaN(_lsr)) return;
            const realStart   = getRealStart();
            const totalRaceSec = getRaceTimeInSeconds();
            const raceEndSec   = realStart + totalRaceSec;
            const now          = new Date();
            let nowSec         = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
            if (raceEndSec > 86400 && nowSec < realStart) nowSec += 86400;
            const el = document.getElementById('liveTempsRestant');
            if (el) el.textContent = formatDuration(Math.max(0, raceEndSec - nowSec));
        }, 1000);	
    

    // ── Recalcul complet toutes les 30secondes ──
        setInterval(() => {
            if (document.getElementById('timelineTrack').children.length > 0) {
                if (window._liveModeActive) {
                    recalculateLive();
                } else {
                    calculate();
                }
            }
        }, 30000);
    };	

	/* ── Recalcul en cours de course ── */

