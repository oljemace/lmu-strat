function importLmuXmlTelemetry(fileList) { /* conservé pour compat, non utilisé directement */ }

function onLmuFilesSelected(fileList) {
    const info      = document.getElementById('lmuTelemetryInfo');
    const nameSpan  = document.getElementById('lmuTelemetryFileName');
    const tableWrap = document.getElementById('lmuImportTableWrap');

    const files = Array.from(fileList || []);
    if (!files.length) { info.textContent = '⚠️ Aucun fichier sélectionné.'; info.style.color = '#ffaa00'; return; }

    if (nameSpan) {
        nameSpan.textContent = files.length === 1
            ? `📄 ${files[0].name}`
            : `📄 ${files.length} fichiers sélectionnés`;
    }
    info.textContent = `🔄 Lecture de ${files.length} fichier(s)…`;
    info.style.color = '#ffaa00';
    tableWrap.innerHTML = '';

    const readOne = f => new Promise(resolve => {
        const reader = new FileReader();
        reader.onerror = () => resolve({ name: f.name, error: true });
        reader.onload  = () => resolve({ name: f.name, raw: reader.result });
        reader.readAsText(f);
    });

    Promise.all(files.map(readOne)).then(results => _buildLmuImportTable(results, info, tableWrap));
}

/* Parse un contenu XML isolé et retourne, pour CHAQUE pilote/voiture présent dans le
   fichier (une séance multijoueur peut en contenir plusieurs), ses données de tours :
   usure pneus par gomme, temps au tour, consommation d'énergie virtuelle (VE). */
function _extractLmuXmlData(raw) {
    let xmlDoc;
    try {
        xmlDoc = new DOMParser().parseFromString(raw, 'text/xml');
        if (xmlDoc.getElementsByTagName('parsererror').length) return null;
    } catch (e) {
        return null;
    }

    const CORNERS   = ['FL', 'FR', 'RL', 'RR'];
    const WEAR_ATTR = { FL: 'twfl', FR: 'twfr', RL: 'twrl', RR: 'twrr' };
    const COMPOUND_MAP = {
        soft: 'soft', medium: 'medium', hard: 'hard', wet: 'wet',
        inter: 'wet', intermediate: 'wet', rain: 'wet'
    };

    const trackVenue = (xmlDoc.getElementsByTagName('TrackVenue')[0]?.textContent || '').trim();
    const driverNodes = Array.from(xmlDoc.getElementsByTagName('Driver'));

    const drivers = driverNodes.map(d => {
        const name     = (d.getElementsByTagName('Name')[0]?.textContent || '').trim() || '(pilote inconnu)';
        const carType  = (d.getElementsByTagName('CarType')[0]?.textContent || '').trim();
        const vehName  = (d.getElementsByTagName('VehName')[0]?.textContent || '').trim();
        const category = (d.getElementsByTagName('Category')[0]?.textContent || '').trim();

        const lapNodes = Array.from(d.getElementsByTagName('Lap'));
        const laps = lapNodes.map(node => {
            const rec = { num: parseInt(node.getAttribute('num')) || 0 };
            CORNERS.forEach(c => {
                rec['wear_' + c] = parseFloat(node.getAttribute(WEAR_ATTR[c]));
                const rawCmp = node.getAttribute(c) || '';           // ex: "1,Medium"
                const parts  = rawCmp.split(',');
                const cname  = (parts[1] || parts[0] || '').trim().toLowerCase();
                rec['cmp_' + c] = COMPOUND_MAP[cname] || null;
            });
            const lapTimeTxt = (node.textContent || '').trim();
            rec.lapTime = /^[\d.]+$/.test(lapTimeTxt) ? parseFloat(lapTimeTxt) : NaN;
            rec.veUsed  = parseFloat(node.getAttribute('veUsed'));
            return rec;
        }).sort((a, b) => a.num - b.num);

        let lapTimeSum = 0, lapTimeCount = 0, veSum = 0, veCount = 0;
        laps.forEach(l => {
            if (!isNaN(l.lapTime) && l.lapTime > 0) { lapTimeSum += l.lapTime; lapTimeCount++; }
            if (!isNaN(l.veUsed) && l.veUsed > 0 && l.veUsed < 0.15) { veSum += l.veUsed; veCount++; }
        });

        const sums = {}, counts = {};
        const wearLaps = laps.filter(r => CORNERS.every(c => !isNaN(r['wear_' + c])));
        for (let i = 1; i < wearLaps.length; i++) {
            CORNERS.forEach(corner => {
                const prev = wearLaps[i - 1]['wear_' + corner];
                const cur  = wearLaps[i]['wear_' + corner];
                const diff = (prev - cur) * 100;
                const compound = wearLaps[i]['cmp_' + corner];
                if (!compound || diff <= 0 || diff >= 10) return;
                sums[compound]   = sums[compound]   || {};
                counts[compound] = counts[compound] || {};
                sums[compound][corner]   = (sums[compound][corner]   || 0) + diff;
                counts[compound][corner] = (counts[compound][corner] || 0) + 1;
            });
        }

        return { name, carType, vehName, category, lapTimeSum, lapTimeCount, veSum, veCount, sums, counts };
    }).filter(d => d.lapTimeCount > 0 || d.veCount > 0 || Object.keys(d.sums).length > 0);

    return { trackVenue, drivers };
}

/* Fusionne les pilotes/voitures de plusieurs fichiers (même pilote+voiture sur
   plusieurs fichiers = données cumulées), regroupe par voiture puis par pilote,
   et affiche le tableau à double entrée. */
