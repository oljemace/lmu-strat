/* ══════════════════════════════════════════════
   GESTION DES ONGLETS
   ══════════════════════════════════════════════ */
function switchTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach(p =>
        p.classList.toggle('active', p.id === `tab-${tab}`));
    if (tab !== 'strategy') {
        if (tab === 'circuits') {
            renderCircuitTyreGrid();
            refreshCircuitSelects();   // ← remplit le menu à chaque ouverture de l'onglet
        } else if (tab === 'pace' && typeof renderPaceTab === 'function') {
            renderPaceTab();
        } else if (tab === 'faq') {
            loadFaq();
        }
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

// Onglet FAQ : on reprend le contenu de faq.html (page publique, seule source du texte)
// sans le bouton « Ouvrir la calculette », inutile ici.
let _faqLoaded = false;
async function loadFaq() {
    if (_faqLoaded) return;
    const box = document.getElementById('faqContent');
    if (!box) return;
    try {
        const res = await fetch('faq.html', { cache: 'no-cache' });
        if (!res.ok) throw new Error(res.status);
        const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
        const main = doc.querySelector('main');
        if (!main) throw new Error('contenu introuvable');
        main.querySelectorAll('a[href="index.html"]').forEach(a => a.remove());
        main.querySelectorAll('a[href^="http"]').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
        box.innerHTML = main.innerHTML;
        _faqLoaded = true;
    } catch (e) {
        box.innerHTML = '<p class="faq-loading">FAQ indisponible pour le moment. '
            + '<a href="faq.html" target="_blank" rel="noopener">L\'ouvrir dans une nouvelle page</a>.</p>';
    }
}

// La colonne d'onglets démarre sous la barre de session, dont la hauteur varie
// (retour à la ligne sur écran étroit).
(function () {
    function placeNav() {
        const bar = document.getElementById('sessionBar');
        if (bar) document.documentElement.style.setProperty('--nav-top', bar.offsetHeight + 'px');
    }
    function init() {
        placeNav();
        const bar = document.getElementById('sessionBar');
        if (bar && window.ResizeObserver) new ResizeObserver(placeNav).observe(bar);
        window.addEventListener('resize', placeNav);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();

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
