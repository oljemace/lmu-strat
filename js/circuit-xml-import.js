/* ══════════════════════════════════════════════
   BASE CIRCUITS — mise à jour depuis les XML de résultats LMU
   On ne lit que les sessions les plus récentes du tracé et de la voiture choisis qui contiennent
   l'usure des pneus ou l'énergie virtuelle (sessions hors ligne, ou serveurs qui les rendent visibles).
   L'utilisateur coche les voitures/sessions qui comptent ; les moyennes (temps au tour, EV par tour,
   usure des 4 pneus par gomme) remplissent l'éditeur, qu'il enregistre ensuite comme d'habitude.
   Règles : tours aux stands, sans temps
   ou plus lents que 110 % du meilleur écartés ; EV du jeu, sinon carburant.
   Réutilise js/pace-analysis.js et js/driver-history.js (chargés avant).
   ══════════════════════════════════════════════ */

const CXI_SLOW_LAP_RATIO = 1.10;
const CXI_CORNERS = ['FL', 'FR', 'RL', 'RR'];
const CXI_COMPOUNDS = ['soft', 'medium', 'hard', 'wet'];   // gommes de l'éditeur (pas d'intermédiaire)
const CXI_COUNTS = [5, 10, 20, 50];
const CXI_HEAD_BYTES = 4096;   // l'en-tête (circuit, date) tient dans les premiers octets du fichier

/* Nom de voiture du jeu → id de LMU_HYPERCARS (les noms du XML diffèrent : « Toyota TR010 », « Peugeot 9x8 »…). */
const CXI_CAR_PATTERNS = [
    ['toyota_gr010', /toyota.*(gr|tr)010/], ['ferrari_499p', /499p/], ['peugeot_9x8_2024', /9x8/],
    ['aston_valkyrie', /valkyrie/], ['glickenhaus_007', /glickenhaus|scg007/], ['isotta_tipo6', /isotta|tipo6/],
    ['vanwall_680', /vanwall/], ['porsche_963', /963/], ['cadillac_vseriesr', /cadillac/],
    ['bmw_mhybridv8', /bmwmhybrid/], ['alpine_a424', /a424/], ['lamborghini_sc63', /sc63/], ['genesis_gmr001', /genesis|gmr001/],
];
/* Noms de circuits de la base (« Le Mans », « COTA (Austin) »…) ↔ lieux du jeu. */
const CXI_TRACK_TAGS = [
    [/le ?mans|sarthe/, 'lemans'], [/spa/, 'spa'], [/cota|austin|americas/, 'cota'], [/barcel|catalu/, 'barcelona'],
    [/daytona/, 'daytona'], [/laguna/, 'laguna'], [/monza/, 'monza'], [/sebring/, 'sebring'], [/imola|enzo e dino/, 'imola'],
    [/interlagos|jose carlos pace|sao paulo/, 'interlagos'], [/portim|algarve/, 'portimao'], [/qatar|lusail/, 'qatar'],
    [/bahrain|sakhir/, 'bahrain'], [/fuji/, 'fuji'], [/silverstone/, 'silverstone'], [/ricard|castellet/, 'ricard'],
    [/atlanta/, 'atlanta'], [/long beach/, 'longbeach'],
];

const _cxi = {
    files: [],              // File[] du plus récent au plus ancien
    heads: new Map(),       // nom de fichier → { venue, course, ts }
    parsed: new Map(),      // nom de fichier → sessions lues (cache)
    handle: null,           // dossier choisi (File System Access), pour « Relire le dossier »
    course: '',
    car: '',
    count: 10,
    checked: new Map(),     // clé d'entrée → coché
    sessions: [],           // sessions affichées : [{ ..., rows: [entrée] }]
    busy: false,
    run: 0,
    status: '',
    scanned: 0,             // fichiers du tracé lus pour la dernière recherche
};