function _buildLmuImportTable(results, info, tableWrap) {
    let trackVenue = '';
    const skipped = [];
    let usedFiles = 0;

    // clé voiture → clé pilote → données cumulées
    const byCar = {};

    results.forEach(r => {
        if (!r || r.error || !r.raw || !r.raw.trim()) { skipped.push(r?.name || '?'); return; }
        const data = _extractLmuXmlData(r.raw);
        if (!data) { skipped.push(r.name); return; }
        usedFiles++;
        if (!trackVenue && data.trackVenue) trackVenue = data.trackVenue;

        data.drivers.forEach(drv => {
            const carKey = (drv.carType || drv.vehName || 'Voiture inconnue').trim();
            byCar[carKey] = byCar[carKey] || {};
            const existing = byCar[carKey][drv.name];
            if (!existing) {
                byCar[carKey][drv.name] = {
                    carType: drv.carType, vehName: drv.vehName, category: drv.category,
                    lapTimeSum: drv.lapTimeSum, lapTimeCount: drv.lapTimeCount,
                    veSum: drv.veSum, veCount: drv.veCount,
                    sums: drv.sums, counts: drv.counts
                };
            } else {
                existing.lapTimeSum += drv.lapTimeSum; existing.lapTimeCount += drv.lapTimeCount;
                existing.veSum      += drv.veSum;      existing.veCount      += drv.veCount;
                Object.entries(drv.sums).forEach(([compound, cs]) => {
                    existing.sums[compound]   = existing.sums[compound]   || {};
                    existing.counts[compound] = existing.counts[compound] || {};
                    Object.entries(cs).forEach(([corner, v]) => {
                        existing.sums[compound][corner]   = (existing.sums[compound][corner]   || 0) + v;
                        existing.counts[compound][corner] = (existing.counts[compound][corner] || 0) + drv.counts[compound][corner];
                    });
                });
            }
        });
    });

    if (usedFiles === 0) {
        info.textContent = `🔴 Aucun fichier exploitable (XML invalide ou illisible) parmi les ${results.length} sélectionné(s).`;
        info.style.color = '#ff4444';
        return;
    }

    const carKeys = Object.keys(byCar);
    if (carKeys.length === 0) {
        info.textContent = '⚠️ Aucune donnée de pilote/voiture exploitable trouvée dans ces fichiers.';
        info.style.color = '#ffaa00';
        return;
    }

    window._lmuImportData = { trackVenue, byCar };   // conservé pour l'import au clic

    info.textContent = `✅ ${usedFiles} fichier(s) lu(s)${skipped.length ? ` · ${skipped.length} ignoré(s)` : ''}` +
        `${trackVenue ? ` — circuit "${trackVenue}"` : ''}. Cliquez sur une colonne pilote pour importer ses données.`;
    info.style.color = '#88ccff';

    _renderLmuImportTable(tableWrap);
}

/* Construit le tableau HTML : une ligne-groupe par voiture (sous-lignes
   Temps/EV puis S/M/H/W), une colonne par pilote ayant roulé sur cette voiture. */
function _renderLmuImportTable(tableWrap) {
    const { byCar } = window._lmuImportData || { byCar: {} };
    const carKeys = Object.keys(byCar).sort((a, b) => a.localeCompare(b));
    if (carKeys.length === 0) { tableWrap.innerHTML = ''; return; }

    const COMPOUND_ROWS = [
        { key: 'soft',   label: '🔴 S', color: '#ff6060' },
        { key: 'medium', label: '🟡 M', color: '#ffcc00' },
        { key: 'hard',   label: '⚪ H', color: '#dddddd' },
        { key: 'wet',    label: '🔵 W', color: '#3399ff' },
    ];
    const CORNERS = ['FL', 'FR', 'RL', 'RR'];

    const th = `background:#0d1a2e;color:#00ff88;font-size:0.8em;padding:6px 10px;
        white-space:nowrap;border-bottom:2px solid rgba(0,255,136,0.3);text-align:center;`;

    let html = `<table style="border-collapse:separate;border-spacing:0;width:100%;min-width:600px;">`;

    carKeys.forEach(carKey => {
        const drivers = Object.entries(byCar[carKey]).sort((a, b) => a[0].localeCompare(b[0]));
        const carLabel = LMU_HYPERCARS.find(c => c.label.toLowerCase() === carKey.toLowerCase())?.label || carKey;

        html += `<thead><tr>
            <th style="${th}position:sticky;left:0;z-index:2;">🏎️ Voiture</th>
            <th style="${th}position:sticky;left:120px;z-index:2;">Gomme</th>`;
        drivers.forEach(([name]) => {
            html += `<th style="${th}min-width:110px;">${name}</th>`;
        });
        html += `</tr></thead><tbody>`;

        // ── Ligne Temps au tour / VE ──
        html += `<tr style="background:rgba(255,255,255,0.03);">
            <td rowspan="5" style="position:sticky;left:0;z-index:1;background:#0d1a2e;
                color:#fff;font-weight:bold;font-size:0.82em;padding:8px 10px;vertical-align:middle;
                min-width:120px;white-space:nowrap;">${carLabel}</td>
            <td style="position:sticky;left:120px;z-index:1;background:#0d1a2e;
                color:#aaa;font-size:0.78em;padding:6px 10px;white-space:nowrap;">⏱ T.Tour<br>🔋 VE/t</td>`;
        drivers.forEach(([name, d]) => {
            const lapStr = d.lapTimeCount > 0
                ? (() => { const t = d.lapTimeSum / d.lapTimeCount; const m = Math.floor(t / 60); const s = (t % 60).toFixed(1); return `${m}:${s.padStart(4, '0')}`; })()
                : '—';
            const veStr = d.veCount > 0 ? `${(d.veSum / d.veCount * 100).toFixed(2)}%/t` : '—';
            html += `<td style="text-align:center;padding:6px 8px;cursor:pointer;"
                title="Importer les données de ce pilote pour cette voiture"
                onclick="_importLmuDriverCar('${carKey.replace(/'/g, "\\'")}','${name.replace(/'/g, "\\'")}')">
                <div style="color:#fff;font-weight:bold;font-size:0.88em;">${lapStr}</div>
                <div style="color:#88ccff;font-size:0.75em;margin-top:2px;">${veStr}</div>
            </td>`;
        });
        html += `</tr>`;

        // ── Lignes S / M / H / W ──
        COMPOUND_ROWS.forEach(({ key, label, color }) => {
            html += `<tr style="background:rgba(255,255,255,0.03);">
                <td style="position:sticky;left:120px;z-index:1;background:#0d1a2e;
                    color:${color};font-size:0.78em;padding:5px 10px;font-weight:bold;white-space:nowrap;">
                    ${label} <span style="color:#555;font-size:0.75em;font-weight:normal;">%/tour</span>
                </td>`;
            drivers.forEach(([name, d]) => {
                const counts = d.counts[key];
                if (!counts || CORNERS.every(c => !counts[c])) {
                    html += `<td style="text-align:center;color:#2a2a2a;font-size:0.78em;padding:5px 8px;">—</td>`;
                } else {
                    const vals = CORNERS.map(c => counts[c] ? (d.sums[key][c] / counts[c]) : null).filter(v => v !== null);
                    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
                    html += `<td style="text-align:center;padding:5px 8px;cursor:pointer;"
                        title="Importer les données de ce pilote pour cette voiture"
                        onclick="_importLmuDriverCar('${carKey.replace(/'/g, "\\'")}','${name.replace(/'/g, "\\'")}')">
                        <div style="color:#fff;font-size:0.82em;font-weight:bold;">${avg.toFixed(2)}%/t</div>
                    </td>`;
                }
            });
            html += `</tr>`;
        });

        html += `</tbody>`;
    });

    html += `</table>`;
    tableWrap.innerHTML = html;
}

