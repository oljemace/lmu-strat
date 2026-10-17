/* ══════════════════════════════════════════════
   BASE DE DONNÉES CIRCUITS
   ══════════════════════════════════════════════ */
let _circuits = {};
let _editingCircuitId = null;

/* Grille d'usure pneus dans l'éditeur circuit */
function renderCircuitTyreGrid() {
    // La grille est maintenant du HTML statique dans tab-circuits,
    // plus besoin de la construire dynamiquement.
    // On branche juste les événements oninput sur les champs.
    ['FL','FR','RL','RR'].forEach(corner => {
        ['soft','medium','hard','wet'].forEach(compound => {
            const el = document.getElementById(`circTyre_${corner}_${compound}`);
            if (el && !el.dataset.hooked) {
                el.dataset.hooked = 'true';
                el.addEventListener('input', () =>
                    updateCircTyreWearUI(corner, compound, el.value));
            }
        });
    });
}

function updateCircTyreWearUI(corner, compound, rawVal) {
    const TYRE_COLORS = { soft: '#ff6060', medium: '#ffcc00', hard: '#dddddd', wet: '#3399ff' };
    const wearPerLap  = parseFloat(rawVal) || 0;
    const maxLaps     = wearPerLap > 0 ? (60 / wearPerLap) : 0;

    // Barre
    const bar = document.getElementById(`circTyre_${corner}_${compound}_bar`);
    if (bar) {
        const maxWear = Math.max(0.01,
            ...['soft','medium','hard','wet'].map(c => {
                const e = document.getElementById(`circTyre_${corner}_${c}`);
                return e ? (parseFloat(e.value) || 0) : 0;
            })
        );
        const ratio = wearPerLap > 0
            ? Math.max(0.08, (maxWear - wearPerLap) / maxWear + 0.15)
            : 0;
        bar.style.width      = wearPerLap > 0 ? `${Math.min(100, ratio * 100)}%` : '0%';
        bar.style.background = wearPerLap > 0 ? TYRE_COLORS[compound] : 'rgba(255,255,255,0.1)';
    }

    // Label tours / stints
    const lbl = document.getElementById(`circTyre_${corner}_${compound}_lbl`);
    if (lbl) {
        if (wearPerLap <= 0) {
            lbl.textContent = '—';
            lbl.style.color = '#555';
        } else {
            // Calcul stints basé sur evPerLap du circuit en cours d'édition
            const evPerLap      = parseFloat(document.getElementById('circEvPerLap')?.value) || 8;
            const toursParStint = 100 / evPerLap;
            const stints        = maxLaps / toursParStint;
            lbl.textContent     = `${maxLaps.toFixed(1)}t · ${stints.toFixed(1)} stints`;
            lbl.style.color     = stints < 1   ? '#ff6060'
                                : stints < 1.5 ? '#ffaa00'
                                :                '#88cc88';
        }
    }
}

/* Enregistrer le circuit courant */
/* Import télémétrie LMU : lit le fichier de résultats XML choisi via
   le bouton "Parcourir" et en extrait tout ce qui peut remplir
   l'éditeur de circuit : usure pneus par gomme, temps au tour,
   consommation d'énergie virtuelle (VE) par tour, voiture utilisée
   et circuit, à partir des balises <RaceResults>/<Driver>/<Lap>. */
