            /* ── Normalise deux secondes pour comparaison cross-midnight ──
        Retourne refSec ramené dans la même "fenêtre" de 86400s que baseSec */
        function normalizeToWindow(baseSec, refSec) {
            // Si baseSec dépasse 86400 (course passant minuit),
            // on veut que nowSec soit comparable.
            // On ajoute 86400 à refSec si celui-ci est "avant" le départ
            // (ex: nowSec = 2h = 7200, realStart = 18h30 → nowSec est le lendemain)
            if (baseSec > 86400) return refSec; // baseSec est déjà dans l'espace étendu
            if (refSec < baseSec - 43200) return refSec + 86400; // passage minuit
            return refSec;
        }

        /* ── Colonnes redimensionnables ── */
function initColumnResizers(isLive) {
    // Les deux tables (planification + live) existent toutes les deux dans le DOM ;
    // on ne câble les resizers QUE sur celle qui vient d'être (re)générée. isLive
    // est capturé par l'appelant avant le requestAnimationFrame (voir calculate.js).
    const table = document.getElementById(_tid('strategyTableBody', isLive))?.closest('.strategy-table');
    if (!table) return;

    // Supprimer les anciens resizers pour éviter les doublons
    table.querySelectorAll('.col-resizer').forEach(r => r.remove());

    const ths = table.querySelectorAll('thead th');

    ths.forEach((th, i) => {
        // Ne pas ajouter de resizer sur la dernière colonne
        if (i === ths.length - 1) return;

        // Fixer la largeur actuelle en px pour qu'elle soit manipulable
        if (!th.style.width) {
            th.style.width = th.offsetWidth + 'px';
        }
        th.style.overflow  = 'hidden';
        th.style.whiteSpace = 'nowrap';

        const resizer = document.createElement('div');
        resizer.className = 'col-resizer';
        th.appendChild(resizer);

        let startX    = 0;
        let startW    = 0;
        let isResizing = false;

        resizer.addEventListener('mousedown', e => {
            e.preventDefault();
            isResizing = true;
            startX     = e.clientX;
            startW     = th.offsetWidth;
            resizer.classList.add('resizing');

            const onMove = e => {
                if (!isResizing) return;
                const delta = e.clientX - startX;
                const newW  = Math.max(30, startW + delta);
                th.style.width = newW + 'px';

                // Appliquer aussi à toutes les <td> de cette colonne
                const colIdx = Array.from(th.parentElement.children).indexOf(th);
                table.querySelectorAll(`tbody tr td:nth-child(${colIdx + 1})`).forEach(td => {
                    td.style.width    = newW + 'px';
                    td.style.maxWidth = newW + 'px';
                    td.style.overflow = 'hidden';
                });
            };

            const onUp = () => {
                isResizing = false;
                resizer.classList.remove('resizing');
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup',  onUp);
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup',   onUp);
        });

        // Support tactile
        resizer.addEventListener('touchstart', e => {
            const touch = e.touches[0];
            startX = touch.clientX;
            startW = th.offsetWidth;
            resizer.classList.add('resizing');

            const onMove = e => {
                const t   = e.touches[0];
                const delta = t.clientX - startX;
                const newW  = Math.max(30, startW + delta);
                th.style.width = newW + 'px';
                const colIdx = Array.from(th.parentElement.children).indexOf(th);
                table.querySelectorAll(`tbody tr td:nth-child(${colIdx + 1})`).forEach(td => {
                    td.style.width    = newW + 'px';
                    td.style.maxWidth = newW + 'px';
                    td.style.overflow = 'hidden';
                });
            };

            const onEnd = () => {
                resizer.classList.remove('resizing');
                document.removeEventListener('touchmove', onMove);
                document.removeEventListener('touchend',  onEnd);
            };

            document.addEventListener('touchmove', onMove);
            document.addEventListener('touchend',  onEnd);
        }, { passive: true });
    });

    // Fixer table-layout pour que les largeurs soient respectées
    table.style.tableLayout = 'fixed';
    table.style.width = 'max-content';
}

/* ── Timeline ── */

/* Récapitulatif informel des temps de roulage par pilote (planification uniquement).
   Temps au volant = tours du stint × temps au tour ; les arrêts aux stands ne comptent pas. */
function renderDriverDrivingRecap(stints, lapTime) {
    const box = document.getElementById('timelineDriverRecap');
    if (!box) return;
    const perDriver = new Map();   // index pilote (-1 = non assigné) -> {sec, laps, stints}
    stints.forEach((stint, idx) => {
        const d = (pitState[idx] || defaultState()).driver ?? -1;
        const e = perDriver.get(d) || { sec: 0, laps: 0, stints: 0 };
        e.sec += stint.tours * lapTime;
        e.laps += stint.tours;
        e.stints += 1;
        perDriver.set(d, e);
    });
    const total = [...perDriver.values()].reduce((a, e) => a + e.sec, 0);
    if (!(total > 0)) { box.innerHTML = ''; return; }
    const fmt = s => `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
    const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    const keys = [...perDriver.keys()].sort((a, b) => (a === -1) - (b === -1) || a - b);
    const rows = keys.map(d => {
        const e = perDriver.get(d);
        const color = d >= 0 ? getDriverColor(d) : '#666';
        const name = d >= 0 ? getDriverName(d) : 'Non assigné';
        return `<tr><td style="padding:1px 6px 1px 0;white-space:nowrap;"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${color};margin-right:5px;"></span>${esc(name)}</td>`
            + `<td style="padding:1px 6px;text-align:right;color:#fff;font-weight:bold;">${fmt(e.sec)}</td>`
            + `<td style="padding:1px 6px;text-align:right;">${Math.round(e.sec / total * 100)}%</td>`
            + `<td style="padding:1px 0 1px 6px;text-align:right;white-space:nowrap;">${e.stints} stint${e.stints > 1 ? 's' : ''} · ${e.laps.toFixed(1)} t</td></tr>`;
    }).join('');
    box.innerHTML = `<div style="font-size:0.78em;color:#aaa;background:rgba(0,0,0,0.25);border-radius:8px;padding:6px 10px;">`
        + `<div style="color:#88ccff;font-weight:bold;margin-bottom:3px;">⏱️ Temps de roulage par pilote</div>`
        + `<table style="border-collapse:collapse;">${rows}</table></div>`;
}