/* Importe les données d'un couple (voiture, pilote) choisi dans le tableau
   vers l'éditeur de circuit (circuit détecté, voiture reconnue, temps au
   tour, VE/tour et usure des 4 gommes). */
function _importLmuDriverCar(carKey, driverName) {
    const store = window._lmuImportData;
    const info  = document.getElementById('lmuTelemetryInfo');
    if (!store || !store.byCar[carKey] || !store.byCar[carKey][driverName]) return;
    const d = store.byCar[carKey][driverName];
    const CORNERS = ['FL', 'FR', 'RL', 'RR'];

    // ── Circuit : existant du même nom, sinon nouveau ──
    let matchedCircuitId = null;
    if (store.trackVenue) {
        matchedCircuitId = Object.entries(_circuits).find(
            ([, c]) => (c.name || '').trim().toLowerCase() === store.trackVenue.toLowerCase()
        )?.[0] || null;
    }
    editCircuit(matchedCircuitId || '');
    const circSelect = document.getElementById('circuitEditSelect');
    if (circSelect) circSelect.value = matchedCircuitId || '';
    if (store.trackVenue) document.getElementById('circuitNameInput').value = store.trackVenue;

    // ── Voiture ──
    const haystack = `${d.carType || ''} ${d.vehName || ''} ${d.category || ''}`.toLowerCase();
    const matchedCar = LMU_HYPERCARS.find(car => haystack.includes(car.label.toLowerCase()))
        || LMU_HYPERCARS.find(car => haystack.includes(car.label.replace(/\s*\(.*?\)\s*/g, '').toLowerCase().trim()));
    if (matchedCar) {
        const carSelect = document.getElementById('circCarSelect');
        if (carSelect) { carSelect.value = matchedCar.id; onCircCarChange(); }
    }

    // ── Temps au tour moyen ──
    if (d.lapTimeCount > 0) {
        const avg = d.lapTimeSum / d.lapTimeCount;
        document.getElementById('circLapMin').value = Math.floor(avg / 60);
        document.getElementById('circLapSec').value = Math.floor(avg % 60);
        document.getElementById('circLapMil').value = Math.round((avg - Math.floor(avg)) * 10);
    }

    // ── VE/tour moyenne ──
    if (d.veCount > 0) {
        document.getElementById('circEvPerLap').value = (d.veSum / d.veCount * 100).toFixed(2);
    }

    // ── Usure pneus par gomme/coin ──
    const tyreSummary = [];
    Object.keys(d.sums).forEach(compound => {
        CORNERS.forEach(corner => {
            const n = d.counts[compound][corner];
            if (!n) return;
            const avg = d.sums[compound][corner] / n;
            const el  = document.getElementById(`circTyre_${corner}_${compound}`);
            if (el) { el.value = avg.toFixed(2); updateCircTyreWearUI(corner, compound, el.value); }
        });
        const label = TYRE_LABELS[compound] || compound;
        const vals  = CORNERS.map(c => d.counts[compound][c] ? `${c} ${(d.sums[compound][c] / d.counts[compound][c]).toFixed(2)}%` : null)
            .filter(Boolean).join(', ');
        tyreSummary.push(`${label} (${vals})`);
    });

    const parts = [`pilote "${driverName}"`];
    if (store.trackVenue) parts.push(`circuit "${store.trackVenue}"${matchedCircuitId ? ' (existant)' : ' (nouveau)'}`);
    parts.push(matchedCar ? `voiture ${matchedCar.label}` : 'voiture non reconnue — sélectionnez-la manuellement');
    if (d.lapTimeCount > 0) parts.push(`temps au tour moy. ${(d.lapTimeSum / d.lapTimeCount).toFixed(3)}s sur ${d.lapTimeCount} tours`);
    if (d.veCount > 0) parts.push(`VE ${(d.veSum / d.veCount * 100).toFixed(2)}%/tour`);
    if (tyreSummary.length) parts.push(`pneus : ${tyreSummary.join(' · ')}`);

    info.textContent = `✅ Importé — ${parts.join(' — ')}. Vérifiez les champs puis cliquez "Enregistrer le circuit".`;
    info.style.color = '#88ccff';
}

/* ════════════════════════════════════════════════════════════════
   IMPORT TÉLÉMÉTRIE MOTEC (.ld, format DAMPlugin)
   Parseur binaire du format .ld (reverse engineering repris du projet
   open-source gotzl/ldparser). Lu entièrement côté navigateur via
   FileReader.readAsArrayBuffer — aucune donnée n'est envoyée ailleurs.
   ════════════════════════════════════════════════════════════════ */

/* Lit une chaîne ASCII terminée par des zéros depuis un DataView. */
function _ldDecodeString(view, offset, len) {
    let bytes = [];
    for (let i = 0; i < len; i++) {
        const b = view.getUint8(offset + i);
        if (b === 0) break;
        bytes.push(b);
    }
    return String.fromCharCode(...bytes).trim();
}

/* Lit l'en-tête ldHead (format repris de ldparser.py: ldHead.fmt) et
   renvoie { metaPtr, dataPtr, eventPtr, driver, vehicleid, venue }. */
function _ldReadHead(view) {
    // offsets cumulés en octets, little-endian, cf. struct fmt Python :
    // "I4x II 20x I 24x HHH I 8s H H I 4x 16s16x 16s16x 64s64s64x 64s64x 1024x I66x 64s126x"
    let o = 0;
    o += 4 + 4;                    // ldmarker (I) + 4x
    const metaPtr = view.getUint32(o, true); o += 4;
    const dataPtr = view.getUint32(o, true); o += 4;
    o += 20;                       // ??
    const eventPtr = view.getUint32(o, true); o += 4;
    o += 24;                       // ??
    o += 2 + 2 + 2;                 // HHH unknown
    o += 4;                        // device serial (I)
    o += 8;                        // device type (8s)
    o += 2;                        // device version (H)
    o += 2;                        // unknown (H)
    o += 4;                        // num_channs (I) — non utilisé ici
    o += 4;                        // 4x
    o += 16 + 16;                  // date (16s) + 16x
    o += 16 + 16;                  // time (16s) + 16x
    const driver = _ldDecodeString(view, o, 64); o += 64;
    const vehicleid = _ldDecodeString(view, o, 64); o += 64;
    o += 64;                       // 64x
    const venue = _ldDecodeString(view, o, 64); o += 64;
    // le reste (event, short comment…) n'est pas nécessaire ici
    return { metaPtr, dataPtr, eventPtr, driver, vehicleid, venue };
}

