/* ── Pneus de départ : gestion du changement ── */
function onStartTyreChange() {
    const left  = document.getElementById('startTyreLeft')?.value  || 'none';
    const right = document.getElementById('startTyreRight')?.value || 'none';

    window._startTyres = { left, right };

    // Colorer les selects
    _applyStartTyreSelectStyle('startTyreLeft',  left);
    _applyStartTyreSelectStyle('startTyreRight', right);

    // Mettre à jour le label de durée de vie
    _updateStartTyreLifeInfo();

    // Mettre à jour la jauge de pneus (les pneus de départ consomment du stock)
    updateTyreGauge();

    // Reconstruire les barres de durée de vie
    requestAnimationFrame(() => requestAnimationFrame(() => buildTyreLifeBars()));

    window._liveModeActive ? recalculateLive() : calculate();
    _dirtyFields.add('_startTyres');
    pushToFirebase(true);
}

function _applyStartTyreSelectStyle(elId, compound) {
    const sel = document.getElementById(elId);
    if (!sel) return;
    sel.style.borderColor = compound === 'soft'   ? '#ff6060'
                          : compound === 'medium' ? '#ffcc00'
                          : compound === 'hard'   ? '#dddddd'
                          : 'rgba(255,255,255,0.15)';
    sel.style.color       = compound === 'soft'   ? '#ff6060'
                          : compound === 'medium' ? '#ffcc00'
                          : compound === 'hard'   ? '#dddddd'
                          : '#aaa';
    sel.style.background  = compound === 'soft'   ? 'rgba(255,60,60,0.1)'
                          : compound === 'medium' ? 'rgba(255,200,0,0.1)'
                          : compound === 'hard'   ? 'rgba(220,220,220,0.08)'
                          : 'rgba(255,255,255,0.07)';
}

function _updateStartTyreLifeInfo() {
    const infoEl = document.getElementById('startTyreLifeInfo');
    if (!infoEl) return;

    const left  = window._startTyres?.left  || 'none';
    const right = window._startTyres?.right || 'none';

    const evRefuel      = parseFloat(document.getElementById('evRefuelPerStint')?.value) || 100;
    const evPerLap      = parseFloat(document.getElementById('evPerLap')?.value) || 8;
    const toursParStint = evRefuel / evPerLap;

    const parts = [];

    ['left', 'right'].forEach(side => {
        const compound = side === 'left' ? left : right;
        if (compound === 'none') return;

        const wear     = getSideWear(side, compound, 0);
        const maxLaps  = wear > 0 ? getTyreMaxLaps(wear) : 0;
        const stints   = maxLaps > 0 ? maxLaps / toursParStint : 0;
        const label    = side === 'left' ? '🔵 G' : '🟠 D';
        const color    = compound === 'soft' ? '#ff6060' : compound === 'medium' ? '#ffcc00' : '#dddddd';
        const compLbl  = compound.charAt(0).toUpperCase() + compound.slice(1);

        if (maxLaps > 0) {
            parts.push(`<span style="color:${color};">${label} ${compLbl} : ${maxLaps.toFixed(1)}t (${stints.toFixed(1)} stints)</span>`);
        } else {
            parts.push(`<span style="color:#888;">${label} ${compLbl} : durée inconnue</span>`);
        }
    });

    infoEl.innerHTML = parts.length > 0
        ? parts.join(' &nbsp;·&nbsp; ')
        : '<span style="color:#555;">— Sélectionnez une gomme —</span>';
}

