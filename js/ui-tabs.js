/* ══════════════════════════════════════════════
   GESTION DES ONGLETS
   ══════════════════════════════════════════════ */
function switchTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach(p =>
        p.classList.toggle('active', p.id === `tab-${tab}`));
    if (tab === 'circuits') {
        renderCircuitTyreGrid();
        refreshCircuitSelects();   // ← remplit le menu à chaque ouverture de l'onglet
        // Masquer le contenu stratégie (switcher planification/live + sections)
        const switcher = document.getElementById('calcModeSwitcher');
        if (switcher) switcher.style.display = 'none';
        document.getElementById('planningModeSection')?.style.setProperty('display', 'none');
        document.getElementById('liveModeSection')?.style.setProperty('display', 'none');
    } else {
        const switcher = document.getElementById('calcModeSwitcher');
        if (switcher) switcher.style.display = 'flex';
        // Réafficher le panneau planification/live qui était actif avant de
        // quitter l'onglet Stratégie (pas systématiquement les deux : chaque
        // mode a sa propre table de stints, voir switchCalcMode()).
        switchCalcMode(window._calcMode || 'planning');
    }
}

/* ══════════════════════════════════════════════
   BASCULE PLANIFICATION / LIVE
   Deux panneaux, deux tables de stints indépendantes (voir calculate.js,
   _tid()). Un seul des deux est visible à la fois.
   ══════════════════════════════════════════════ */
window._calcMode = 'planning';

function switchCalcMode(mode) {
    window._calcMode = mode;

    const planning = document.getElementById('planningModeSection');
    const live     = document.getElementById('liveModeSection');
    if (planning) planning.style.display = mode === 'planning' ? '' : 'none';
    if (live)     live.style.display     = mode === 'live'     ? '' : 'none';

    document.querySelectorAll('.calc-mode-card').forEach(card => {
        const active = card.dataset.mode === mode;
        card.classList.toggle('active', active);
        card.style.background  = active ? 'rgba(var(--accent-rgb),0.08)' : 'rgba(var(--fg-rgb),0.03)';
        card.style.borderColor = active ? 'var(--accent)' : 'rgba(var(--fg-rgb),0.12)';
        // 2e enfant de la carte (le bloc texte) -> son 1er enfant (le titre)
        const titleEl = card.children[1]?.children[0];
        if (titleEl) titleEl.style.color = active ? 'var(--accent)' : 'var(--text-2)';
    });
}