/* Lit un bloc de métadonnées de canal (ldChan, 128 octets utiles + 40
   octets de bourrage = 132 octets total) à l'offset meta_ptr. */
function _ldReadChan(view, metaPtr) {
    let o = metaPtr;
    const prevPtr = view.getUint32(o, true); o += 4;
    const nextPtr = view.getUint32(o, true); o += 4;
    const dataPtr = view.getUint32(o, true); o += 4;
    const dataLen = view.getUint32(o, true); o += 4;
    o += 2;                        // counter (H)
    const dtypeA = view.getUint16(o, true); o += 2;
    const dtype  = view.getUint16(o, true); o += 2;
    const freq   = view.getUint16(o, true); o += 2;
    const shift  = view.getInt16(o, true); o += 2;
    const mul    = view.getInt16(o, true); o += 2;
    const scale  = view.getInt16(o, true); o += 2;
    const dec    = view.getInt16(o, true); o += 2;
    const name      = _ldDecodeString(view, o, 32); o += 32;
    const shortName = _ldDecodeString(view, o, 8);  o += 8;
    const unit      = _ldDecodeString(view, o, 12); o += 12;
    // 40x de bourrage ensuite (non lu)

    // résolution du type de données, cf. ldChan.fromfile en Python
    let bytesPerSample = null, readFn = null;
    if (dtypeA === 0x07) {
        if (dtype === 2) { bytesPerSample = 2; readFn = (v, p) => v.getFloat16 ? v.getFloat16(p, true) : _getFloat16(v, p); }
        else if (dtype === 4) { bytesPerSample = 4; readFn = (v, p) => v.getFloat32(p, true); }
    } else if (dtypeA === 0 || dtypeA === 0x03 || dtypeA === 0x05) {
        if (dtype === 2) { bytesPerSample = 2; readFn = (v, p) => v.getInt16(p, true); }
        else if (dtype === 4) { bytesPerSample = 4; readFn = (v, p) => v.getInt32(p, true); }
        else if (dtype === 1) { bytesPerSample = 1; readFn = (v, p) => v.getInt8(p); }
    } else if (dtypeA === 0x08 && dtype === 0x08) {
        bytesPerSample = 8; readFn = (v, p) => v.getFloat64(p, true);
    }

    return { prevPtr, nextPtr, dataPtr, dataLen, freq, shift, mul, scale, dec, name, shortName, unit, bytesPerSample, readFn };
}

/* Fallback simple pour float16 si getFloat16 natif absent (navigateurs anciens). */
function _getFloat16(view, offset) {
    const h = view.getUint16(offset, true);
    const s = (h & 0x8000) ? -1 : 1;
    const e = (h >> 10) & 0x1f;
    const f = h & 0x3ff;
    if (e === 0) return s * 6.103515625e-5 * (f / 1024);
    if (e === 31) return f ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

/* Lit les données brutes d'un canal et applique la formule de mise à
   l'échelle MoTeC : (raw/scale * 10^(-dec) + shift) * mul. */
function _ldReadChanData(view, chan) {
    if (!chan.bytesPerSample || !chan.readFn) return null;
    const out = new Float64Array(chan.dataLen);
    const f = Math.pow(10, -chan.dec);
    for (let i = 0; i < chan.dataLen; i++) {
        const raw = chan.readFn(view, chan.dataPtr + i * chan.bytesPerSample);
        out[i] = (raw / chan.scale * f + chan.shift) * chan.mul;
    }
    return out;
}

/* Parse un fichier .ld complet (ArrayBuffer) et renvoie
   { head, channels: {name: {freq, data, unit}} } pour les canaux
   utiles à l'analyse par tour. */
function _parseLdFile(buffer) {
    const view = new DataView(buffer);
    const head = _ldReadHead(view);
    const WANTED = new Set([
        'Lap Number', 'Session Elapsed Time', 'Fuel Level',
        'Tyre Wear FL', 'Tyre Wear FR', 'Tyre Wear RL', 'Tyre Wear RR'
    ]);
    const channels = {};
    let ptr = head.metaPtr, guard = 0;
    while (ptr && guard < 2000) {
        guard++;
        const chan = _ldReadChan(view, ptr);
        if (WANTED.has(chan.name)) {
            channels[chan.name] = { freq: chan.freq, data: _ldReadChanData(view, chan), unit: chan.unit };
        }
        ptr = chan.nextPtr;
    }
    return { head, channels };
}

/* À partir des canaux extraits, calcule les métriques tour par tour :
   temps au tour (s), consommation (L) et usure des 4 coins (%). Exclut
   le premier et le dernier tour (entrée/sortie stand, tour incomplet). */
function _computeLdLaps(parsed) {
    const ch = parsed.channels;
    const lapNumChan = ch['Lap Number'];
    const sessETChan = ch['Session Elapsed Time'];
    const fuelChan   = ch['Fuel Level'];
    const wearChans  = { FL: ch['Tyre Wear FL'], FR: ch['Tyre Wear FR'], RL: ch['Tyre Wear RL'], RR: ch['Tyre Wear RR'] };
    if (!lapNumChan || !lapNumChan.data) return null;

    const lapNum = lapNumChan.data;
    const lapFreq = lapNumChan.freq;

    // Résample le canal "Lap Number" (fréquence la plus haute, dixième
    // d'après les logs DAMPlugin) vers la fréquence d'un canal cible,
    // par indexation au plus proche — validé sur fichier réel.
    function lapAt(targetLen, targetFreq) {
        const ratio = lapFreq / targetFreq;
        const out = new Float64Array(targetLen);
        for (let i = 0; i < targetLen; i++) {
            let idx = Math.round(i * ratio);
            if (idx >= lapNum.length) idx = lapNum.length - 1;
            out[i] = lapNum[idx];
        }
        return out;
    }

    const maxLap = Math.max(...lapNum);
    const laps = [];
    for (let L = 1; L < maxLap; L++) { // exclut tour 0 (sortie stand) et dernier tour incomplet
        const lap = { num: L };

        // temps au tour via Session Elapsed Time (même fréquence que Lap Number)
        if (sessETChan && sessETChan.data) {
            const sessET = sessETChan.data;
            let firstThis = -1, firstNext = -1;
            for (let i = 0; i < lapNum.length; i++) {
                if (firstThis < 0 && lapNum[i] === L) firstThis = i;
                if (firstThis >= 0 && lapNum[i] === L + 1) { firstNext = i; break; }
            }
            if (firstThis >= 0 && firstNext >= 0) lap.lapTime = sessET[firstNext] - sessET[firstThis];
        }

        // consommation : delta de "Fuel Level" entre le début et la fin du tour
        if (fuelChan && fuelChan.data) {
            const lapAtFuel = lapAt(fuelChan.data.length, fuelChan.freq);
            const idxs = []; for (let i = 0; i < lapAtFuel.length; i++) if (lapAtFuel[i] === L) idxs.push(i);
            if (idxs.length >= 2) {
                lap.fuelStart = fuelChan.data[idxs[0]];
                lap.fuelEnd   = fuelChan.data[idxs[idxs.length - 1]];
                lap.fuelUsed  = lap.fuelStart - lap.fuelEnd;
            }
        }

        // usure : valeur cumulée en fin de tour moins valeur cumulée en fin de tour précédent
        let anyWear = false;
        const wearEnd = {};
        ['FL', 'FR', 'RL', 'RR'].forEach(corner => {
            const c = wearChans[corner];
            if (!c || !c.data) return;
            const lapAtWear = lapAt(c.data.length, c.freq);
            let lastIdxThis = -1, lastIdxPrev = -1;
            for (let i = 0; i < lapAtWear.length; i++) {
                if (lapAtWear[i] === L) lastIdxThis = i;
                if (lapAtWear[i] === L - 1) lastIdxPrev = i;
            }
            if (lastIdxThis >= 0) {
                wearEnd[corner] = c.data[lastIdxThis];
                if (lastIdxPrev >= 0) { lap[`wear_${corner}`] = c.data[lastIdxThis] - c.data[lastIdxPrev]; anyWear = true; }
            }
        });
        if (anyWear) lap.wearEnd = wearEnd;

        laps.push(lap);
    }
    return { laps, fuelStartOfFile: fuelChan && fuelChan.data ? fuelChan.data[0] : null };
}

/* Gère la sélection d'un ou plusieurs fichiers .ld. */
function onLmuLdFilesSelected(fileList) {
    const files = Array.from(fileList || []);
    const nameSpan = document.getElementById('lmuLdFileName');
    const info = document.getElementById('lmuLdInfo');
    const tableWrap = document.getElementById('lmuLdTableWrap');
    if (!files.length) return;
    nameSpan.textContent = files.map(f => f.name).join(', ');
    info.textContent = '⏳ Lecture des fichiers .ld…';
    info.style.color = '#88ffcc';

    const readOne = file => new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = e => {
            try {
                const parsed = _parseLdFile(e.target.result);
                const laps = _computeLdLaps(parsed);
                resolve({ fileName: file.name, head: parsed.head, laps });
            } catch (err) {
                resolve({ fileName: file.name, error: err.message });
            }
        };
        reader.onerror = () => resolve({ fileName: file.name, error: 'lecture impossible' });
        reader.readAsArrayBuffer(file);
    });

    Promise.all(files.map(readOne)).then(results => _buildLdImportTable(results, info, tableWrap));
}

