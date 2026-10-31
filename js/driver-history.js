/* ══════════════════════════════════════════════
   ONGLET PALMARÈS — évolution du rythme de chaque pilote dans le temps
   Source : les XML de résultats LMU (UserData\Log\Results\*.xml), importés en lot (dossier entier ou fichiers).
   Pour chaque session et chaque pilote on garde ses tours chronométrés hors stands (en ms), la gomme
   de chaque tour et le résultat final. Les IA (isPlayer = 0) sont écartées.
   Les sessions sont stockées dans ce navigateur (IndexedDB : des centaines de fichiers dépassent la
   limite de localStorage) ; seuls les fichiers encore inconnus sont relus à l'import suivant.
   Réutilise js/pace-analysis.js (chargé avant) : relais du journal, violons, étiquettes au survol.
   ══════════════════════════════════════════════ */

const HIST_DB = 'lmuHistory';
const HIST_STORE = 'sessions';
const HIST_UI_KEY = 'lmuHistory.ui.v1';
const HIST_TYPES = { P: 'Essais', Q: 'Qualif', R: 'Course', W: 'Warm-up' };
const HIST_GROUPS = { session: 'Session', day: 'Jour', week: 'Semaine', month: 'Mois' };
const HIST_COMPOUND_CODE = { soft: 'S', medium: 'M', hard: 'H', wet: 'W', inter: 'I' };
const HIST_CODE_COMPOUND = { S: 'soft', M: 'medium', H: 'hard', W: 'wet', I: 'inter' };
const HIST_MIN_LAPS = 3;        // tours retenus minimum pour qu'une session compte
const HIST_GAP_MIN_FIELD = 3;   // en écart %, pilotes humains minimum dans la catégorie (sinon la référence ne veut rien dire)
const HIST_MAX_DOTS = 6000;     // au-delà, on ne dessine plus chaque tour (lenteur du navigateur)
const HIST_LIST_MAX = 150;      // pilotes affichés dans la liste (il y en a des milliers)
const HIST_MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

let _hist = {
    course: null,        // tracé affiché ('' = tous, en écart %) ; null = pas encore choisi
    cls: '',
    car: '',
    types: ['P', 'Q', 'R'],
    months: 0,           // période : 0 = tout, sinon N derniers mois
    group: 'session',    // session | day | week | month
    measure: 'time',     // time (temps au tour) | gap (écart % au meilleur tour de la catégorie)
    threshold: 4,        // % au-dessus du meilleur tour du pilote dans la session
    selected: [],        // clés de pilotes (nom en minuscules)
    search: '',
    selectionTouched: false,
};
const _histData = { sessions: [], db: null, loaded: false, busy: false, error: '' };

/* ── Réglages de l'onglet (localStorage) ── */
function histSaveUi() {
    try { localStorage.setItem(HIST_UI_KEY, JSON.stringify(_hist)); } catch (e) { /* stockage indisponible */ }
}
function histLoadUi() {
    try {
        const raw = localStorage.getItem(HIST_UI_KEY);
        if (raw) Object.assign(_hist, JSON.parse(raw));
    } catch (e) { /* on garde les valeurs par défaut */ }
    _hist.search = '';
}

