/* ── Zoom timeline ──
   Deux timelines distinctes (planification / live) : isLive sélectionne
   explicitement la bonne (voir _tid() dans strategy-state.js). Les boutons
   de zoom de chaque panneau passent leur propre valeur, et applyTimelineZoom()
   appelé en différé depuis buildTimeline() reçoit l'état capturé au bon
   moment (voir timeline.js). */
function applyTimelineZoom(isLive) {
    const zoom  = parseFloat(document.getElementById(_tid('timelineZoom', isLive)).value) || 1;
    const label = document.getElementById(_tid('timelineZoomLabel', isLive));
    if (label) label.textContent = `x${zoom}`;

    // Le wrapper intérieur est le premier enfant de timelineTrack
    const track   = document.getElementById(_tid('timelineTrack', isLive));
    const wrapper = track?.firstElementChild;
    if (wrapper) {
        wrapper.style.width    = `${zoom * 100}%`;
        wrapper.style.minWidth = `${zoom * 600}px`;
    }

    // Le zoom ne concerne que la timeline : la table des stints garde sa largeur normale.
    const tbody = document.getElementById(_tid('strategyTableBody', isLive));
    const table = tbody?.closest('.strategy-table');
    if (table) { table.style.width = 'max-content'; table.style.minWidth = '1100px'; }
}

function adjustTimelineZoom(delta, isLive) {
    const slider = document.getElementById(_tid('timelineZoom', isLive));
    if (!slider) return;
    let v = parseFloat(slider.value) + delta;
    v = Math.min(Math.max(v, parseFloat(slider.min)), parseFloat(slider.max));
    slider.value = v;
    applyTimelineZoom(isLive);
}

function resetTimelineZoom(isLive) {
    const slider = document.getElementById(_tid('timelineZoom', isLive));
    if (slider) { slider.value = 1; applyTimelineZoom(isLive); }
}