/* Construit le tableau récapitulatif (un bloc par fichier importé) et
   stocke les données brutes dans window._ldImportData pour l'import. */
function _buildLdImportTable(results, info, tableWrap) {
    window._ldImportData = results;
    const okCount = results.filter(r => !r.error && r.laps && r.laps.laps.length).length;
    if (!okCount) {
        info.textContent = '❌ Aucune donnée de tour exploitable trouvée (canal "Lap Number" absent du fichier ?).';
        info.style.color = '#ff8888';
        tableWrap.innerHTML = '';
        return;
    }
    info.textContent = `✅ ${okCount} fichier(s) analysé(s). Choisissez les tours à moyenner puis importez.`;
    info.style.color = '#88ffcc';

    const COMPOUNDS = [['soft', '🔴 S'], ['medium', '🟡 M'], ['hard', '⚪ H'], ['wet', '🔵 W']];

    let html = '';
    results.forEach((r, fileIdx) => {
        if (r.error || !r.laps || !r.laps.laps.length) {
            html += `<div style="color:#ff8888;font-size:0.85em;margin:6px 0;">⚠️ ${r.fileName} : ${r.error || 'pas de tours exploitables'}</div>`;
            return;
        }
        html += `<div style="margin:10px 0;padding:8px 10px;background:rgba(255,255,255,0.04);border-radius:8px;">
            <div style="color:#fff;font-weight:bold;font-size:0.9em;margin-bottom:6px;">
                📄 ${r.fileName} ${r.head.venue ? `— 🏁 ${r.head.venue}` : ''} ${r.head.driver ? `— 👤 ${r.head.driver}` : ''}
            </div>
            <table style="width:100%;border-collapse:collapse;font-size:0.82em;">
                <thead><tr style="color:#88ffcc;">
                    <th style="text-align:left;padding:3px 6px;">Tour</th>
                    <th style="padding:3px 6px;">Temps</th>
                    <th style="padding:3px 6px;">Conso (L)</th>
                    <th style="padding:3px 6px;">Usure FL</th>
                    <th style="padding:3px 6px;">Usure FR</th>
                    <th style="padding:3px 6px;">Usure RL</th>
                    <th style="padding:3px 6px;">Usure RR</th>
                </tr></thead><tbody>`;
        r.laps.laps.forEach(lap => {
            const fmt = (v, d = 2) => (v === undefined || v === null || isNaN(v)) ? '—' : v.toFixed(d);
            html += `<tr style="color:#ccc;">
                <td style="padding:2px 6px;">${lap.num}</td>
                <td style="padding:2px 6px;text-align:center;">${lap.lapTime ? fmt(lap.lapTime, 3) + 's' : '—'}</td>
                <td style="padding:2px 6px;text-align:center;">${fmt(lap.fuelUsed)}</td>
                <td style="padding:2px 6px;text-align:center;">${fmt(lap.wear_FL, 3)}</td>
                <td style="padding:2px 6px;text-align:center;">${fmt(lap.wear_FR, 3)}</td>
                <td style="padding:2px 6px;text-align:center;">${fmt(lap.wear_RL, 3)}</td>
                <td style="padding:2px 6px;text-align:center;">${fmt(lap.wear_RR, 3)}</td>
            </tr>`;
        });
        html += `</tbody></table>
            <div style="display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap;">
                <label style="color:#88ffcc;font-size:0.82em;">Gomme utilisée :</label>
                <select id="ldCompoundSelect_${fileIdx}" style="padding:4px 8px;border-radius:6px;background:rgba(255,255,255,0.1);color:#fff;border:1px solid rgba(255,255,255,0.2);">
                    ${COMPOUNDS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}
                </select>
                <button class="btn-calculate" style="margin-top:0;padding:6px 14px;font-size:0.85em;"
                    onclick="_importLdFile(${fileIdx})">⬇️ Importer la moyenne de ce fichier</button>
            </div>
        </div>`;
    });
    tableWrap.innerHTML = html;
}