/* ── Petits utilitaires ── */
function cxiNorm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
function cxiMatchCar(type, cls) {
    if (cls && !/hyper/i.test(cls)) return null;
    const n = cxiNorm(type).replace(/[^a-z0-9]/g, '');
    return CXI_CAR_PATTERNS.find(([, re]) => re.test(n))?.[0] || null;
}
function cxiTrackTag(s) {
    const n = cxiNorm(s);
    return CXI_TRACK_TAGS.find(([re]) => re.test(n))?.[1] || n.replace(/[^a-z0-9]/g, '');
}
function cxiCarLabel(id) { return LMU_HYPERCARS.find(c => c.id === id)?.label || id; }
function cxiMean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function cxiFmtDateTime(ts) {
    const d = new Date(ts * 1000);
    return `${histFmtDate(ts)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function cxiFileTs(f) { return histTsFromName(f.name) || Math.round((f.lastModified || 0) / 1000); }

/* ── Dossier mémorisé (IndexedDB) ── */
function cxiKv(mode, fn) {
    return new Promise((resolve, reject) => {
        if (!window.indexedDB) { resolve(null); return; }
        const req = indexedDB.open('lmuCircImport', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
            const tx = req.result.transaction('kv', mode);
            const r = fn(tx.objectStore('kv'));
            tx.oncomplete = () => resolve(r && 'result' in r ? r.result : null);
            tx.onerror = () => reject(tx.error);
        };
    });
}

/* ══════════ LECTURE DES XML ══════════ */

/** Statistiques d'une voiture dans une session : tours retenus, temps, EV, usure par pneu et par gomme. */
function cxiEntryStats(laps) {
    const byNum = new Map(laps.map(l => [l.num, l]));
    const timed = laps.filter(l => !l.pit && l.time > 0);
    if (!timed.length) return null;
    const best = Math.min(...timed.map(l => l.time));
    const kept = timed.filter(l => l.time <= best * CXI_SLOW_LAP_RATIO);
    let ve = kept.map(l => l.ve * 100).filter(v => v > 0 && v < 30), veSrc = 'EV';
    if (!ve.length) { ve = kept.map(l => l.fuel * 100).filter(v => v > 0 && v < 30); veSrc = 'carburant'; }
    const wear = {};
    let wearLaps = 0;
    for (const l of kept) {
        const prev = byNum.get(l.num - 1);
        if (!prev || prev.pit || !l.tw || !prev.tw) continue;
        const delta = {};
        let ok = true;
        for (const c of CXI_CORNERS) {
            delta[c] = (prev.tw[c] - l.tw[c]) * 100;
            if (!Number.isFinite(delta[c]) || delta[c] < -0.05 || delta[c] > 15) ok = false;   // pneus changés / valeur aberrante
        }
        if (!ok) continue;
        let used = false;
        for (const c of CXI_CORNERS) {
            const comp = l.cmp[c];
            if (!CXI_COMPOUNDS.includes(comp) || comp !== prev.cmp[c]) continue;
            ((wear[c] ||= {})[comp] ||= []).push(Math.max(0, delta[c]));
            used = true;
        }
        if (used) wearLaps++;
    }
    return { kept: kept.length, total: laps.length, best, times: kept.map(l => l.time), ve, veSrc, wear, wearLaps };
}

/** XML → sessions : [{ key, file, ts, venue, course, setting, type, entries: [voiture Hypercar pilotée par un humain] }]. */
function cxiParseXml(text, fileName) {
    const end = text.lastIndexOf('</rFactorXML>');
    if (end >= 0) text = text.slice(0, end + '</rFactorXML>'.length);
    const doc = new DOMParser().parseFromString(text.replace(/<!DOCTYPE[\s\S]*?\]>/, ''), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('XML illisible');
    const rr = doc.getElementsByTagName('RaceResults')[0];
    if (!rr) throw new Error('pas un fichier de résultats LMU');
    const own = (el, tag) => Array.from(el.children).find(c => c.tagName === tag)?.textContent?.trim() || '';
    const venue = own(rr, 'TrackVenue') || own(rr, 'TrackCourse') || 'Circuit inconnu';
    const course = own(rr, 'TrackCourse') || venue;
    const setting = own(rr, 'Setting');
    const rootTs = histInt(own(rr, 'DateTime')) || histTsFromName(fileName);
    const out = [];
    for (const sess of Array.from(rr.children)) {
        const drivers = Array.from(sess.children).filter(c => c.tagName === 'Driver');
        if (!drivers.length) continue;
        const tag = sess.tagName;
        const type = /^Practice/i.test(tag) ? 'P' : /^Qual/i.test(tag) ? 'Q' : /^Race/i.test(tag) ? 'R' : /^Warm/i.test(tag) ? 'W' : '';
        const ts = histInt(own(sess, 'DateTime')) || rootTs;
        const key = `${ts}|${course}|${tag}`;
        const changes = paceDriverChanges(sess);
        const entries = [];
        for (const d of drivers) {
            const get = t => own(d, t);
            if (get('isPlayer') === '0') continue;   // IA
            const carType = get('CarType') || get('VehName');
            const carId = cxiMatchCar(carType, get('CarClass'));
            if (!carId) continue;
            const name = get('Name');
            const kids = Array.from(d.children);
            const atWheel = paceDriverAtWheel(changes, get('VehName'), name);
            const swaps = kids.filter(c => c.tagName === 'Swap').map(s => ({
                start: histInt(s.getAttribute('startLap')), end: histInt(s.getAttribute('endLap')), name: s.textContent.trim(),
            }));
            const who = new Set();
            const laps = [];
            for (const l of kids) {
                if (l.tagName !== 'Lap') continue;
                const a = n => l.getAttribute(n);
                const num = histInt(a('num'));
                const et = paceNum(a('et'));
                const swap = swaps.find(s => num >= s.start && num <= s.end);
                let drv = (atWheel && et != null && atWheel(et)) || swap?.name || name;
                if (!histNormName(drv) || /^\?+$/.test(drv.trim())) drv = name;
                who.add(histNormName(drv));
                const side = n => paceCompoundKey((a(n) || '').split(',')[1]);
                laps.push({
                    num, time: paceNum(l.textContent), pit: a('pit') === '1',
                    ve: paceNum(a('veUsed')), fuel: paceNum(a('fuelUsed')),
                    tw: a('twfl') != null ? { FL: paceNum(a('twfl')), FR: paceNum(a('twfr')), RL: paceNum(a('twrl')), RR: paceNum(a('twrr')) } : null,
                    cmp: {
                        FL: side('FL') || side('fcompound'), FR: side('FR') || side('fcompound'),
                        RL: side('RL') || side('rcompound'), RR: side('RR') || side('rcompound'),
                    },
                });
            }
            const stats = cxiEntryStats(laps);
            if (!stats) continue;
            entries.push({
                key: `${key}|${get('CarNumber')}|${get('TeamName')}|${carType}`,
                carId, carType, team: get('TeamName'), num: get('CarNumber'), drivers: Array.from(who), stats,
            });
        }
        out.push({ key, file: fileName, ts, venue, course, setting, type, entries });
    }
    return out;
}

/** En-tête seul (circuit, date) : lu sur les premiers octets, sans analyser tout le fichier. */
async function cxiReadHead(f) {
    const head = await f.slice(0, CXI_HEAD_BYTES).text();
    const tag = t => (head.match(new RegExp(`<${t}>([^<]*)</${t}>`)) || [])[1]?.trim() || '';
    const venue = tag('TrackVenue') || tag('TrackCourse');
    return { venue, course: tag('TrackCourse') || venue, ts: histInt(tag('DateTime')) || cxiFileTs(f) };
}

/* ══════════ SOURCE DES FICHIERS ══════════ */

async function cxiPickFolder() {
    if (window.showDirectoryPicker) {
        try {
            const handle = await window.showDirectoryPicker({ id: 'lmuResults', mode: 'read' });
            _cxi.handle = handle;
            cxiKv('readwrite', s => s.put(handle, 'dir')).catch(() => {});
            await cxiLoadFromHandle(handle);
            return;
        } catch (err) {
            if (err?.name === 'AbortError') return;   // fenêtre fermée
            // Navigateur qui refuse l'accès direct au dossier : sélection classique.
        }
    }
    document.getElementById('cxiDirInput')?.click();
}

async function cxiRescan() {
    const h = _cxi.handle;
    if (!h) { cxiPickFolder(); return; }
    try {
        if ((await h.queryPermission?.({ mode: 'read' })) !== 'granted'
            && (await h.requestPermission?.({ mode: 'read' })) !== 'granted') {
            cxiSetStatus('Accès au dossier refusé : choisis-le à nouveau.');
            return;
        }
        await cxiLoadFromHandle(h);
    } catch (err) {
        cxiSetStatus('Dossier illisible (' + (err?.message || err) + ') : choisis-le à nouveau.');
    }
}

async function cxiLoadFromHandle(handle) {
    const files = [];
    for await (const entry of handle.values()) {
        if (entry.kind === 'file' && /\.xml$/i.test(entry.name)) files.push(await entry.getFile());
    }
    await cxiSetFiles(files, handle.name);
}

async function cxiSetFiles(fileList, label) {
    const files = Array.from(fileList || []).filter(f => /\.xml$/i.test(f.name));
    if (!files.length) { cxiSetStatus('Aucun fichier XML trouvé.'); return; }
    // Un fichier relu après modification remplace l'ancienne lecture.
    for (const f of files) {
        const old = _cxi.files.find(x => x.name === f.name);
        if (old && (old.size !== f.size || old.lastModified !== f.lastModified)) { _cxi.parsed.delete(f.name); _cxi.heads.delete(f.name); }
    }
    _cxi.files = files.sort((a, b) => cxiFileTs(b) - cxiFileTs(a));
    cxiSetStatus(`Lecture des en-têtes (${files.length} fichiers)…`);
    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (!_cxi.heads.has(f.name)) {
            try { _cxi.heads.set(f.name, await cxiReadHead(f)); } catch (e) { /* fichier illisible : ignoré */ }
        }
    }
    _cxi.course = cxiDefaultCourse();
    if (!_cxi.car) _cxi.car = document.getElementById('circCarSelect')?.value || '';
    _cxi.status = `${files.length} fichiers${label ? ' dans « ' + label + ' »' : ''}.`;
    document.getElementById('cxiRescanBtn')?.toggleAttribute('hidden', !_cxi.handle);
    await cxiRefresh();
}

/** Tracé proposé : celui qui correspond au circuit de l'éditeur, sinon celui de la session la plus récente. */
function cxiDefaultCourse() {
    const courses = new Map();   // tracé → { venue, last : date de la session la plus récente }
    _cxi.files.forEach(f => {
        const h = _cxi.heads.get(f.name);
        if (!h?.course) return;
        const c = courses.get(h.course);
        if (!c) courses.set(h.course, { venue: h.venue, last: h.ts });
        else c.last = Math.max(c.last, h.ts);
    });
    const name = document.getElementById('circuitNameInput')?.value || '';
    if (name.trim()) {
        const want = cxiTrackTag(name);
        const endu = /endurance/i.test(name);
        // Plusieurs tracés pour un même lieu (Spa / Spa Endurance, Silverstone WEC / ELMS) : « Endurance » si le nom
        // le dit, sinon le plus récemment roulé.
        const hits = Array.from(courses.entries())
            .filter(([c, v]) => cxiTrackTag(c) === want || cxiTrackTag(v.venue) === want)
            .sort((a, b) => (/endurance/i.test(b[0]) === endu) - (/endurance/i.test(a[0]) === endu) || b[1].last - a[1].last);
        if (hits.length) return hits[0][0];
    }
    if (_cxi.course && courses.has(_cxi.course)) return _cxi.course;
    const recent = _cxi.files.map(f => _cxi.heads.get(f.name)).find(h => h?.course);
    return recent?.course || '';
}

/* ══════════ RECHERCHE DES SESSIONS ══════════ */

/** Noms des pilotes de l'équipe : leurs voitures sont cochées par défaut. */
function cxiMyNames() {
    const out = new Set();
    try {
        const n = typeof getDriverCount === 'function' ? getDriverCount() : 0;
        for (let i = 0; i < n; i++) {
            const v = document.getElementById(`driverName_${i}`)?.value?.trim();
            if (v && !/^pilote \d+$/i.test(v)) out.add(histKey(v));   // noms par défaut ignorés
        }
    } catch (e) { /* onglet stratégie absent */ }
    // Le pilote le plus présent du palmarès (en général soi-même).
    try {
        const idx = histDriverIndex(histRealSessions());
        const top = Array.from(idx.values()).sort((a, b) => b.sessions.size - a.sessions.size)[0];
        if (top) out.add(top.key);
    } catch (e) { /* palmarès vide */ }
    return out;
}

/** Les N sessions les plus récentes du tracé où la voiture choisie a de l'usure ou de l'EV. */
async function cxiRefresh() {
    const run = ++_cxi.run;
    _cxi.sessions = [];
    _cxi.scanned = 0;
    if (!_cxi.files.length || !_cxi.course || !_cxi.car) { cxiRender(); return; }
    _cxi.busy = true;
    cxiRender();
    const me = cxiMyNames();
    const files = _cxi.files.filter(f => _cxi.heads.get(f.name)?.course === _cxi.course);
    const found = [];
    for (const f of files) {
        if (found.length >= _cxi.count) break;
        let sessions = _cxi.parsed.get(f.name);
        if (!sessions) {
            try { sessions = cxiParseXml(await f.text(), f.name); } catch (e) { sessions = []; }
            _cxi.parsed.set(f.name, sessions);
            await new Promise(r => setTimeout(r, 0));
        }
        if (run !== _cxi.run) return;   // filtres changés entre-temps
        _cxi.scanned++;
        for (const s of sessions.slice().sort((a, b) => b.ts - a.ts)) {
            if (found.length >= _cxi.count) break;
            const rows = s.entries.filter(e => e.carId === _cxi.car && (e.stats.ve.length || e.stats.wearLaps));
            if (!rows.length) continue;
            const offline = s.setting !== 'Multiplayer';
            for (const e of rows) {
                e.mine = e.drivers.some(d => me.has(histKey(d)));
                // Par défaut : nos voitures, et la voiture seule d'une session hors ligne (forcément la nôtre).
                if (!_cxi.checked.has(e.key)) _cxi.checked.set(e.key, e.mine || (offline && rows.length === 1));
            }
            found.push(Object.assign({}, s, { rows }));
        }
    }
    _cxi.sessions = found;
    _cxi.busy = false;
    cxiRender();
}

/** Moyennes des voitures cochées (pondérées par tour). */
function cxiAggregate() {
    const times = [], ve = [], wear = {};
    const veSrc = new Set();
    let entries = 0, sessions = 0;
    for (const s of _cxi.sessions) {
        let used = false;
        for (const e of s.rows) {
            if (!_cxi.checked.get(e.key)) continue;
            used = true;
            entries++;
            times.push(...e.stats.times);
            if (e.stats.ve.length) { ve.push(...e.stats.ve); veSrc.add(e.stats.veSrc); }
            for (const [c, byComp] of Object.entries(e.stats.wear)) {
                for (const [k, vals] of Object.entries(byComp)) ((wear[c] ||= {})[k] ||= []).push(...vals);
            }
        }
        if (used) sessions++;
    }
    if (!entries) return null;
    const w = {};
    for (const [c, byComp] of Object.entries(wear)) {
        for (const [k, vals] of Object.entries(byComp)) (w[c] ||= {})[k] = { v: Math.round(cxiMean(vals) * 100) / 100, n: vals.length };
    }
    return {
        sessions, entries, laps: times.length,
        lapTime: cxiMean(times),
        ev: ve.length ? Math.round(cxiMean(ve) * 100) / 100 : null, evN: ve.length, evSrc: Array.from(veSrc).join(' + '),
        wear: w,
    };
}

/* ══════════ RENDU ══════════ */

function cxiSetStatus(msg) { _cxi.status = msg; const el = document.getElementById('cxiStatus'); if (el) el.textContent = msg; }

function cxiRender() {
    const st = document.getElementById('cxiStatus');
    if (st) st.textContent = _cxi.status;
    const ctl = document.getElementById('cxiControls');
    const list = document.getElementById('cxiSessions');
    const prev = document.getElementById('cxiPreview');
    if (!ctl || !list || !prev) return;
    if (!_cxi.files.length) { ctl.innerHTML = list.innerHTML = prev.innerHTML = ''; return; }

    // Tracés présents dans les fichiers, groupés par lieu.
    const byVenue = new Map();
    _cxi.files.forEach(f => {
        const h = _cxi.heads.get(f.name);
        if (!h?.course) return;
        if (!byVenue.has(h.venue)) byVenue.set(h.venue, new Map());
        const m = byVenue.get(h.venue);
        m.set(h.course, (m.get(h.course) || 0) + 1);
    });
    const opt = (v, l, cur) => `<option value="${paceEsc(v)}" ${v === cur ? 'selected' : ''}>${paceEsc(l)}</option>`;
    ctl.innerHTML = `<div class="cxi-controls">
        <label><span>Tracé</span><select onchange="cxiSet('course', this.value)">${
            Array.from(byVenue.keys()).sort((a, b) => a.localeCompare(b)).map(v => `<optgroup label="${paceEsc(v)}">${
                Array.from(byVenue.get(v).entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([c, n]) => opt(c, `${c} (${n})`, _cxi.course)).join('')}</optgroup>`).join('')
        }</select></label>
        <label><span>Voiture</span><select onchange="cxiSet('car', this.value)">${opt('', '— Choisir —', _cxi.car)}${
            LMU_HYPERCARS.map(c => opt(c.id, c.label, _cxi.car)).join('')}</select></label>
        <label><span>Sessions récentes</span><select onchange="cxiSet('count', +this.value)">${
            CXI_COUNTS.map(n => `<option value="${n}" ${n === _cxi.count ? 'selected' : ''}>${n} dernières</option>`).join('')}</select></label>
    </div>`;

    if (!_cxi.car) { list.innerHTML = '<div class="cxi-muted">Choisis la voiture à mettre à jour.</div>'; prev.innerHTML = ''; return; }
    if (_cxi.busy) { list.innerHTML = '<div class="cxi-muted">Recherche des sessions…</div>'; prev.innerHTML = ''; return; }
    if (!_cxi.sessions.length) {
        list.innerHTML = `<div class="cxi-muted">Aucune session avec usure ou EV pour la ${paceEsc(cxiCarLabel(_cxi.car))} sur ce tracé
            (${_cxi.scanned} fichier(s) lu(s)). En ligne, ces données n'apparaissent que si le serveur les rend visibles ;
            les sessions hors ligne les contiennent toujours.</div>`;
        prev.innerHTML = '';
        return;
    }
    list.innerHTML = `<div class="cxi-list-head">
            <span>${_cxi.sessions.length} session(s) les plus récentes · coche les voitures à prendre en compte (⭐ = équipe)</span>
            <span><button type="button" class="cxi-link" onclick="cxiCheckAll(true)">Tout cocher</button>
            <button type="button" class="cxi-link" onclick="cxiCheckAll(false)">Tout décocher</button></span>
        </div>` + _cxi.sessions.map(s => `
        <div class="cxi-sess">
            <div class="cxi-sess-head">${cxiFmtDateTime(s.ts)} · ${paceEsc(HIST_TYPES[s.type] || s.type || 'Session')}${s.setting ? ' · ' + paceEsc(s.setting) : ''}
                <span class="cxi-muted">${paceEsc(s.file)}</span></div>
            ${s.rows.map(e => cxiEntryRow(e)).join('')}
        </div>`).join('');
    prev.innerHTML = cxiPreviewHtml(cxiAggregate());
}

function cxiEntryRow(e) {
    const st = e.stats;
    const comp = {};
    for (const c of CXI_CORNERS) {
        const byComp = st.wear[c] || {};
        const k = Object.keys(byComp).sort((a, b) => byComp[b].length - byComp[a].length)[0];
        if (k) comp[c] = { k, v: cxiMean(byComp[k]) };
    }
    const mainK = comp.FL?.k || comp.RL?.k;
    const wearTxt = Object.keys(comp).length
        ? `${paceCompoundLabel(mainK)} ${CXI_CORNERS.map(c => comp[c] ? comp[c].v.toFixed(2) : '—').join(' / ')} %`
        : 'pas d\'usure';
    return `<label class="cxi-entry">
        <input type="checkbox" ${_cxi.checked.get(e.key) ? 'checked' : ''} onchange="cxiToggle(${paceEsc(JSON.stringify(e.key))}, this.checked)">
        <span class="cxi-entry-main">${e.mine ? '<span title="Voiture de l\'équipe">⭐</span>' : ''}${e.num ? '#' + paceEsc(e.num) + ' ' : ''}${paceEsc(e.team)}
            <span class="cxi-muted">${paceEsc(e.drivers.join(', '))}</span></span>
        <span class="cxi-entry-stats">${st.kept} tours · ${paceFmtLap(cxiMean(st.times))} · ${st.ve.length ? `${st.veSrc} ${cxiMean(st.ve).toFixed(2)} %` : 'pas d\'EV'} · ${wearTxt}</span>
    </label>`;
}

/** Valeurs actuelles de l'éditeur, pour comparer avec l'import. */
function cxiEditorValues() {
    const num = id => parseFloat(document.getElementById(id)?.value);
    const tyres = {};
    CXI_CORNERS.forEach(c => { tyres[c] = {}; CXI_COMPOUNDS.forEach(k => { tyres[c][k] = num(`circTyre_${c}_${k}`) || 0; }); });
    return {
        lapTime: (num('circLapMin') || 0) * 60 + (num('circLapSec') || 0) + (num('circLapMil') || 0) / 10,
        ev: num('circEvPerLap'),
        tyres,
    };
}

function cxiPreviewHtml(agg) {
    if (!agg) return '<div class="cxi-muted">Coche au moins une voiture pour calculer les moyennes.</div>';
    const cur = cxiEditorValues();
    const lapTenths = Math.round(agg.lapTime * 10);
    const fmtTenths = t => `${Math.floor(t / 600)}:${String(Math.floor(t / 10) % 60).padStart(2, '0')}.${t % 10}`;
    const rows = [[`Temps au tour moyen <span class="cxi-muted">(${agg.laps} tours)</span>`, fmtTenths(Math.round(cur.lapTime * 10)), fmtTenths(lapTenths)]];
    rows.push([`EV par tour <span class="cxi-muted">(${agg.ev != null ? agg.evN + ' tours, ' + paceEsc(agg.evSrc) : 'aucune mesure'})</span>`,
        Number.isFinite(cur.ev) ? cur.ev.toFixed(2) + ' %' : '—', agg.ev != null ? agg.ev.toFixed(2) + ' %' : 'inchangée']);
    const comps = CXI_COMPOUNDS.filter(k => CXI_CORNERS.some(c => agg.wear[c]?.[k]));
    for (const k of comps) {
        const cell = src => CXI_CORNERS.map(c => src(c)).join(' / ');
        rows.push([`Usure ${paceCompoundLabel(k)} FL / FR / RL / RR`,
            cell(c => (cur.tyres[c][k] || 0).toFixed(2)) + ' %',
            cell(c => agg.wear[c]?.[k] ? agg.wear[c][k].v.toFixed(2) : '=') + ' %']);
    }
    if (!comps.length) rows.push(['Usure des pneus', '', 'aucune mesure : inchangée']);
    return `<table class="cxi-table">
        <thead><tr><th>${agg.entries} voiture(s) sur ${agg.sessions} session(s)</th><th>Actuel</th><th>Importé</th></tr></thead>
        <tbody>${rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td><td><b>${r[2]}</b></td></tr>`).join('')}</tbody>
    </table>
    <div class="cxi-apply">
        <button type="button" class="btn-calculate" onclick="cxiApply()">📥 Appliquer à l'éditeur</button>
        <span class="cxi-muted">« = » : pneu sans mesure, valeur actuelle gardée. Clique ensuite sur 💾 Enregistrer le circuit.</span>
    </div>`;
}

/* ══════════ ACTIONS ══════════ */

function cxiSet(k, v) {
    _cxi[k] = v;
    cxiRefresh();
}
function cxiToggle(key, on) {
    _cxi.checked.set(key, on);
    const prev = document.getElementById('cxiPreview');
    if (prev) prev.innerHTML = cxiPreviewHtml(cxiAggregate());
}
function cxiCheckAll(on) {
    _cxi.sessions.forEach(s => s.rows.forEach(e => _cxi.checked.set(e.key, on)));
    cxiRender();
}

/** Remplit l'éditeur avec les moyennes (seules les valeurs mesurées remplacent les actuelles). */
function cxiApply() {
    const agg = cxiAggregate();
    if (!agg) return;
    const carSel = document.getElementById('circCarSelect');
    if (carSel && carSel.value !== _cxi.car) {
        carSel.value = _cxi.car;
        // Voiture changée : on part de ses données déjà en base sur ce circuit.
        if (_editingCircuitId && _circuits[_editingCircuitId]) _loadCircuitCarFields(_circuits[_editingCircuitId], _cxi.car);
    }
    const nameInput = document.getElementById('circuitNameInput');
    const venue = _cxi.sessions[0]?.venue || _cxi.course;
    if (nameInput && !nameInput.value.trim()) nameInput.value = venue;

    const changed = [];
    const set = (id, v) => { const el = document.getElementById(id); if (el) { el.value = v; changed.push(el); } };
    const t = Math.round(agg.lapTime * 10);
    set('circLapMin', Math.floor(t / 600));
    set('circLapSec', Math.floor(t / 10) % 60);
    set('circLapMil', t % 10);
    if (agg.ev != null) set('circEvPerLap', agg.ev);
    for (const c of CXI_CORNERS) {
        for (const [k, w] of Object.entries(agg.wear[c] || {})) set(`circTyre_${c}_${k}`, w.v);
    }
    // L'EV change le nombre de stints affiché pour toutes les gommes.
    CXI_CORNERS.forEach(c => CXI_COMPOUNDS.forEach(k => {
        const el = document.getElementById(`circTyre_${c}_${k}`);
        if (el) updateCircTyreWearUI(c, k, el.value);
    }));
    changed.forEach(el => { el.classList.remove('cxi-flash'); void el.offsetWidth; el.classList.add('cxi-flash'); });
    const info = document.getElementById('circuitSaveInfo');
    if (info) {
        info.textContent = `📥 Moyennes de ${agg.entries} voiture(s) sur ${agg.sessions} session(s) (${agg.laps} tours) appliquées à « ${nameInput?.value || venue} » / ${cxiCarLabel(_cxi.car)}. Clique sur 💾 Enregistrer le circuit pour les garder.`;
    }
    const prev = document.getElementById('cxiPreview');
    if (prev) prev.innerHTML = cxiPreviewHtml(agg);
}

/* ══════════ INITIALISATION ══════════ */
function initCircuitXmlImport() {
    const dir = document.getElementById('cxiDirInput');
    const files = document.getElementById('cxiFileInput');
    const box = document.getElementById('cxiBox');
    if (dir) dir.addEventListener('change', () => { cxiSetFiles(dir.files, 'Results'); dir.value = ''; });
    if (files) files.addEventListener('change', () => { cxiSetFiles(files.files); files.value = ''; });
    if (box) {
        ['dragenter', 'dragover'].forEach(ev => box.addEventListener(ev, e => { e.preventDefault(); box.classList.add('drag'); }));
        ['dragleave', 'drop'].forEach(ev => box.addEventListener(ev, e => { e.preventDefault(); box.classList.remove('drag'); }));
        box.addEventListener('drop', e => { box.open = true; histFilesFromDrop(e.dataTransfer).then(f => cxiSetFiles(f)); });
    }
    // L'import suit le circuit et la voiture choisis dans l'éditeur.
    document.getElementById('circCarSelect')?.addEventListener('change', e => {
        if (e.target.value && e.target.value !== _cxi.car) { _cxi.car = e.target.value; if (_cxi.files.length) cxiRefresh(); }
    });
    document.getElementById('circuitEditSelect')?.addEventListener('change', () => {
        if (!_cxi.files.length) return;
        const c = cxiDefaultCourse();
        if (c !== _cxi.course) { _cxi.course = c; cxiRefresh(); }
    });
    // Dossier choisi lors d'une visite précédente : bouton « Relire » (l'accès est redemandé au clic).
    cxiKv('readonly', s => s.get('dir')).then(h => {
        if (h) { _cxi.handle = h; document.getElementById('cxiRescanBtn')?.removeAttribute('hidden'); }
    }).catch(() => {});
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initCircuitXmlImport);
else initCircuitXmlImport();