/* ── Base locale (IndexedDB) ── */
function histOpenDb() {
    return new Promise((resolve, reject) => {
        if (!window.indexedDB) { reject(new Error('IndexedDB indisponible dans ce navigateur')); return; }
        const req = indexedDB.open(HIST_DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(HIST_STORE, { keyPath: 'key' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
function histDbTx(mode, fn) {
    return new Promise((resolve, reject) => {
        if (!_histData.db) { resolve(null); return; }
        const tx = _histData.db.transaction(HIST_STORE, mode);
        const store = tx.objectStore(HIST_STORE);
        const out = fn(store);
        tx.oncomplete = () => resolve(out && 'result' in out ? out.result : null);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}
const histDbAll = () => histDbTx('readonly', s => s.getAll());
const histDbPut = recs => histDbTx('readwrite', s => { recs.forEach(r => s.put(r)); });
const histDbClear = () => histDbTx('readwrite', s => { s.clear(); });

/* ── Petits utilitaires ── */
function histNormName(s) { return String(s || '').replace(/#\d+\s*$/, '').replace(/\s+/g, ' ').trim(); }
function histKey(name) { return histNormName(name).toLowerCase(); }
function histInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
function histDate(ts) { return new Date(ts * 1000); }
function histFmtDate(ts) {
    const d = histDate(ts);
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getFullYear()).slice(2)}`;
}
function histFmtMonth(ts) { const d = histDate(ts); return `${HIST_MONTHS[d.getMonth()]} ${d.getFullYear()}`; }
function histMonthKey(ts) { const d = histDate(ts); return d.getFullYear() * 12 + d.getMonth(); }
/** Horodatage tiré du nom de fichier (2026_04_04_17_28_07-61P1.xml) si le XML n'en donne pas. */
function histTsFromName(name) {
    const m = String(name).match(/(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})/);
    return m ? Math.round(new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() / 1000) : 0;
}

/* ══════════ LECTURE DES XML ══════════ */

/** XML de résultats → une fiche par session : [{ key, file, ts, venue, course, setting, type, tag, field, e: [pilote] }]. */
function histParseXml(text, fileName) {
    // Le jeu laisse parfois quelques octets parasites après la balise de fin : on les coupe.
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
        if (!type) continue;
        const ts = histInt(own(sess, 'DateTime')) || rootTs;
        const changes = paceDriverChanges(sess);
        const field = {};               // voitures engagées par catégorie (IA comprises) : « P3 / 18 »
        const entries = new Map();
        for (const d of drivers) {
            const get = t => own(d, t);
            const cls = get('CarClass');
            field[cls] = (field[cls] || 0) + 1;
            if (get('isPlayer') === '0') continue;   // IA
            const name = get('Name');
            if (!histNormName(name)) continue;
            const kids = Array.from(d.children);
            const atWheel = paceDriverAtWheel(changes, get('VehName'), name);
            const swaps = kids.filter(c => c.tagName === 'Swap').map(s => ({
                start: histInt(s.getAttribute('startLap')), end: histInt(s.getAttribute('endLap')), name: s.textContent.trim(),
            }));
            const car = get('CarType') || get('VehName');
            const base = {
                car, cls, team: get('TeamName'), num: get('CarNumber'),
                pos: histInt(get('Position')), cpos: histInt(get('ClassPosition')), status: get('FinishStatus'),
            };
            for (const l of kids) {
                if (l.tagName !== 'Lap' || l.getAttribute('pit') === '1') continue;
                const time = paceNum(l.textContent);
                if (!(time > 0)) continue;   // « --.---- » : tour non chronométré
                const num = histInt(l.getAttribute('num'));
                const et = paceNum(l.getAttribute('et'));
                const swap = swaps.find(s => num >= s.start && num <= s.end);
                let who = (atWheel && et != null && atWheel(et)) || swap?.name || name;
                if (!histNormName(who) || /^\?+$/.test(who.trim())) who = name;   // <Swap>???</Swap>
                const nm = histNormName(who);
                const k = `${nm.toLowerCase()}|${car}`;
                let e = entries.get(k);
                if (!e) entries.set(k, e = Object.assign({ d: nm, t: [], c: '' }, base));
                e.t.push(Math.round(time * 1000));
                e.c += HIST_COMPOUND_CODE[paceCompoundKey((l.getAttribute('fcompound') || '').split(',')[1])] || '-';
            }
        }
        out.push({
            key: `${ts}|${course}|${tag}`, file: fileName, ts, venue, course, setting, type, tag, field,
            e: Array.from(entries.values()),
        });
    }
    return out;
}

/** Fichiers déposés : on descend dans les dossiers (dépôt du dossier Results entier). */
async function histFilesFromDrop(dt) {
    // webkitGetAsEntry doit être appelé tout de suite, avant le premier await.
    const entries = Array.from(dt.items || []).map(i => i.webkitGetAsEntry?.()).filter(Boolean);
    if (!entries.length || entries.every(e => e.isFile)) return Array.from(dt.files || []);
    const out = [];
    const walk = async entry => {
        if (entry.isFile) {
            if (/\.xml$/i.test(entry.name)) out.push(await new Promise((res, rej) => entry.file(res, rej)));
            return;
        }
        const reader = entry.createReader();
        for (;;) {
            const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
            if (!batch.length) break;
            for (const e of batch) await walk(e);
        }
    };
    for (const e of entries) await walk(e);
    return out;
}

async function histImportFiles(fileList) {
    const status = document.getElementById('histImportStatus');
    const say = html => { if (status) status.innerHTML = html; };
    if (_histData.busy) return;
    const files = Array.from(fileList || []).filter(f => /\.xml$/i.test(f.name));
    if (!files.length) { say('Aucun fichier XML dans la sélection.'); return; }
    _histData.busy = true;
    const known = new Set(_histData.sessions.map(s => s.file));
    const byKey = new Map(_histData.sessions.map(s => [s.key, s]));
    let added = 0, skipped = 0, empty = 0;
    const failed = [];
    let pending = [];
    const flush = async () => {
        if (!pending.length) return;
        try { await histDbPut(pending); } catch (err) { _histData.error = 'Enregistrement local impossible : ' + (err?.message || err); }
        pending = [];
    };
    try {
        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            if (known.has(f.name)) { skipped++; continue; }
            if (i % 4 === 0) {
                say(`Lecture ${i + 1} / ${files.length}…`);
                await new Promise(r => setTimeout(r, 0));   // laisse la page respirer
            }
            try {
                const recs = histParseXml(await f.text(), f.name);
                // Fichier sans pilote : on le note quand même pour ne pas le relire à chaque import.
                if (!recs.length) { recs.push({ key: `vide|${f.name}`, file: f.name, ts: histTsFromName(f.name), empty: true, e: [] }); empty++; }
                for (const r of recs) {
                    if (!r.empty && !byKey.has(r.key)) added++;
                    byKey.set(r.key, r);
                    pending.push(r);
                }
                known.add(f.name);
            } catch (err) {
                failed.push(`${f.name} : ${err.message}`);
            }
            if (pending.length >= 40) await flush();
        }
        await flush();
    } finally {
        _histData.sessions = Array.from(byKey.values()).sort((a, b) => a.ts - b.ts);
        _histData.busy = false;
    }
    const parts = [`✅ ${added} session${added > 1 ? 's' : ''} ajoutée${added > 1 ? 's' : ''}`];
    if (skipped) parts.push(`${skipped} fichier${skipped > 1 ? 's' : ''} déjà connu${skipped > 1 ? 's' : ''}`);
    if (empty) parts.push(`${empty} sans pilote`);
    let html = parts.map(paceEsc).join(' · ');
    if (failed.length) html += '<br>' + failed.slice(0, 8).map(m => '❌ ' + paceEsc(m)).join('<br>') + (failed.length > 8 ? `<br>… ${failed.length - 8} autres erreurs` : '');
    if (!_histData.db) html += '<br>⚠️ Base locale indisponible : ces données seront perdues en fermant la page.';
    say(html);
    renderHistoryTab();
}

async function histClearAll() {
    if (!confirm('Effacer toutes les sessions importées dans le palmarès (ce navigateur) ?')) return;
    try { await histDbClear(); } catch (err) { alert('Effacement impossible : ' + (err?.message || err)); return; }
    _histData.sessions = [];
    _hist.selected = [];
    _hist.selectionTouched = false;
    _hist.course = null;
    histSaveUi();
    const st = document.getElementById('histImportStatus');
    if (st) st.textContent = '';
    renderHistoryTab();
}

/* ══════════ FILTRES ET AGRÉGATION ══════════ */

function histRealSessions() { return _histData.sessions.filter(s => !s.empty); }

/** Mesure effective : sur plusieurs tracés, seul l'écart en % est comparable. */
function histMeasure() { return _hist.course === '' ? 'gap' : _hist.measure; }

/** Sessions retenues par le circuit, le type et la période. */
function histVisibleSessions() {
    const cutoff = _hist.months > 0 ? (() => { const d = new Date(); d.setMonth(d.getMonth() - _hist.months); return d.getTime() / 1000; })() : 0;
    const types = new Set(_hist.types);
    return histRealSessions().filter(s =>
        types.has(s.type) && s.ts >= cutoff && (!_hist.course || s.course === _hist.course));
}
function histPassEntry(e) { return (!_hist.cls || e.cls === _hist.cls) && (!_hist.car || e.car === _hist.car); }

/** Pilotes présents avec les filtres actuels : clé → { name, sessions, last }. */
function histDriverIndex(sessions) {
    const idx = new Map();
    for (const s of sessions) {
        for (const e of s.e) {
            if (!e.t.length || !histPassEntry(e)) continue;
            const k = e.d.toLowerCase();
            let d = idx.get(k);
            if (!d) idx.set(k, d = { key: k, name: e.d, sessions: new Set(), last: 0 });
            d.sessions.add(s.key);
            if (s.ts >= d.last) { d.last = s.ts; d.name = e.d; }
        }
    }
    return idx;
}

function histGroupKey(ts) {
    const d = histDate(ts);
    if (_hist.group === 'day') return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (_hist.group === 'week') {
        const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
        return `w${monday.getFullYear()}-${monday.getMonth()}-${monday.getDate()}`;
    }
    if (_hist.group === 'month') return `m${histMonthKey(ts)}`;
    return null;
}

/**
 * Points du graphique : pour chaque pilote coché, une valeur par session (ou par jour / semaine / mois).
 * Chaque point garde ses tours retenus (≤ meilleur tour du pilote dans la session + seuil).
 */
function histBuildPoints(sessions) {
    const mode = histMeasure();
    const thr = 1 + _hist.threshold / 100;
    const sel = new Set(_hist.selected);
    const byDriver = new Map();   // clé pilote → Map(clé groupe → point)
    let skippedField = 0;
    for (const s of sessions) {
        let refs = null;
        for (const e of s.e) {
            const dk = e.d.toLowerCase();
            if (!sel.has(dk) || !e.t.length || !histPassEntry(e)) continue;
            const best = Math.min(...e.t);
            const idx = [];
            e.t.forEach((t, i) => { if (t <= best * thr) idx.push(i); });
            if (idx.length < HIST_MIN_LAPS) continue;
            let ref = null;
            if (mode === 'gap') {
                if (!refs) refs = histClassRefs(s);
                const r = refs.get(e.cls);
                if (!r || r.n < HIST_GAP_MIN_FIELD) { skippedField++; continue; }
                ref = r.best;
            }
            const val = t => mode === 'gap' ? (t / ref - 1) * 100 : t / 1000;
            const gk = histGroupKey(s.ts) || `${s.key}|${e.car}`;
            if (!byDriver.has(dk)) byDriver.set(dk, new Map());
            const groups = byDriver.get(dk);
            let p = groups.get(gk);
            if (!p) groups.set(gk, p = { gk, dk, name: e.d, ts: s.ts, laps: [], parts: [] });
            p.ts = Math.min(p.ts, s.ts);
            idx.forEach(i => p.laps.push({ v: val(e.t[i]), t: e.t[i] / 1000, c: HIST_CODE_COMPOUND[e.c[i]] || '', s }));
            p.parts.push({ s, e, best: best / 1000, n: idx.length });
        }
    }
    const points = [];
    for (const groups of byDriver.values()) {
        for (const p of groups.values()) {
            p.laps.sort((a, b) => a.v - b.v);
            const v = p.laps.map(l => l.v);
            Object.assign(p, {
                vals: v, mean: paceMean(v), median: paceQuantile(v, 0.5),
                q1: paceQuantile(v, 0.25), q3: paceQuantile(v, 0.75), sd: paceSd(v), min: v[0],
                bestLap: Math.min(...p.parts.map(x => x.best)),
            });
            points.push(p);
        }
    }
    return { points, skippedField, mode };
}

/** Meilleur tour (ms) et nombre de pilotes humains chronométrés par catégorie, dans une session. */
function histClassRefs(s) {
    const refs = new Map();
    for (const e of s.e) {
        if (!e.t.length) continue;
        const r = refs.get(e.cls) || { best: Infinity, n: 0 };
        r.best = Math.min(r.best, ...e.t);
        r.n++;
        refs.set(e.cls, r);
    }
    return refs;
}

/** Régression linéaire valeur = a + b × jours. */
function histFit(points) {
    if (points.length < 2) return null;
    const xs = points.map(p => p.ts / 86400), ys = points.map(p => p.mean);
    const mx = paceMean(xs), my = paceMean(ys);
    let sxx = 0, sxy = 0;
    xs.forEach((x, i) => { sxx += (x - mx) ** 2; sxy += (x - mx) * (ys[i] - my); });
    if (sxx < 1e-6) return null;
    const b = sxy / sxx;
    return { b, at: ts => my + b * (ts / 86400 - mx) };
}

/* ══════════ RENDU ══════════ */

function renderHistoryTab() {
    const root = document.getElementById('tab-history');
    if (!root) return;
    const charts = document.getElementById('histCharts');
    if (!_histData.loaded) {
        if (charts) charts.innerHTML = '<div class="pace-empty"><div>Chargement des sessions enregistrées…</div></div>';
        return;
    }
    const all = histRealSessions();
    // Tracé par défaut : celui de la session la plus récente.
    const courses = new Set(all.map(s => s.course));
    if (_hist.course === null || (_hist.course && !courses.has(_hist.course))) _hist.course = all.length ? all[all.length - 1].course : null;

    const sessions = histVisibleSessions();
    // Catégories et voitures proposées : celles des sessions affichées.
    const classes = new Set(), cars = new Set();
    sessions.forEach(s => s.e.forEach(e => {
        if (!e.t.length) return;
        classes.add(e.cls);
        if (!_hist.cls || e.cls === _hist.cls) cars.add(e.car);
    }));
    if (_hist.cls && !classes.has(_hist.cls)) _hist.cls = '';
    if (_hist.car && !cars.has(_hist.car)) _hist.car = '';

    const idx = histDriverIndex(sessions);
    // Sélection par défaut : le pilote présent dans le plus de sessions (en général soi-même).
    if (!_hist.selected.length && !_hist.selectionTouched && idx.size) {
        const top = Array.from(histDriverIndex(all).values()).sort((a, b) => b.sessions.size - a.sessions.size)[0];
        if (top) _hist.selected = [top.key];
    }
    histSaveUi();

    histRenderStore(all);
    histRenderFilters(all, classes, cars);
    histRenderDriverList(idx);
    histRenderCharts(sessions, idx);
}

function histRenderStore(all) {
    const el = document.getElementById('histStore');
    if (!el) return;
    if (_histData.error) { el.innerHTML = `<div class="pace-muted">⚠️ ${paceEsc(_histData.error)}</div>`; return; }
    if (!all.length) { el.innerHTML = '<div class="pace-muted">Aucune session importée.</div>'; return; }
    const files = new Set(_histData.sessions.map(s => s.file)).size;
    const count = t => all.filter(s => s.type === t).length;
    el.innerHTML = `<div class="hist-store">
        <div><b>${all.length}</b> sessions · ${files} fichiers</div>
        <div class="pace-muted">${count('P')} essais · ${count('Q')} qualifs · ${count('R')} courses</div>
        <div class="pace-muted">Du ${histFmtDate(all[0].ts)} au ${histFmtDate(all[all.length - 1].ts)}</div>
    </div>`;
}

function histRenderFilters(all, classes, cars) {
    const opt = (v, label, cur) => `<option value="${paceEsc(v)}" ${v === cur ? 'selected' : ''}>${paceEsc(label)}</option>`;
    const cs = document.getElementById('histCourseSelect');
    if (cs) {
        const byVenue = new Map();
        all.forEach(s => {
            if (!byVenue.has(s.venue)) byVenue.set(s.venue, new Map());
            const m = byVenue.get(s.venue);
            m.set(s.course, (m.get(s.course) || 0) + 1);
        });
        cs.innerHTML = opt('', 'Tous les circuits (écart en %)', _hist.course) +
            Array.from(byVenue.keys()).sort((a, b) => a.localeCompare(b)).map(v => `<optgroup label="${paceEsc(v)}">${
                Array.from(byVenue.get(v).entries()).sort((a, b) => a[0].localeCompare(b[0]))
                    .map(([c, n]) => opt(c, `${c} (${n})`, _hist.course)).join('')}</optgroup>`).join('');
    }
    const cl = document.getElementById('histClassSelect');
    if (cl) cl.innerHTML = opt('', 'Toutes', _hist.cls) + Array.from(classes).sort().map(c => opt(c, c || '?', _hist.cls)).join('');
    const ca = document.getElementById('histCarSelect');
    if (ca) ca.innerHTML = opt('', 'Toutes', _hist.car) + Array.from(cars).sort((a, b) => a.localeCompare(b)).map(c => opt(c, c, _hist.car)).join('');
    const ty = document.getElementById('histTypes');
    if (ty) {
        ty.innerHTML = ['P', 'Q', 'R'].map(t => `<label><input type="checkbox" ${_hist.types.includes(t) ? 'checked' : ''}
            onchange="histToggleType('${t}', this.checked)"> ${HIST_TYPES[t]}</label>`).join('');
    }
    const pe = document.getElementById('histPeriodSelect');
    if (pe) {
        pe.innerHTML = [[0, 'Tout l\'historique'], [24, '24 derniers mois'], [12, '12 derniers mois'], [6, '6 derniers mois'], [3, '3 derniers mois'], [1, 'Dernier mois']]
            .map(([v, l]) => `<option value="${v}" ${v === _hist.months ? 'selected' : ''}>${l}</option>`).join('');
    }
    const gr = document.getElementById('histGroupSeg');
    if (gr) {
        gr.innerHTML = Object.entries(HIST_GROUPS).map(([k, l]) =>
            `<button type="button" class="${_hist.group === k ? 'active' : ''}" onclick="histSet('group','${k}')">${l}</button>`).join('');
    }
    const me = document.getElementById('histMeasureSeg');
    if (me) {
        const m = histMeasure();
        me.innerHTML = `<button type="button" class="${m === 'time' ? 'active' : ''}" ${_hist.course === '' ? 'disabled title="Choisis un circuit pour comparer des temps"' : ''} onclick="histSet('measure','time')">Temps au tour</button>
            <button type="button" class="${m === 'gap' ? 'active' : ''}" onclick="histSet('measure','gap')">Écart au meilleur (%)</button>`;
    }
    const th = document.getElementById('histThreshold');
    const thv = document.getElementById('histThresholdValue');
    if (th) th.value = _hist.threshold;
    if (thv) thv.textContent = `+${_hist.threshold}%`;
}

function histRenderDriverList(idx) {
    const el = document.getElementById('histDriverList');
    if (!el) return;
    if (!idx.size) { el.innerHTML = '<div class="pace-muted">Aucun pilote avec ces filtres.</div>'; return; }
    const q = _hist.search.trim().toLowerCase();
    const sel = new Set(_hist.selected);
    const list = Array.from(idx.values())
        .filter(d => !q || d.key.includes(q))
        .sort((a, b) => (sel.has(b.key) - sel.has(a.key)) || (b.sessions.size - a.sessions.size) || a.name.localeCompare(b.name));
    // Pilotes cochés absents avec ces filtres : on les garde visibles pour pouvoir les décocher.
    const missing = _hist.selected.filter(k => !idx.has(k));
    const color = k => PACE_DRIVER_COLORS[_hist.selected.indexOf(k) % PACE_DRIVER_COLORS.length];
    const row = (k, name, info) => `
        <label class="pace-driver">
            <input type="checkbox" ${sel.has(k) ? 'checked' : ''} onchange="histToggleDriver(${paceEsc(JSON.stringify(k))}, this.checked)">
            <span>${sel.has(k) ? `<i class="pace-swatch" style="background:${color(k)}"></i>` : ''}${paceEsc(name)}</span>
            <span class="pace-muted">${info}</span>
        </label>`;
    el.innerHTML = missing.map(k => row(k, k, 'hors filtres')).join('') +
        list.slice(0, HIST_LIST_MAX).map(d => row(d.key, d.name, `${d.sessions.size} sess.`)).join('') +
        (list.length > HIST_LIST_MAX ? `<div class="pace-muted" style="padding:6px 0;">… ${list.length - HIST_LIST_MAX} autres pilotes : affine la recherche.</div>` : '') +
        (!list.length && !missing.length ? '<div class="pace-muted">Aucun résultat.</div>' : '');
}

function histRenderCharts(sessions, idx) {
    const wrap = document.getElementById('histCharts');
    if (!wrap) return;
    if (!histRealSessions().length) {
        wrap.innerHTML = `<div class="pace-empty">
            <div style="font-size:2.2em;">🏆</div>
            <div>Importe le dossier des résultats LMU pour retracer l'historique de chaque pilote.</div>
            <div class="pace-muted"><code>Le Mans Ultimate\\UserData\\Log\\Results</code></div>
        </div>`;
        return;
    }
    if (!_hist.selected.length) {
        wrap.innerHTML = '<div class="pace-empty"><div>Coche un ou plusieurs pilotes dans la liste.</div></div>';
        return;
    }
    const { points, skippedField, mode } = histBuildPoints(sessions);
    const names = new Map(_hist.selected.map(k => [k, idx.get(k)?.name || points.find(p => p.dk === k)?.name || k]));
    const series = _hist.selected.map((k, i) => ({
        dk: k, name: names.get(k), color: PACE_DRIVER_COLORS[i % PACE_DRIVER_COLORS.length],
        pts: points.filter(p => p.dk === k).sort((a, b) => a.ts - b.ts),
    }));
    if (!points.length) {
        wrap.innerHTML = `<div class="pace-card pace-muted">Aucune session exploitable pour ces pilotes avec ces filtres
            (il faut au moins ${HIST_MIN_LAPS} tours retenus par session${mode === 'gap' ? ` et ${HIST_GAP_MIN_FIELD} pilotes dans la catégorie` : ''}).</div>`;
        return;
    }

    // Colonnes du graphique : une par session (ou période), dans l'ordre chronologique.
    const slotMap = new Map();
    for (const p of points) {
        const sk = _hist.group === 'session' ? p.parts[0].s.key : p.gk;
        let slot = slotMap.get(sk);
        if (!slot) slotMap.set(sk, slot = { key: sk, ts: p.ts, items: [] });
        slot.ts = Math.min(slot.ts, p.ts);
        slot.items.push(p);
    }
    const order = new Map(_hist.selected.map((k, i) => [k, i]));
    const slots = Array.from(slotMap.values()).sort((a, b) => a.ts - b.ts);
    slots.forEach(s => s.items.sort((a, b) => order.get(a.dk) - order.get(b.dk)));

    const unit = mode === 'gap' ? 'écart en % au meilleur tour de la catégorie dans la session' : 'temps au tour';
    const what = _hist.group === 'session' ? 'une colonne par session' : `une colonne par ${HIST_GROUPS[_hist.group].toLowerCase()}`;
    const used = new Set(points.flatMap(p => p.laps.map(l => l.c)));
    const dots = points.reduce((n, p) => n + p.laps.length, 0);
    wrap.innerHTML = `<div class="pace-card">
            <div class="pace-card-title">Évolution du rythme <span class="pace-muted">— ${unit}, ${what}, tours à moins de +${_hist.threshold}% du meilleur tour du pilote</span></div>
            <div class="pace-legend">
                ${series.filter(s => s.pts.length).map(s => `<span><i class="pace-swatch" style="background:${s.color}"></i>${paceEsc(s.name)}</span>`).join('')}
                <span class="hist-key-line">moyennes reliées</span><span class="hist-key-dash">tendance</span>
                ${dots <= HIST_MAX_DOTS ? Array.from(used).map(k => `<span><i style="background:${PACE_COMPOUND_COLORS[k] || '#888'}"></i>${paceCompoundLabel(k)}</span>`).join('') : ''}
            </div>
            ${mode === 'gap' && skippedField ? `<div class="pace-muted" style="margin-bottom:6px;">${skippedField} session(s) ignorée(s) : moins de ${HIST_GAP_MIN_FIELD} pilotes dans la catégorie, l'écart n'y serait pas significatif.</div>` : ''}
            ${dots > HIST_MAX_DOTS ? `<div class="pace-muted" style="margin-bottom:6px;">${dots} tours : les points individuels sont masqués. Regroupe par semaine ou par mois, ou réduis la période, pour les voir.</div>` : ''}
            <div class="pace-svg-wrap" id="histSvgWrap">${histChartSvg(slots, series, mode, dots <= HIST_MAX_DOTS)}</div>
            ${histSummaryTable(series, mode)}
        </div>
        <div class="pace-card">
            <div class="pace-card-title">Palmarès <span class="pace-muted">— du plus récent au plus ancien</span></div>
            ${histPalmaresTable(points, series, mode)}
        </div>`;
    // Graphique plus large que l'écran : on montre d'abord la fin (le plus récent).
    const sw = document.getElementById('histSvgWrap');
    if (sw) sw.scrollLeft = sw.scrollWidth;
}

function histFmtVal(mode) {
    return mode === 'gap' ? v => `${v >= 0 ? '+' : ''}${v.toFixed(2)} %` : paceFmtLap;
}
function histPointTip(p, mode, name) {
    const fmt = histFmtVal(mode);
    const parts = p.parts;
    const uniq = list => Array.from(new Set(list.filter(Boolean)));
    const lines = [name];
    if (_hist.group === 'session') {
        const s = parts[0].s;
        lines.push(`${histFmtDate(s.ts)} · ${HIST_TYPES[s.type] || s.type}${s.setting ? ' · ' + s.setting : ''}`, s.course);
    } else {
        lines.push(`${histGroupLabel(p.ts)} · ${uniq(parts.map(x => x.s.key)).length} session(s)`, uniq(parts.map(x => x.s.course)).join(', '));
    }
    lines.push(uniq(parts.map(x => x.e.car)).join(', '));
    lines.push(`Moyenne : ${fmt(p.mean)}`, `Médiane : ${fmt(p.median)}`,
        histOneCourse(p) ? `Meilleur tour : ${paceFmtLap(p.bestLap)}` : '', `Tours retenus : ${p.vals.length}`);
    if (_hist.group === 'session') {
        const r = histResult(parts[0]);
        if (r) lines.push(`Résultat : ${r}`);
    }
    return lines;
}
/** Un meilleur tour n'a de sens que sur un seul tracé. */
function histOneCourse(p) { return new Set(p.parts.map(x => x.s.course)).size === 1; }
/** Liste courte en clair ; au-delà de 2 éléments, « N circuits » avec la liste au survol. */
function histListCell(list, unit) {
    const u = Array.from(new Set(list.filter(Boolean)));
    const full = paceEsc(u.join(', '));
    return u.length <= 2 ? `<td class="hist-cut" title="${full}">${full}</td>` : `<td title="${full}">${u.length} ${unit}</td>`;
}
function histGroupLabel(ts) {
    const d = histDate(ts);
    if (_hist.group === 'month') return histFmtMonth(ts);
    if (_hist.group === 'week') {
        const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
        return `Semaine du ${histFmtDate(monday.getTime() / 1000)}`;
    }
    return histFmtDate(ts);
}
/** « P3 / 18 en GT3 · P12 au général » pour les qualifs et courses ; abandon / DQ précisés. */
function histResult(part) {
    const { s, e } = part;
    if (s.type !== 'R' && s.type !== 'Q') return '';
    const field = s.field?.[e.cls];
    let out = e.cpos ? `P${e.cpos}${field ? ' / ' + field : ''}${e.cls ? ' en ' + e.cls : ''}` : '';
    if (e.pos && e.pos !== e.cpos) out += ` · P${e.pos} au général`;
    if (s.type === 'R' && e.status && e.status !== 'Finished Normally' && e.status !== 'None') out += ` · ${e.status}`;
    return out;
}

/* ── Graphique : violons dans l'ordre chronologique + moyennes reliées + tendance ── */
function histChartSvg(slots, series, mode, withDots) {
    const fmt = mode === 'gap' ? v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%` : paceFmtLap;
    // Échelle : 99 % des tours (quelques tours extrêmes écraseraient tout le reste), moyennes toujours visibles.
    const allV = slots.flatMap(s => s.items.flatMap(p => p.vals)).sort((a, b) => a - b);
    let lo = paceQuantile(allV, 0.005), hi = paceQuantile(allV, 0.99);
    slots.forEach(s => s.items.forEach(p => { lo = Math.min(lo, p.q1, p.mean); hi = Math.max(hi, p.q3, p.mean); }));
    const pad = Math.max(mode === 'gap' ? 0.1 : 0.15, (hi - lo) * 0.06);
    const yMin = lo - pad, yMax = hi + pad;
    const ml = 72, mr = 16, mt = 26, mb = 50, H = 430;
    const vw = series.length > 1 ? 36 : 48, gap = 18;
    let xCur = ml + 10;
    slots.forEach(s => {
        s.x0 = xCur;
        s.items.forEach((p, i) => { p.cx = xCur + vw * (i + 0.5); });
        s.w = vw * s.items.length;
        s.cx = xCur + s.w / 2;
        xCur += s.w + gap;
    });
    const W = Math.max(560, xCur - gap + 10 + mr);
    const y = v => mt + (yMax - v) / (yMax - yMin) * (H - mt - mb);
    const fluid = W <= 1100;
    const color = new Map(series.map(s => [s.dk, s.color]));
    const nameOf = new Map(series.map(s => [s.dk, s.name]));
    let svg = `<svg viewBox="0 0 ${W} ${H}" class="pace-svg${fluid ? ' pace-svg-fluid' : ''}" ${fluid ? '' : `width="${W}" height="${H}"`} role="img" aria-label="Évolution du rythme des pilotes dans le temps">`;
    svg += paceYAxis(yMin, yMax, y, ml, W - mr, fmt);
    svg += `<clipPath id="histClip"><rect x="${ml}" y="${mt}" width="${W - ml - mr}" height="${H - mt - mb}"/></clipPath>`;

    // Séparateurs de mois (repères de temps sur un axe qui ne suit que l'ordre des sessions).
    let prevMonth = null, labelEnd = -Infinity;
    slots.forEach(s => {
        const mk = histMonthKey(s.ts);
        if (mk !== prevMonth) {
            const x = s.x0 - gap / 2;
            if (prevMonth !== null) svg += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${mt - 14}" y2="${H - mb}" class="hist-month-line"/>`;
            const label = histFmtMonth(s.ts);
            if (_hist.group !== 'month' && x + 4 >= labelEnd) {   // pas de chevauchement entre deux mois serrés
                svg += `<text x="${(x + 4).toFixed(1)}" y="${mt - 10}" class="hist-month-label">${label}</text>`;
                labelEnd = x + 4 + label.length * 6.6 + 6;
            }
            prevMonth = mk;
        }
    });

    // Violons, boîtes, tours (coupés au cadre : les tours hors échelle ne débordent pas).
    svg += '<g clip-path="url(#histClip)">';
    slots.forEach(s => s.items.forEach(p => {
        const c = color.get(p.dk);
        const half = vw * 0.44;
        const t = p.vals;
        if (t.length >= 3) {
            const sd = paceSd(t) || 0.05;
            const h = Math.max(mode === 'gap' ? 0.02 : 0.03, 1.06 * sd * Math.pow(t.length, -0.2));
            const a = Math.max(yMin, t[0] - 2.5 * h), b = Math.min(yMax, t[t.length - 1] + 2.5 * h);
            const pts = [];
            for (let k = 0; k <= 40; k++) {
                const v = a + (b - a) * k / 40;
                pts.push([v, t.reduce((acc, x) => acc + Math.exp(-0.5 * ((v - x) / h) ** 2), 0)]);
            }
            const dMax = Math.max(...pts.map(q => q[1]));
            const right = pts.map(([v, dd]) => `${(p.cx + dd / dMax * half).toFixed(1)},${y(v).toFixed(1)}`);
            const left = pts.slice().reverse().map(([v, dd]) => `${(p.cx - dd / dMax * half).toFixed(1)},${y(v).toFixed(1)}`);
            svg += `<polygon points="${right.concat(left).join(' ')}" fill="${c}" fill-opacity="0.45" stroke="${c}" stroke-width="1"/>`;
        }
        const iqr = p.q3 - p.q1;
        const wLo = t.find(v => v >= p.q1 - 1.5 * iqr), wHi = [...t].reverse().find(v => v <= p.q3 + 1.5 * iqr);
        svg += `<line x1="${p.cx}" x2="${p.cx}" y1="${y(wLo).toFixed(1)}" y2="${y(wHi).toFixed(1)}" class="pace-box-line"/>
                <rect x="${p.cx - 5}" y="${y(p.q3).toFixed(1)}" width="10" height="${Math.max(1, y(p.q1) - y(p.q3)).toFixed(1)}" class="pace-box"/>
                <line x1="${p.cx - 5}" x2="${p.cx + 5}" y1="${y(p.median).toFixed(1)}" y2="${y(p.median).toFixed(1)}" class="pace-median"/>`;
        if (withDots) {
            p.laps.forEach((l, j) => {
                const jitter = (((j * 7919) % 97) / 97 - 0.5) * half * 0.9;
                const tip = [nameOf.get(p.dk), `${histFmtDate(l.s.ts)} · ${HIST_TYPES[l.s.type] || ''}`,
                    `Temps : ${paceFmtLap(l.t)}`, mode === 'gap' ? `Écart : ${fmt(l.v)}` : '', `Gomme : ${paceCompoundLabel(l.c)}`];
                if (l.v < yMin || l.v > yMax) return;
                svg += `<circle cx="${(p.cx + jitter).toFixed(1)}" cy="${y(l.v).toFixed(1)}" r="2.6" fill="${PACE_COMPOUND_COLORS[l.c] || '#888'}" class="pace-dot hist-lap" ${paceTipAttr(tip, c)}/>`;
            });
        }
    }));
    svg += '</g>';

    // Lignes : moyennes reliées dans l'ordre chronologique, puis tendance (régression sur le temps réel).
    series.forEach(sr => {
        const pts = sr.pts.filter(p => p.cx != null);
        if (pts.length >= 2) {
            svg += `<polyline points="${pts.map(p => `${p.cx.toFixed(1)},${y(p.mean).toFixed(1)}`).join(' ')}" fill="none" stroke="${sr.color}" stroke-width="2.2" stroke-linejoin="round" class="hist-mean-line"/>`;
            const fit = histFit(pts);
            if (fit) {
                svg += `<polyline points="${pts.map(p => `${p.cx.toFixed(1)},${y(fit.at(p.ts)).toFixed(1)}`).join(' ')}" fill="none" stroke="${sr.color}" stroke-width="2" stroke-dasharray="7 5" class="hist-trend-line"/>`;
            }
        }
    });
    slots.forEach(s => s.items.forEach(p => {
        svg += `<circle cx="${p.cx.toFixed(1)}" cy="${y(p.mean).toFixed(1)}" r="5" fill="${color.get(p.dk)}" class="pace-dot hist-mean" ${paceTipAttr(histPointTip(p, mode, nameOf.get(p.dk)), color.get(p.dk))}/>`;
    }));

    // Libellés sous chaque colonne.
    slots.forEach(s => {
        const first = s.items[0].parts[0].s;
        const l1 = _hist.group === 'session' ? histFmtDate(s.ts)
            : _hist.group === 'month' ? histFmtMonth(s.ts).replace(/ (\d\d)(\d\d)$/, ' $2')
            : histFmtDate(s.ts);
        const nSess = new Set(s.items.flatMap(p => p.parts.map(x => x.s.key))).size;
        const l2 = _hist.group === 'session' ? (HIST_TYPES[first.type] || first.type) : `${nSess} sess.`;
        svg += `<text x="${s.cx.toFixed(1)}" y="${H - mb + 16}" class="pace-tick" text-anchor="middle">${paceEsc(l1)}</text>
                <text x="${s.cx.toFixed(1)}" y="${H - mb + 30}" class="pace-tick hist-sub" text-anchor="middle">${paceEsc(l2)}</text>`;
    });
    return svg + '</svg>';
}

/* ── Tableaux ── */
function histSummaryTable(series, mode) {
    const fmt = histFmtVal(mode);
    const rows = series.filter(s => s.pts.length);
    if (!rows.length) return '';
    const unit = mode === 'gap' ? 'pt' : 's';
    return `<div class="pace-table-wrap"><table class="pace-table">
        <thead><tr><th>Pilote</th><th>${_hist.group === 'session' ? 'Sessions' : 'Périodes'}</th><th>Période</th><th>Première moyenne</th><th>Dernière moyenne</th><th>Évolution</th><th>Tendance / mois</th><th>Meilleure moyenne</th></tr></thead>
        <tbody>${rows.map(s => {
            const first = s.pts[0], last = s.pts[s.pts.length - 1];
            const bestP = s.pts.reduce((a, p) => p.mean < a.mean ? p : a, s.pts[0]);
            const fit = s.pts.length >= 3 ? histFit(s.pts) : null;
            const delta = last.mean - first.mean;
            const trend = fit ? fit.b * 30.44 : null;
            const cls = v => v == null ? '' : v < 0 ? 'hist-better' : v > 0 ? 'hist-worse' : '';
            const sign = v => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(mode === 'gap' ? 2 : 3)} ${unit}`;
            return `<tr>
                <td><i class="pace-swatch" style="background:${s.color}"></i>${paceEsc(s.name)}</td>
                <td>${s.pts.length}</td>
                <td>${histFmtDate(first.ts)} → ${histFmtDate(last.ts)}</td>
                <td>${fmt(first.mean)}</td>
                <td>${fmt(last.mean)}</td>
                <td class="${s.pts.length > 1 ? cls(delta) : ''}">${s.pts.length > 1 ? sign(delta) : '—'}</td>
                <td class="${cls(trend)}">${trend != null ? sign(trend) : '—'}</td>
                <td>${fmt(bestP.mean)} <span class="pace-muted">(${histFmtDate(bestP.ts)})</span></td>
            </tr>`;
        }).join('')}</tbody></table></div>
        <div class="pace-muted" style="margin-top:6px;">Négatif = plus rapide. La tendance est une régression linéaire des moyennes sur le temps réel (au moins 3 points).</div>`;
}

function histPalmaresTable(points, series, mode) {
    const fmt = histFmtVal(mode);
    const color = new Map(series.map(s => [s.dk, s.color]));
    const nameOf = new Map(series.map(s => [s.dk, s.name]));
    const rows = points.slice().sort((a, b) => b.ts - a.ts);
    const max = 400;
    const bySession = _hist.group === 'session';
    const uniq = list => Array.from(new Set(list.filter(Boolean)));
    return `<div class="pace-table-wrap hist-palmares"><table class="pace-table">
        <thead><tr><th>Date</th><th>Pilote</th><th>Circuit</th><th>${bySession ? 'Session' : 'Sessions'}</th><th>Voiture</th><th>Moyenne</th><th>Meilleur tour</th><th>Écart-type</th><th>Tours</th>${bySession ? '<th>Résultat</th>' : ''}</tr></thead>
        <tbody>${rows.slice(0, max).map(p => {
            const s = p.parts[0].s;
            return `<tr>
                <td>${bySession ? histFmtDate(p.ts) : paceEsc(histGroupLabel(p.ts))}</td>
                <td><i class="pace-swatch" style="background:${color.get(p.dk)}"></i>${paceEsc(nameOf.get(p.dk))}</td>
                ${histListCell(p.parts.map(x => x.s.course), 'circuits')}
                <td>${bySession ? paceEsc(HIST_TYPES[s.type] || s.type) : uniq(p.parts.map(x => x.s.key)).length}</td>
                ${histListCell(p.parts.map(x => x.e.car), 'voitures')}
                <td>${fmt(p.mean)}</td>
                <td>${histOneCourse(p) ? paceFmtLap(p.bestLap) : '—'}</td>
                <td>${p.sd.toFixed(mode === 'gap' ? 2 : 3)}${mode === 'gap' ? ' pt' : 's'}</td>
                <td>${p.vals.length}</td>
                ${bySession ? `<td>${paceEsc(histResult(p.parts[0])) || '—'}</td>` : ''}
            </tr>`;
        }).join('')}</tbody></table></div>
        ${rows.length > max ? `<div class="pace-muted" style="margin-top:6px;">${rows.length - max} lignes plus anciennes non affichées.</div>` : ''}`;
}

/* ── Actions de l'interface ── */
function histSet(k, v) {
    if (k === 'threshold') v = Math.max(0.5, Math.min(15, parseFloat(v) || 4));
    if (k === 'months') v = parseInt(v, 10) || 0;
    _hist[k] = v;
    histSaveUi();
    renderHistoryTab();
}
function histToggleType(t, on) {
    _hist.types = _hist.types.filter(x => x !== t);
    if (on) _hist.types.push(t);
    histSaveUi();
    renderHistoryTab();
}
function histToggleDriver(k, on) {
    _hist.selected = _hist.selected.filter(x => x !== k);
    if (on) _hist.selected.push(k);
    _hist.selectionTouched = true;
    histSaveUi();
    renderHistoryTab();
}
function histSetSearch(v) {
    _hist.search = v;
    histRenderDriverList(histDriverIndex(histVisibleSessions()));
}

/* ══════════ INITIALISATION ══════════ */
async function initHistoryTab() {
    histLoadUi();
    const input = document.getElementById('histFileInput');
    const dir = document.getElementById('histDirInput');
    const drop = document.getElementById('histDropZone');
    if (input) input.addEventListener('change', () => { histImportFiles(input.files); input.value = ''; });
    if (dir) dir.addEventListener('change', () => { histImportFiles(dir.files); dir.value = ''; });
    if (drop) {
        ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('drag'); }));
        ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('drag'); }));
        drop.addEventListener('drop', e => { histFilesFromDrop(e.dataTransfer).then(histImportFiles); });
    }
    try {
        _histData.db = await histOpenDb();
        _histData.sessions = ((await histDbAll()) || []).sort((a, b) => a.ts - b.ts);
    } catch (err) {
        _histData.error = 'Base locale indisponible (' + (err?.message || err) + ') : les imports ne seront pas conservés.';
    }
    _histData.loaded = true;
    renderHistoryTab();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initHistoryTab);
else initHistoryTab();