/* Importe la moyenne (tours milieu de relais, hors 1er/dernier) d'un
   fichier .ld analysé vers l'éditeur de circuit. */
function _importLdFile(fileIdx) {
    const r = window._ldImportData && window._ldImportData[fileIdx];
    const info = document.getElementById('lmuLdInfo');
    if (!r || !r.laps || !r.laps.laps.length) return;
    const compound = document.getElementById(`ldCompoundSelect_${fileIdx}`).value;
    const CORNERS = ['FL', 'FR', 'RL', 'RR'];
    const laps = r.laps.laps;

    // ── Circuit : existant du même nom (venue), sinon nouveau ──
    let matchedCircuitId = null;
    if (r.head.venue) {
        matchedCircuitId = Object.entries(_circuits).find(
            ([, c]) => (c.name || '').trim().toLowerCase() === r.head.venue.toLowerCase()
        )?.[0] || null;
    }
    editCircuit(matchedCircuitId || '');
    const circSelect = document.getElementById('circuitEditSelect');
    if (circSelect) circSelect.value = matchedCircuitId || '';
    if (r.head.venue) document.getElementById('circuitNameInput').value = r.head.venue;

    // ── Temps au tour moyen ──
    const lapTimes = laps.map(l => l.lapTime).filter(v => v !== undefined && !isNaN(v));
    if (lapTimes.length) {
        const avg = lapTimes.reduce((a, b) => a + b, 0) / lapTimes.length;
        document.getElementById('circLapMin').value = Math.floor(avg / 60);
        document.getElementById('circLapSec').value = Math.floor(avg % 60);
        document.getElementById('circLapMil').value = Math.round((avg - Math.floor(avg)) * 10);
    }

    // ── Consommation par tour, convertie en % du plein détecté en début de fichier ──
    const fuelUsed = laps.map(l => l.fuelUsed).filter(v => v !== undefined && !isNaN(v));
    let fuelPctPerLap = null;
    if (fuelUsed.length && r.laps.fuelStartOfFile) {
        const avgL = fuelUsed.reduce((a, b) => a + b, 0) / fuelUsed.length;
        fuelPctPerLap = avgL / r.laps.fuelStartOfFile * 100;
        document.getElementById('circEvPerLap').value = fuelPctPerLap.toFixed(2);
    }

    // ── Usure pneus par coin, pour la gomme sélectionnée ──
    const wearSummary = [];
    CORNERS.forEach(corner => {
        const vals = laps.map(l => l[`wear_${corner}`]).filter(v => v !== undefined && !isNaN(v));
        if (!vals.length) return;
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
        const el = document.getElementById(`circTyre_${corner}_${compound}`);
        if (el) { el.value = avg.toFixed(2); updateCircTyreWearUI(corner, compound, el.value); }
        wearSummary.push(`${corner} ${avg.toFixed(2)}%`);
    });

    const parts = [`fichier "${r.fileName}"`, `${laps.length} tours analysés (hors 1er/dernier)`];
    if (r.head.venue) parts.push(`circuit "${r.head.venue}"${matchedCircuitId ? ' (existant)' : ' (nouveau)'}`);
    parts.push('voiture non détectée (le fichier .ld ne contient pas le nom du véhicule) — sélectionnez-la manuellement');
    if (lapTimes.length) parts.push(`temps au tour moy. ${(lapTimes.reduce((a, b) => a + b, 0) / lapTimes.length).toFixed(3)}s`);
    if (fuelUsed.length) {
        const avgL = fuelUsed.reduce((a, b) => a + b, 0) / fuelUsed.length;
        parts.push(`conso ${avgL.toFixed(2)} L/tour${fuelPctPerLap !== null ? ` (≈ ${fuelPctPerLap.toFixed(2)}%/tour du plein détecté)` : ''}`);
    }
    if (wearSummary.length) parts.push(`usure ${TYRE_LABELS[compound] || compound} : ${wearSummary.join(', ')}`);

    info.textContent = `✅ Importé — ${parts.join(' — ')}. Vérifiez les champs puis cliquez "Enregistrer le circuit".`;
    info.style.color = '#88ffcc';
}

/* ════════════════════════════════════════════════════════════════
   IMPORT TÉLÉMÉTRIE JSON (shared memory LMU, via lmu_telemetry_logger.py)
   Format attendu : { track, car, driver, laps: [{num, lapTime,
   fuelUsed, wear:{FL,FR,RL,RR}, leftCompound, rightCompound}, ...] }
   (gomme séparée par CÔTÉ gauche/droit, pas par essieu avant/arrière —
   elle peut différer entre la gauche et la droite de la voiture)
   ════════════════════════════════════════════════════════════════ */

function onLmuJsonFilesSelected(fileList) {
    const files = Array.from(fileList || []);
    const nameSpan = document.getElementById('lmuJsonFileName');
    const info = document.getElementById('lmuJsonInfo');
    const tableWrap = document.getElementById('lmuJsonTableWrap');
    if (!files.length) return;
    nameSpan.textContent = files.map(f => f.name).join(', ');
    info.textContent = '⏳ Lecture des fichiers JSON…';
    info.style.color = '#ffd699';

    const readOne = file => new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = e => {
            try {
                const session = JSON.parse(e.target.result);
                if (!session || !Array.isArray(session.laps)) throw new Error('format JSON inattendu (clé "laps" manquante)');
                resolve({ fileName: file.name, session });
            } catch (err) {
                resolve({ fileName: file.name, error: err.message });
            }
        };
        reader.onerror = () => resolve({ fileName: file.name, error: 'lecture impossible' });
        reader.readAsText(file);
    });

    Promise.all(files.map(readOne)).then(results => _buildJsonImportTable(results, info, tableWrap));
}