function buildTimeline(stints, lapTime, multiplier, realStart, gameStart, totalRealSec) {

		// Capturé ici (synchrone, donc window._liveMode encore fiable) pour les
		// callbacks différés plus bas (voir _tid()).
		const _isLiveTL = window._liveMode;

		if (!_isLiveTL) renderDriverDrivingRecap(stints, lapTime);

		const track  = document.getElementById(_tid('timelineTrack'));
		const labels = document.getElementById(_tid('timelineLabels'));
		track.innerHTML = labels.innerHTML = '';

		/* ── nowSec déclaré ici pour être disponible partout dans la fonction ── */
		
            const _now   = new Date();
            let nowSec = _now.getHours() * 3600 + _now.getMinutes() * 60 + _now.getSeconds();
            // Si la course dépasse minuit et qu'on est après minuit → ajouter 86400
            if (realStart + totalRealSec > 86400 && nowSec < realStart) {
                nowSec += 86400;
            }

			const N = 8;
			const wrapper = document.createElement('div');
			wrapper.style.cssText = 'display:flex;flex-direction:column;gap:6px;width:100%;min-width:600px;';

        /* Axe réel */
		
			const realAxis = document.createElement('div');
			realAxis.style.cssText = 'position:relative;width:100%;height:48px;';
			const rTag = document.createElement('span');
			rTag.style.cssText = 'position:absolute;left:0;top:26px;font-size:0.75em;color:#aaa;font-weight:bold;z-index:2;background:rgba(0,0,0,0.4);padding:1px 4px;border-radius:3px;';
			rTag.textContent = '🕐 Réel';
			realAxis.appendChild(rTag);
			for (let i = 0; i <= N; i++) {
				const lbl = document.createElement('span');
				lbl.style.cssText = `position:absolute;left:${i/N*100}%;top:26px;transform:translateX(-50%);font-size:0.75em;color:#ccc;white-space:nowrap;`;
				lbl.textContent = formatClock(realStart + i / N * totalRealSec);
				realAxis.appendChild(lbl);
        }

        /* Barres stints */
		
        const stintRow = document.createElement('div');
        stintRow.style.cssText = 'position:relative;width:100%;height:50px;background:rgba(0,0,0,0.25);border-radius:8px;overflow:visible;';

        // ── En mode live, les stints générés commencent à nowSec.
        //    cum doit donc partir de (nowSec - realStart) pour que
        //    les barres soient positionnées correctement sur la timeline.
        let _liveNowSecTimeline = window._liveNowSec || 0;
        if (window._liveMode) {
            const _raceEndTL = realStart + totalRealSec;
            if (_raceEndTL > 86400 && _liveNowSecTimeline < realStart && _liveNowSecTimeline < 43200) {
                _liveNowSecTimeline += 86400;
            }
        }
        let cum = window._liveMode ? Math.max(0, _liveNowSecTimeline - realStart) : 0;

                /* Initiales du pilote : "Pilote 1" → "P1", "Jean Dupont" → "JD" */
        function getInitials(name) {
            const parts = name.trim().split(/\s+/);
            if (parts.length === 1) {
                const letter = parts[0][0].toUpperCase();
                const num    = parts[0].match(/\d+/);
                return num ? letter + num[0] : letter;
            }
            return parts.map(p => p[0].toUpperCase()).join('');
        }

stints.forEach((stint, idx) => {
    // Même logique : pit APRÈS ce stint (pas avant)
    const pitAfter = (idx < stints.length - 1) ? getPitDuration(idx) : 0;

    const dR = (window._liveMode && stint._past && stint._durReelle !== undefined)
        ? stint._durReelle
        : stint.tours * lapTime + pitAfter;

    const sp  = cum / totalRealSec * 100;
    const wp  = dR  / totalRealSec * 100;    
    
			const st     = pitState[idx] || defaultState();
			const hasStop = st.stop;
			const dIdx   = st.driver ?? -1;
			const dColor = dIdx >= 0 ? getDriverColor(dIdx) : COLORS[idx % COLORS.length][0];
			const c      = dIdx >= 0
				? [dColor, dColor + 'bb',
				   parseInt(dColor.slice(1,3),16)*0.299
				   + parseInt(dColor.slice(3,5),16)*0.587
				   + parseInt(dColor.slice(5,7),16)*0.114 > 128 ? '#000' : '#fff']
					: COLORS[idx % COLORS.length];

            const bar = document.createElement('div');
            bar.style.cssText = `position:absolute;left:${sp}%;width:calc(${wp}% - 3px);top:5px;height:40px;background:linear-gradient(135deg,${c[0]},${c[1]});border-radius:5px;display:flex;align-items:center;justify-content:center;color:${c[2]};font-weight:bold;font-size:0.8em;overflow:hidden;white-space:nowrap;border:1px solid rgba(255,255,255,0.25);cursor:pointer;transition:transform 0.2s,box-shadow 0.2s;z-index:1;`;



            const dName    = dIdx >= 0 ? getDriverName(dIdx) : '';
            const initials = dName ? getInitials(dName) : null;

            let label = '';
            if (wp > 1.5) {
                if (initials) {
                    label = initials;
                } else {
                    label = `S${idx + 1}`;
                }
            }
            bar.textContent = label;			
            
            const pitD = getPitDuration(idx);
            bar.title = `Stint ${idx+1} — ${stint.tours.toFixed(1)} tours${pitD > 0 ? ` | Pit: +${pitD}s` : ''}`;
            bar.onmouseenter = () => { bar.style.transform = 'scaleY(1.2)'; bar.style.boxShadow = `0 4px 16px ${c[0]}88`; };
            bar.onmouseleave = () => { bar.style.transform = 'scaleY(1)';   bar.style.boxShadow = 'none'; };
            stintRow.appendChild(bar);
			
            // ── Opacité passé/futur ──
            const stintAbsStart = realStart + cum;
            const stintAbsEnd   = stintAbsStart + dR;

            if (window._liveMode) {
                // Utiliser _liveNowSecTimeline déjà normalisé ci-dessus
                const liveNow = _liveNowSecTimeline || nowSec;
                if (stintAbsEnd <= liveNow) {
                    // Stint entièrement passé : bloc grisé uniforme
                    bar.style.background = 'rgba(120,120,120,0.25)';
                    bar.style.border     = '1px solid rgba(255,255,255,0.08)';
                    bar.style.color      = 'rgba(255,255,255,0.3)';
                    bar.textContent      = '';   // pas de label sur le passé
                } else if (stintAbsStart < liveNow) {
                    // Stint partiellement passé : partie gauche grisée, partie droite colorée
                    const doneFraction = (liveNow - stintAbsStart) / dR;
                    bar.style.background = `linear-gradient(to right,
                        rgba(120,120,120,0.25) 0%,
                        rgba(120,120,120,0.25) ${doneFraction * 100}%,
                        ${c[0]}               ${doneFraction * 100}%,
                        ${c[1]}               100%)`;
                }
                // Stints futurs → inchangés
            } else {
			
			// Mode normal : opacité 50% pour stints terminés
                if (nowSec >= stintAbsEnd) {
                    bar.style.opacity = '0.5';
                } else if (nowSec > stintAbsStart && nowSec < stintAbsEnd) {
                    const doneFraction = (nowSec - stintAbsStart) / dR;
                    bar.style.background = `linear-gradient(to right,
                        ${c[0]}80 0%,
                        ${c[0]}80 ${doneFraction * 100}%,
                        ${c[0]}   ${doneFraction * 100}%,
                        ${c[1]}   100%)`;
                }
            }
            /* Ligne pit stop */
            if (idx < stints.length - 1) {
                const pitColor = pitD > 0 ? '#ff6600' : '#ff4444';
                const pit = document.createElement('div');
                pit.style.cssText = `position:absolute;left:${sp + wp}%;top:0;width:3px;height:100%;background:${pitColor};border-radius:2px;z-index:2;cursor:pointer;`;
                pit.title = `Pit Stop après Stint ${idx+1}${pitD > 0 ? ` (+${pitD}s)` : ''}`;
                stintRow.appendChild(pit);
            }
            cum += dR;
        });

        /* Axe ingame */
        const gameAxis = document.createElement('div');
        gameAxis.style.cssText = 'position:relative;width:100%;height:28px;';
        const gTag = document.createElement('span');
        gTag.style.cssText = 'position:absolute;left:0;top:5px;font-size:0.75em;color:#88aaff;font-weight:bold;z-index:2;background:rgba(0,0,0,0.4);padding:1px 4px;border-radius:3px;';
        gTag.textContent = '🎮 Ingame';
        gameAxis.appendChild(gTag);
        for (let i = 0; i <= N; i++) {
            const lbl = document.createElement('span');
            lbl.style.cssText = `position:absolute;left:${i/N*100}%;top:5px;transform:translateX(-50%);font-size:0.75em;color:#88aaff;white-space:nowrap;`;
            lbl.textContent = formatClock(gameStart + i / N * totalRealSec * multiplier);
            gameAxis.appendChild(lbl);
        }



        wrapper.appendChild(realAxis);
        wrapper.appendChild(stintRow);
		
        /* ── Label "Prochain pilote" sous les barres ── */
        const nextDriverLabel = document.createElement('div');
        nextDriverLabel.style.cssText = 'position:relative;width:100%;height:22px;';

        const anyDriverAssigned = stints.some((_, i) => (pitState[i] || defaultState()).driver >= 0);

        if (anyDriverAssigned) {
        const nowDate2 = new Date();
        let nowSec2    = nowDate2.getHours() * 3600 + nowDate2.getMinutes() * 60 + nowDate2.getSeconds();
        if (realStart + totalRealSec > 86400 && nowSec2 < realStart) {
            nowSec2 += 86400;
        }
            // ── Offset de départ : en mode live les stints commencent à nowSec, pas à realStart
            const _liveNowNDL = (() => {
                if (!window._liveMode) return 0;
                let n = window._liveNowSec || 0;
                if (realStart + totalRealSec > 86400 && n < realStart && n < 43200) n += 86400;
                return Math.max(0, n - realStart);
            })();

            // 1. Trouver le pilote du stint en cours
            let currentDriverIdx = -1;
            let elapsedCur = _liveNowNDL;
            for (let i = 0; i < stints.length; i++) {
                const dur = (window._liveMode && stints[i]._past && stints[i]._durReelle !== undefined)
                    ? stints[i]._durReelle
                    : stints[i].tours * lapTime + (i < stints.length - 1 ? getPitDuration(i) : 0);
                const s = realStart + elapsedCur;
                const e = s + dur;
                if (nowSec2 >= s && nowSec2 < e) {
                    currentDriverIdx = (pitState[i] || defaultState()).driver;
                    break;
                }
                elapsedCur += dur;
            }

            // 2. Chercher le prochain stint avec un pilote DIFFÉRENT du pilote actuel
            let elapsedNext = _liveNowNDL;
            for (let i = 0; i < stints.length; i++) {
                const dur        = (window._liveMode && stints[i]._past && stints[i]._durReelle !== undefined)
                    ? stints[i]._durReelle
                    : stints[i].tours * lapTime + (i < stints.length - 1 ? getPitDuration(i) : 0);
                const stintStart = realStart + elapsedNext;

                if (stintStart > nowSec2) {
                    const ps         = pitState[i] || defaultState();
                    const thisDriver = ps.driver;

                    if (thisDriver >= 0 && thisDriver !== currentDriverIdx) {
                        const secsUntil  = stintStart - nowSec2;
                        const posRatioN  = (stintStart - realStart) / totalRealSec;
                        const driverName = getDriverName(thisDriver);
                        
                        const badge = document.createElement('div');
                        badge.style.cssText = `
                            position:absolute;
                            left:${Math.min(Math.max(posRatioN * 100, 0), 95)}%;
                            top:2px;
                            transform:translateX(-50%);
                            background:#fff;
                            color:#000;
                            font-size:0.65em;
                            font-weight:bold;
                            padding:2px 7px;
                            border-radius:4px;
                            white-space:nowrap;
                            z-index:5;
                            pointer-events:none;
                            box-shadow:0 2px 6px rgba(0,0,0,0.4);`;
                        const untilHH = String(Math.floor(secsUntil / 3600)).padStart(2, '0');
                        const untilMM = String(Math.floor((secsUntil % 3600) / 60)).padStart(2, '0');
                        badge.textContent = secsUntil > 0
                            ? `👤 ${driverName} dans ${untilHH}:${untilMM}`
                            : `👤 ${driverName} maintenant`;                        
                            nextDriverLabel.appendChild(badge);
                        break;
                    }
                }
                elapsedNext += dur;
            }        
		 
		
		}

        wrapper.appendChild(nextDriverLabel);
		  // Réappliquer le zoom après reconstruction
        requestAnimationFrame(() => applyTimelineZoom(_isLiveTL));

			/* ── Ligne "maintenant" ── */
				const raceEndSec = realStart + totalRealSec;
				const posRatio   = (nowSec - realStart) / totalRealSec;

				if (posRatio >= 0 && posRatio <= 1) {
				
            /* Ligne blanche verticale sur la barre des stints */
            const nowLine = document.createElement('div');
            nowLine.style.cssText = `
                position:absolute;left:${posRatio * 100}%;
                top:0;width:2px;height:100%;
                background:#ffffff;border-radius:2px;
                z-index:10;box-shadow:0 0 8px rgba(255,255,255,0.8);
                pointer-events:none;`;
            stintRow.appendChild(nowLine);

                        /* Badge flottant AU-DESSUS de l'axe réel */

            // Durée restante de course (secondes)
            const remainingSec  = raceEndSec - nowSec;
            const remainingMin  = Math.floor(remainingSec / 60);
            const remainingTours = remainingSec / lapTime;

            // Pilote en cours : on cherche le stint actif
            let currentDriver = '';
            let elapsed = 0;
            for (let i = 0; i < stints.length; i++) {
                const pitPrev  = (i === 0 || (window._liveMode && stints[i]._past)) ? 0 : getPitDuration(i - 1);
                const stintDur = (window._liveMode && stints[i]._past && stints[i]._durReelle !== undefined)
                    ? stints[i]._durReelle
                    : stints[i].tours * lapTime + pitPrev;
                const stintStart = realStart + elapsed;
                const stintEnd   = stintStart + stintDur;
                if (nowSec >= stintStart && nowSec < stintEnd) {
                    const ps = pitState[i] || defaultState();
                    if (ps.driver >= 0) currentDriver = getDriverName(ps.driver);
                    break;
                }
                elapsed += stintDur;
            }

            const nowBadge = document.createElement('div');
            nowBadge.style.cssText = `
                position:absolute;
                left:${posRatio * 100}%;
                top:2px;
                transform:translateX(-50%);
                background:#fff;
                color:#000;
                font-size:0.68em;
                font-weight:bold;
                padding:3px 8px;
                border-radius:5px;
                white-space:nowrap;
                z-index:10;
                pointer-events:none;
                box-shadow:0 2px 8px rgba(0,0,0,0.5);
                line-height:1.6;
                text-align:center;`;

            const line1 = `🕐 ${formatClock(nowSec)}`;
                       const remainingHH = String(Math.floor(remainingSec / 3600)).padStart(2, '0');
            const remainingMM = String(Math.floor((remainingSec % 3600) / 60)).padStart(2, '0');
            // Déduire les pits futurs du temps restant pour le calcul des tours
            let totalPitsFuturs = 0;
            for (let i = 0; i < stints.length - 1; i++) {
                const stintAbsStart = realStart + (() => {
                    let c = window._liveMode
                        ? Math.max(0, (_liveNowSecTimeline || nowSec) - realStart)
                        : 0;
                    for (let j = 0; j < i; j++) {
                        const pa = (j < stints.length - 1) ? getPitDuration(j) : 0;
                        c += stints[j].tours * lapTime + pa;
                    }
                    return c;
                })();
                if (stintAbsStart >= nowSec) {
                    totalPitsFuturs += getPitDuration(i);
                }
            }
            const remainingToursNet = Math.max(0, remainingSec - totalPitsFuturs) / lapTime;
            const line2 = `⏳ ${remainingHH}:${remainingMM} restantes · 🔢 ${remainingToursNet.toFixed(1)} tours`;
    

            const line3 = currentDriver ? `👤 ${currentDriver}` : '';

            nowBadge.innerHTML = `
                <div>${line1}</div>
                <div style="font-weight:normal;font-size:0.95em;">${line2}</div>
                ${line3 ? `<div style="color:#0066cc;">${line3}</div>` : ''}
            `;
            realAxis.appendChild(nowBadge);

        } else if (posRatio < 0) {
            /* Badge à GAUCHE de l'axe réel */
            const outBefore = document.createElement('div');
            outBefore.style.cssText = `
                position:absolute;
                left:0;top:2px;
                background:rgba(255,200,0,0.15);
                border:1px solid rgba(255,200,0,0.4);
                border-radius:5px;
                padding:2px 8px;
                font-size:0.7em;
                color:#ffcc00;
                font-weight:bold;
                white-space:nowrap;
                z-index:10;
                pointer-events:none;`;
            const minutesBefore = Math.round((realStart - nowSec) / 60);
            outBefore.textContent = `⏳ Course dans ${minutesBefore} min`;
            realAxis.appendChild(outBefore);

        } else {
            /* Badge à DROITE de l'axe réel */
            const outAfter = document.createElement('div');
            outAfter.style.cssText = `
                position:absolute;
                right:0;top:2px;
                background:rgba(255,100,100,0.15);
                border:1px solid rgba(255,100,100,0.4);
                border-radius:5px;
                padding:2px 8px;
                font-size:0.7em;
                color:#ff8888;
                font-weight:bold;
                white-space:nowrap;
                z-index:10;
                pointer-events:none;`;
            const minutesAfter = Math.round((nowSec - raceEndSec) / 60);
            outAfter.textContent = `🏁 Course terminée il y a ${minutesAfter} min`;
            realAxis.appendChild(outAfter);
        }

            /* ── Barres horizontales durée de vie pneus G / D ── */
            const tyreLifeRow = document.createElement('div');
            tyreLifeRow.style.cssText =
                'position:relative;width:100%;height:28px;display:flex;' +
                'flex-direction:column;gap:25px;padding:2px 0;';

            ['left', 'right'].forEach(side => {
                const sideLabel = side === 'left' ? '🔵 G' : '🟠 D';

                const lineWrap = document.createElement('div');
                lineWrap.style.cssText =
                    'position:relative;width:100%;height:10px;display:flex;align-items:center;';

                const lbl = document.createElement('span');
                lbl.style.cssText =
                    'position:absolute;left:0;top:50%;transform:translateY(-50%);' +
                    'font-size:0.62em;color:#aaa;font-weight:bold;z-index:2;' +
                    'background:rgba(0,0,0,0.4);padding:1px 4px;border-radius:3px;' +
                    'white-space:nowrap;pointer-events:none;';
                lbl.textContent = sideLabel;
                lineWrap.appendChild(lbl);

                const bgTrack = document.createElement('div');
                bgTrack.style.cssText =
                    'position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);' +
                    'height:5px;background:rgba(255,255,255,0.06);border-radius:3px;';
                lineWrap.appendChild(bgTrack);

                const toursParStintTL = (() => {
                    const evRefuel = parseFloat(
                        document.getElementById('evRefuelPerStint')?.value) || 100;
                    const evPerLap = parseFloat(
                        document.getElementById(_isLiveTL ? 'evPerLapReal' : 'evPerLap')?.value) || 8;
                    return evRefuel / evPerLap;
                })();

                const COMPOUND_COLORS = {
                    soft: '#ff6060', medium: '#ffcc00', hard: '#dddddd', wet: '#3399ff',
                };

                function addTyreSegment(compound, lifeAnchorSec, stintIdx, isCurrentLiveTyre = false) {
                    if (compound === 'none') return;

                    const wearPerLap =
                        (window._liveModeActive && isCurrentLiveTyre)
                            ? getSideWear(side, compound, 0)
                            : getSideWearTheoretical(side, compound);

                    const maxLaps =
                        wearPerLap > 0
                            ? getTyreMaxLaps(wearPerLap)
                            : 0;

                    const lifeDurSec = maxLaps * lapTime;

                    if (lifeDurSec <= 0 || lifeAnchorSec >= totalRealSec) return;

                    const color = COMPOUND_COLORS[compound] || '#aaa';

                    const startPct =
                        (lifeAnchorSec / totalRealSec) * 100;

                    const widthPct = Math.min(
                        (lifeDurSec / totalRealSec) * 100,
                        100 - startPct
                    );

                    const overrun = maxLaps < toursParStintTL;

                    const seg = document.createElement('div');

                    seg.style.cssText =
                        `position:absolute;left:${startPct}%;width:${widthPct}%;` +
                        `top:50%;transform:translateY(-50%);height:5px;` +
                        `background:${color};border-radius:3px;` +
                        `opacity:${overrun ? '0.55' : '0.85'};transition:opacity 0.2s;` +
                        (overrun ? 'animation:tyre-blink 0.9s infinite;' : '');

                    const liveLabel =
                        (window._liveModeActive && isCurrentLiveTyre)
                            ? ' · restant LIVE'
                            : '';

                    seg.title =
                        `${compound.charAt(0).toUpperCase() + compound.slice(1)} ` +
                        `${side === 'left' ? 'Gauche' : 'Droit'} — ` +
                        `${maxLaps.toFixed(1)} tours · ` +
                        `${(maxLaps / toursParStintTL).toFixed(1)} stints` +
                        liveLabel;

                    lineWrap.appendChild(seg);
                }

                // ── SEGMENT PNEUS DE DÉPART ──
                // Ancrés au début de la course (cumSec = 0 en mode normal,
                // ou nowSec en mode live pour le stint courant)
                const startCompoundTL = side === 'left'
                    ? (window._startTyres?.left  || 'none')
                    : (window._startTyres?.right || 'none');

                const _liveNowSecTL = (() => {
                    if (!window._liveMode) return 0;
                    let n = window._liveNowSec || 0;
                    if (realStart + totalRealSec > 86400 && n < realStart && n < 43200) n += 86400;
                    return Math.max(0, n - realStart);
                })();

                const startAnchorSec = window._liveMode ? _liveNowSecTL : 0;

                let currentCompoundTL = startCompoundTL;

                if (window._liveModeActive && window._liveTyreState) {
                    currentCompoundTL = side === 'left'
                        ? (window._liveTyreState.compoundLeft || 'none')
                        : (window._liveTyreState.compoundRight || 'none');
                }

                addTyreSegment(
                    currentCompoundTL,
                    startAnchorSec,
                    0,
                    window._liveModeActive
                );
                
                // ── SEGMENTS PNEUS CHANGÉS EN COURSE (pitState) ──
                // Les pneus du pit du stint i roulent à partir du stint i+1 (ancre = cumSec + dR)
                let cumSec = window._liveMode ? _liveNowSecTL : 0;

                stints.forEach((stint, idx) => {
                    const pitAfter = (idx < stints.length - 1) ? getPitDuration(idx) : 0;
                    const dR = (window._liveMode && stint._past && stint._durReelle !== undefined)
                        ? stint._durReelle
                        : stint.tours * lapTime + pitAfter;

                    const st       = pitState[idx] || defaultState();
                    const compound = side === 'left'
                        ? (st.tyreLeft  || 'none')
                        : (st.tyreRight || 'none');

                    // Ancrage : toujours cumSec + dR (après le pit stop de fin de stint)
                      // idx===0 n'est plus une exception : les pneus de départ sont au PASS 0
                    if (compound !== 'none' && st.stop) {
                        const lifeAnchorSec = cumSec + dR;
                        addTyreSegment(compound, lifeAnchorSec, idx);
                    }

                    cumSec += dR;
                });

                tyreLifeRow.appendChild(lineWrap);
            });

            wrapper.appendChild(tyreLifeRow);
            // ← gameAxis est ajouté juste après dans le code existant

        wrapper.appendChild(gameAxis);

        track.style.cssText = 'display:block;width:100%;height:auto;background:transparent;';
        track.appendChild(wrapper);

    }

    /* ── Reset ── */
    function reset() {
        pitState = {};
        document.getElementById('realStartHours').value   = '18';
        document.getElementById('realStartMinutes').value = '30';
        document.getElementById('gameStartHours').value   = '18';
        document.getElementById('gameStartMinutes').value = '30';
        document.getElementById('timeMultiplier').value   = '1';
        document.getElementById('raceHours').value        = '12';
        document.getElementById('raceMinutes').value      = '0';
        document.getElementById('lapMinutes').value       = '3';
        document.getElementById('lapSeconds').value       = '35';
        document.getElementById('lapMillis').value        = '0';
        document.getElementById('evRemaining').value      = '100';
        document.getElementById('evPerLap').value         = '8';
        document.getElementById('evRefuelPerStint').value = '100';
        if (document.getElementById('refuelRate'))
            document.getElementById('refuelRate').value  = '0.4';
		const ydEl = document.getElementById('realStartYesterday');
		if (ydEl) ydEl.checked = false;

        ['toursRemaining','stintsRemaining','calcStintLaps','calcStintTime']    
        .forEach(id => document.getElementById(id).textContent = '-');
        document.getElementById('toursRemainingDetail').textContent  = '';
        document.getElementById('stintsRemainingDetail').textContent = '';
        document.getElementById('strategyTableBody').innerHTML       = '';
        document.getElementById('timelineTrack').innerHTML           = '';
        document.getElementById('timelineLabels').innerHTML          = '';
        if (document.getElementById('tyreBudget'))
        document.getElementById('tyreBudget').value = '6';
        
        // Remettre à zéro les stints manuels
        window._manualStintCount = 0;
        _updateManualStintUI();
        const cb = document.getElementById('coherenceBox');
        if (cb) cb.style.display = 'none';

        // Remettre à zéro les pneus de départ
        window._startTyres = { left: 'none', right: 'none' };
        const stlReset = document.getElementById('startTyreLeft');
        const strReset = document.getElementById('startTyreRight');
        if (stlReset) { stlReset.value = 'none'; _applyStartTyreSelectStyle('startTyreLeft', 'none'); }
        if (strReset) { strReset.value = 'none'; _applyStartTyreSelectStyle('startTyreRight', 'none'); }
        const stInfoReset = document.getElementById('startTyreLifeInfo');
        if (stInfoReset) stInfoReset.innerHTML = '';

        // Remettre à zéro les pneus
        TYRE_CORNERS.forEach(corner => {            
            TYRE_COMPOUNDS.forEach(compound => {
                const el = document.getElementById(`tyre_${corner}_${compound}`);
                if (el) el.value = 0;
                updateTyreWearUI(corner, compound, 0);
            });
        });

    }