function _buildJsonImportTable(results, info, tableWrap) {
    window._lmuJsonImportData = results;
    const okCount = results.filter(r => !r.error && r.session.laps.length).length;
    if (!okCount) {
        info.textContent = '❌ Aucun tour exploitable trouvé dans le(s) fichier(s) sélectionné(s).';
        info.style.color = '#ff8888';
        tableWrap.innerHTML = '';
        return;
    }
    info.textContent = `✅ ${okCount} fichier(s) analysé(s). Choisissez les tours à moyenner puis importez.`;
    info.style.color = '#ffd699';

    let html = '';
    results.forEach((r, fileIdx) => {
        if (r.error || !r.session.laps.length) {
            html += `<div style="color:#ff8888;font-size:0.85em;margin:6px 0;">⚠️ ${r.fileName} : ${r.error || 'pas de tours exploitables'}</div>`;
            return;
        }
        const s = r.session;
        html += `<div style="margin:10px 0;padding:8px 10px;background:rgba(255,255,255,0.04);border-radius:8px;">
            <div style="color:#fff;font-weight:bold;font-size:0.9em;margin-bottom:6px;">
                📄 ${r.fileName} ${s.track ? `— 🏁 ${s.track}` : ''} ${s.car ? `— 🏎️ ${s.car}` : ''} ${s.driver ? `— 👤 ${s.driver}` : ''}
            </div>
            <table style="width:100%;border-collapse:collapse;font-size:0.82em;">
                <thead><tr style="color:#ffd699;">
                    <th style="text-align:left;padding:3px 6px;">
                        <input type="checkbox" checked onclick="this.closest('table').querySelectorAll('.ld-lap-chk').forEach(c=>c.checked=this.checked)">
                    </th>
                    <th style="text-align:left;padding:3px 6px;">Tour</th>
                    <th style="text-align:left;padding:3px 6px;">Voiture</th>
                    <th style="padding:3px 6px;">Temps</th>
                    <th style="padding:3px 6px;">Conso (L)</th>
                    <th style="padding:3px 6px;">VE (%)</th>
                    <th style="padding:3px 6px;">Usure FL</th>
                    <th style="padding:3px 6px;">Usure FR</th>
                    <th style="padding:3px 6px;">Usure RL</th>
                    <th style="padding:3px 6px;">Usure RR</th>
                    <th style="padding:3px 6px;">Gommes</th>
                </tr></thead><tbody>`;
        s.laps.forEach((lap, lapIdx) => {
            const fmt = (v, d = 2) => (v === undefined || v === null || isNaN(v)) ? '—' : Number(v).toFixed(d);
            const w = lap.wear || {};
            html += `<tr style="color:#ccc;">
                <td style="padding:2px 6px;"><input type="checkbox" class="ld-lap-chk" id="jsonLapChk_${fileIdx}_${lapIdx}" checked></td>
                <td style="padding:2px 6px;">${lap.num}</td>
                <td style="padding:2px 6px;font-size:0.85em;color:${(lap.car || s.car) ? '#fff' : '#888'};">${lap.car || s.car || '—'}</td>
                <td style="padding:2px 6px;text-align:center;">${lap.lapTime ? fmt(lap.lapTime, 3) + 's' : '—'}</td>
                <td style="padding:2px 6px;text-align:center;">${fmt(lap.fuelUsed)}</td>
                <td style="padding:2px 6px;text-align:center;">${lap.vePctUsed !== undefined && lap.vePctUsed !== null ? fmt(lap.vePctUsed) + '%' : '—'}</td>
                <td style="padding:2px 6px;text-align:center;">${fmt(w.FL, 3)}</td>
                <td style="padding:2px 6px;text-align:center;">${fmt(w.FR, 3)}</td>
                <td style="padding:2px 6px;text-align:center;">${fmt(w.RL, 3)}</td>
                <td style="padding:2px 6px;text-align:center;">${fmt(w.RR, 3)}</td>
                <td style="padding:2px 6px;text-align:center;font-size:0.9em;color:#999;">${[lap.leftCompound, lap.rightCompound].filter(Boolean).join(' / ') || '—'}</td>
            </tr>`;
        });
        html += `</tbody></table>
            <div style="display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap;">
                <span style="color:#888;font-size:0.8em;">La gomme (soft/medium/hard/wet) de chaque coin est détectée automatiquement depuis la télémétrie (côté gauche/droit).</span>
                <button class="btn-calculate" style="margin-top:0;padding:6px 14px;font-size:0.85em;"
                    onclick="_importLmuJsonFile(${fileIdx})">⬇️ Importer la moyenne des tours cochés</button>
            </div>
        </div>`;
    });
    tableWrap.innerHTML = html;
}

function _importLmuJsonFile(fileIdx) {
    const r = window._lmuJsonImportData && window._lmuJsonImportData[fileIdx];
    const info = document.getElementById('lmuJsonInfo');
    if (!r || !r.session || !r.session.laps.length) return;
    const s = r.session;
    const CORNERS = ['FL', 'FR', 'RL', 'RR'];
    const CORNER_SIDE = {FL: 'left', FR: 'right', RL: 'left', RR: 'right'};

    const selectedLaps = s.laps.filter((lap, lapIdx) => {
        const chk = document.getElementById(`jsonLapChk_${fileIdx}_${lapIdx}`);
        return chk ? chk.checked : true;
    });
    if (!selectedLaps.length) { info.textContent = '⚠️ Aucun tour coché.'; info.style.color = '#ff8888'; return; }

    // ── Voiture des tours cochés : la calculatrice enregistre l'usure pour UNE
    //    seule voiture à la fois, donc si la sélection mélange 2 voitures
    //    différentes (session avec changement de voiture), on arrête et on
    //    demande de cocher les tours d'une seule voiture par import. ──
    const carsInSelection = [...new Set(selectedLaps.map(l => (l.car || s.car || '').trim()).filter(Boolean))];
    if (carsInSelection.length > 1) {
        info.textContent = `⚠️ La sélection mélange ${carsInSelection.length} voitures différentes (${carsInSelection.join(', ')}). `
            + `Décochez les tours d'une des voitures (colonne "Voiture") et importez-les séparément, une voiture à la fois.`;
        info.style.color = '#ff8888';
        return;
    }
    const selectionCar = carsInSelection[0] || s.car || null;

    // ── Circuit : existant du même nom, sinon nouveau ──
    let matchedCircuitId = null;
    if (s.track) {
        matchedCircuitId = Object.entries(_circuits).find(
            ([, c]) => (c.name || '').trim().toLowerCase() === s.track.toLowerCase()
        )?.[0] || null;
    }
    editCircuit(matchedCircuitId || '');
    const circSelect = document.getElementById('circuitEditSelect');
    if (circSelect) circSelect.value = matchedCircuitId || '';
    if (s.track) document.getElementById('circuitNameInput').value = s.track;

    // ── Voiture : déterminée à partir des tours COCHÉS (et non plus de la
    //    voiture globale du fichier), pour bien enregistrer l'usure sous la
    //    voiture réellement utilisée sur ces tours-là. ──
    let matchedCar = null;
    if (selectionCar) {
        const haystack = selectionCar.toLowerCase();
        matchedCar = LMU_HYPERCARS.find(car => haystack.includes(car.label.toLowerCase()))
            || LMU_HYPERCARS.find(car => haystack.includes(car.label.replace(/\s*\(.*?\)\s*/g, '').toLowerCase().trim()));
        if (matchedCar) {
            const carSelect = document.getElementById('circCarSelect');
            if (carSelect) { carSelect.value = matchedCar.id; onCircCarChange(); }
        }
    }

    // ── Temps au tour moyen ──
    const lapTimes = selectedLaps.map(l => l.lapTime).filter(v => v !== undefined && v !== null && !isNaN(v));
    if (lapTimes.length) {
        const avg = lapTimes.reduce((a, b) => a + b, 0) / lapTimes.length;
        document.getElementById('circLapMin').value = Math.floor(avg / 60);
        document.getElementById('circLapSec').value = Math.floor(avg % 60);
        document.getElementById('circLapMil').value = Math.round((avg - Math.floor(avg)) * 10);
    }

    // ── Consommation par tour : on privilégie vePctUsed (champ natif Energie
    //    Virtuelle du jeu, exact), puis fuelPctUsed (conso/capacité réservoir,
    //    approximation), puis les litres bruts en dernier recours. ──
    const fuelUsed = selectedLaps.map(l => l.fuelUsed).filter(v => v !== undefined && v !== null && !isNaN(v));
    const fuelPctUsed = selectedLaps.map(l => l.fuelPctUsed).filter(v => v !== undefined && v !== null && !isNaN(v));
    const vePctUsed = selectedLaps.map(l => l.vePctUsed).filter(v => v !== undefined && v !== null && !isNaN(v));
    let fuelPctPerLap = null, usedPctField = false, usedVeField = false;
    if (vePctUsed.length) {
        fuelPctPerLap = vePctUsed.reduce((a, b) => a + b, 0) / vePctUsed.length;
        document.getElementById('circEvPerLap').value = fuelPctPerLap.toFixed(2);
        usedVeField = true;
    } else if (fuelPctUsed.length) {
        fuelPctPerLap = fuelPctUsed.reduce((a, b) => a + b, 0) / fuelPctUsed.length;
        document.getElementById('circEvPerLap').value = fuelPctPerLap.toFixed(2);
        usedPctField = true;
    } else if (fuelUsed.length) {
        const avgL = fuelUsed.reduce((a, b) => a + b, 0) / fuelUsed.length;
        // Pas de capacité réservoir connue : on exprime la conso en L/tour tel quel
        // dans le champ "EV/tour" (ajustez-le manuellement en % si besoin).
        document.getElementById('circEvPerLap').value = avgL.toFixed(2);
    }

    // ── Gomme détectée automatiquement par côté (gauche/droit), depuis la
    //    télémétrie (leftCompound/rightCompound) — la valeur la plus fréquente
    //    parmi les tours cochés. Plus de sélection manuelle. ──
    function _mostCommonCompound(values) {
        const counts = {};
        values.forEach(v => { if (v) counts[v] = (counts[v] || 0) + 1; });
        let best = null, bestCount = 0;
        for (const [k, c] of Object.entries(counts)) {
            if (c > bestCount) { best = k; bestCount = c; }
        }
        return best;
    }
    const leftCompoundDetected = _mostCommonCompound(selectedLaps.map(l => l.leftCompound));
    const rightCompoundDetected = _mostCommonCompound(selectedLaps.map(l => l.rightCompound));
    const sideCompound = {left: leftCompoundDetected, right: rightCompoundDetected};

    // ── Usure pneus par coin, reportée dans le champ de la gomme détectée
    //    pour le côté de ce coin (FL/RL -> gauche, FR/RR -> droite). ──
    const wearSummary = [];
    const missingCompoundSides = new Set();
    CORNERS.forEach(corner => {
        const vals = selectedLaps.map(l => l.wear && l.wear[corner]).filter(v => v !== undefined && v !== null && !isNaN(v));
        if (!vals.length) return;
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
        const side = CORNER_SIDE[corner];
        const compound = sideCompound[side];
        if (!compound) { missingCompoundSides.add(side); return; }
        const el = document.getElementById(`circTyre_${corner}_${compound}`);
        if (el) { el.value = avg.toFixed(2); updateCircTyreWearUI(corner, compound, el.value); }
        wearSummary.push(`${corner} (${compound}) ${avg.toFixed(2)}%`);
    });

    const parts = [`fichier "${r.fileName}"`, `${selectedLaps.length}/${s.laps.length} tours cochés`];
    if (s.driver) parts.push(`pilote "${s.driver}"`);
    if (s.track) parts.push(`circuit "${s.track}"${matchedCircuitId ? ' (existant)' : ' (nouveau)'}`);
    parts.push(matchedCar ? `voiture ${matchedCar.label}` : (selectionCar ? `voiture "${selectionCar}" non reconnue — sélectionnez-la manuellement` : 'voiture non précisée — sélectionnez-la manuellement'));
    if (lapTimes.length) parts.push(`temps au tour moy. ${(lapTimes.reduce((a, b) => a + b, 0) / lapTimes.length).toFixed(3)}s`);
    if (usedVeField) {
        parts.push(`Energie Virtuelle ${fuelPctPerLap.toFixed(2)}%/tour (champ natif du jeu)${fuelUsed.length ? ` — conso carburant associée ${(fuelUsed.reduce((a, b) => a + b, 0) / fuelUsed.length).toFixed(2)} L/tour` : ''}`);
    } else if (fuelUsed.length) {
        const avgL = fuelUsed.reduce((a, b) => a + b, 0) / fuelUsed.length;
        parts.push(usedPctField
            ? `conso ${avgL.toFixed(2)} L/tour (≈ ${fuelPctPerLap.toFixed(2)}%/tour, approximation basée sur la capacité réservoir)`
            : `conso ${avgL.toFixed(2)} L/tour (champ "EV/tour" rempli en L — capacité réservoir inconnue dans ce fichier, ajustez manuellement si besoin)`);
    }
    if (wearSummary.length) parts.push(`usure : ${wearSummary.join(', ')}`);
    if (missingCompoundSides.size) {
        parts.push(`⚠️ gomme non détectée côté ${[...missingCompoundSides].join('/')} — usure de ce côté non reportée`);
    }

    info.textContent = `✅ Importé — ${parts.join(' — ')}. Vérifiez les champs puis cliquez "Enregistrer le circuit".`;
    info.style.color = '#ffd699';
}

