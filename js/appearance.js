/* Apparence personnelle : thème (prédéfini ou créé par l'utilisateur), couleur d'accent, police, taille du texte.
   Stocké dans le navigateur de l'utilisateur (chaque membre a son propre rendu).
   Chargé dans le <head> pour appliquer le thème avant le premier affichage (pas de flash). */
(function () {
    'use strict';
    const KEY = 'lmu.appearance.v1';
    const MAX_CUSTOM = 12;

    const THEMES = [
        { id: 'lmu',       name: 'LMU Classique', mode: 'dark',  c: ['#1e2646', '#16213e', '#00ff88'] },
        { id: 'midnight',  name: 'Midnight',      mode: 'dark',  c: ['#07080d', '#000000', '#4da3ff'] },
        { id: 'lemans',    name: 'Le Mans',       mode: 'dark',  c: ['#12234a', '#0a1530', '#ffc83d'] },
        { id: 'endurance', name: 'Endurance',     mode: 'dark',  c: ['#2b1a1d', '#171012', '#ff4d4d'] },
        { id: 'foret',     name: 'Forêt',         mode: 'dark',  c: ['#17301f', '#0d1d13', '#7bd88f'] },
        { id: 'violet',    name: 'Violet néon',   mode: 'dark',  c: ['#261a45', '#150d29', '#c77dff'] },
        { id: 'paddock',   name: 'Paddock (clair)', mode: 'light', c: ['#eef1f7', '#dce3ef', '#0a8f56'] },
        { id: 'contraste', name: 'Contraste élevé', mode: 'dark', c: ['#000000', '#000000', '#ffee00'] }
    ];

    /* Uniquement des polices installées sur le poste (l'app doit marcher hors ligne).
       Une police absente du poste retombe sur la suivante de la liste. */
    const FONTS = [
        { id: 'segoe',     g: 'Sans-serif', name: 'Segoe UI (défaut)', css: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif" },
        { id: 'system',    g: 'Sans-serif', name: 'Police du système', css: "system-ui, -apple-system, 'Segoe UI', sans-serif" },
        { id: 'bahn',      g: 'Sans-serif', name: 'Bahnschrift (course)', css: "Bahnschrift, 'DIN Alternate', 'Segoe UI', sans-serif" },
        { id: 'arial',     g: 'Sans-serif', name: 'Arial', css: "Arial, Helvetica, sans-serif" },
        { id: 'tahoma',    g: 'Sans-serif', name: 'Tahoma', css: "Tahoma, Geneva, sans-serif" },
        { id: 'verdana',   g: 'Sans-serif', name: 'Verdana (lisible)', css: "Verdana, Geneva, sans-serif" },
        { id: 'trebuchet', g: 'Sans-serif', name: 'Trebuchet MS', css: "'Trebuchet MS', 'Segoe UI', sans-serif" },
        { id: 'calibri',   g: 'Sans-serif', name: 'Calibri', css: "Calibri, Carlito, 'Segoe UI', sans-serif" },
        { id: 'candara',   g: 'Sans-serif', name: 'Candara', css: "Candara, Calibri, 'Segoe UI', sans-serif" },
        { id: 'corbel',    g: 'Sans-serif', name: 'Corbel', css: "Corbel, Calibri, 'Segoe UI', sans-serif" },
        { id: 'century',   g: 'Sans-serif', name: 'Century Gothic', css: "'Century Gothic', 'Segoe UI', sans-serif" },
        { id: 'franklin',  g: 'Sans-serif', name: 'Franklin Gothic', css: "'Franklin Gothic Medium', 'Arial Narrow', Arial, sans-serif" },
        { id: 'gill',      g: 'Sans-serif', name: 'Gill Sans', css: "'Gill Sans MT', 'Gill Sans', Calibri, sans-serif" },
        { id: 'lucida',    g: 'Sans-serif', name: 'Lucida Sans', css: "'Lucida Sans Unicode', 'Lucida Grande', sans-serif" },
        { id: 'georgia',   g: 'Serif', name: 'Georgia', css: "Georgia, 'Times New Roman', serif" },
        { id: 'cambria',   g: 'Serif', name: 'Cambria', css: "Cambria, Georgia, serif" },
        { id: 'constantia', g: 'Serif', name: 'Constantia', css: "Constantia, Georgia, serif" },
        { id: 'palatino',  g: 'Serif', name: 'Palatino', css: "'Palatino Linotype', Palatino, 'Book Antiqua', serif" },
        { id: 'times',     g: 'Serif', name: 'Times New Roman', css: "'Times New Roman', Times, serif" },
        { id: 'consolas',  g: 'Monospace', name: 'Consolas', css: "Consolas, 'Cascadia Mono', 'Courier New', monospace" },
        { id: 'cascadia',  g: 'Monospace', name: 'Cascadia Code', css: "'Cascadia Code', 'Cascadia Mono', Consolas, monospace" },
        { id: 'lucidacon', g: 'Monospace', name: 'Lucida Console', css: "'Lucida Console', Monaco, monospace" },
        { id: 'courier',   g: 'Monospace', name: 'Courier New', css: "'Courier New', Courier, monospace" },
        { id: 'impact',    g: 'Fantaisie', name: 'Impact', css: "Impact, 'Arial Narrow Bold', sans-serif" },
        { id: 'comic',     g: 'Fantaisie', name: 'Comic Sans MS', css: "'Comic Sans MS', 'Comic Neue', cursive" },
        { id: 'segoeprint', g: 'Fantaisie', name: 'Segoe Print (manuscrit)', css: "'Segoe Print', 'Segoe Script', cursive" }
    ];
    const FONT_GROUPS = ['Sans-serif', 'Serif', 'Monospace', 'Fantaisie'];

    const DEFAULTS = { theme: 'lmu', accent: '', font: 'segoe', fontCustom: '', scale: 100, custom: [] };
    const HEX = /^#[0-9a-f]{6}$/i;
    const ALL_VARS = ['--bg-1', '--bg-2', '--accent', '--accent-2', '--accent-rgb', '--text', '--text-2', '--text-3', '--text-4',
        '--fg-rgb', '--panel-bg', '--bar-bg', '--input-bg', '--option-bg'];

    function cleanCustom(list) {
        if (!Array.isArray(list)) return [];
        return list.filter(t => t && typeof t.id === 'string' && ['bg1', 'bg2', 'accent', 'text'].every(k => HEX.test(t[k])))
            .slice(0, MAX_CUSTOM)
            .map(t => ({ id: t.id.replace(/[^\w-]/g, ''), name: String(t.name || 'Mon thème').slice(0, 30),
                         bg1: t.bg1, bg2: t.bg2, accent: t.accent, text: t.text }));
    }

    function load() {
        try {
            const s = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(KEY) || '{}'));
            s.custom = cleanCustom(s.custom);
            const known = THEMES.some(t => t.id === s.theme) || s.custom.some(t => 'custom:' + t.id === s.theme);
            if (!known) s.theme = DEFAULTS.theme;
            if (!FONTS.some(f => f.id === s.font)) s.font = DEFAULTS.font;
            s.fontCustom = String(s.fontCustom || '').replace(/[^\w \-]/g, '').slice(0, 40).trim();
            s.scale = Math.min(130, Math.max(85, Number(s.scale) || 100));
            if (!HEX.test(s.accent)) s.accent = '';
            return s;
        } catch (e) { return JSON.parse(JSON.stringify(DEFAULTS)); }
    }
    function save(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* stockage indisponible */ } }

    /* ── Couleurs ── */
    const rgbOf = hex => { const n = parseInt(hex.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
    const toHex = c => '#' + c.map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
    const mix = (a, b, t) => { const x = rgbOf(a), y = rgbOf(b); return toHex(x.map((v, i) => v + (y[i] - v) * t)); };
    const shade = (hex, f) => 'rgb(' + rgbOf(hex).map(v => Math.round(v * f)).join(',') + ')';
    const lum = hex => { const [r, g, b] = rgbOf(hex); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };

    /* Déduit toutes les variables d'un thème à partir de 4 couleurs. */
    function deriveVars(t) {
        const light = lum(t.bg1) > 0.5;
        const text = t.text;
        return {
            mode: light ? 'light' : 'dark',
            vars: {
                '--bg-1': t.bg1, '--bg-2': t.bg2,
                '--accent': t.accent, '--accent-2': shade(t.accent, 0.8), '--accent-rgb': rgbOf(t.accent).join(', '),
                '--text': text,
                '--text-2': mix(text, t.bg2, 0.2), '--text-3': mix(text, t.bg2, 0.4), '--text-4': mix(text, t.bg2, 0.55),
                '--fg-rgb': rgbOf(text).join(', '),
                '--panel-bg': light ? 'rgba(255, 255, 255, 0.55)' : 'rgba(0, 0, 0, 0.244)',
                '--bar-bg': 'rgba(' + rgbOf(t.bg2).join(', ') + ', 0.97)',
                '--input-bg': light ? '#ffffff' : mix(t.bg2, '#000000', 0.45),
                '--option-bg': light ? '#ffffff' : t.bg1
            }
        };
    }

    function resolveTheme(s) {
        if (s.theme.startsWith('custom:')) {
            const t = s.custom.find(c => 'custom:' + c.id === s.theme);
            if (t) return { custom: t };
        }
        return { builtin: THEMES.find(t => t.id === s.theme) || THEMES[0] };
    }

    let state = load();
    let draft = null;   // thème en cours d'édition (aperçu en direct, non enregistré)

    function apply(s) {
        const root = document.documentElement, st = root.style;
        ALL_VARS.forEach(p => st.removeProperty(p));
        st.removeProperty('color-scheme');
        const r = draft ? { custom: draft } : resolveTheme(s);
        if (r.custom) {
            const d = deriveVars(r.custom);
            root.dataset.theme = 'custom';
            root.dataset.mode = d.mode;
            Object.keys(d.vars).forEach(k => st.setProperty(k, d.vars[k]));
            st.setProperty('color-scheme', d.mode);
        } else {
            root.dataset.theme = r.builtin.id;
            root.dataset.mode = r.builtin.mode;
        }
        if (s.accent) {
            st.setProperty('--accent', s.accent);
            st.setProperty('--accent-2', shade(s.accent, 0.8));
            st.setProperty('--accent-rgb', rgbOf(s.accent).join(', '));
        }
        st.setProperty('--font-ui', fontCss(s));
        st.setProperty('--ui-scale', String(s.scale / 100));
    }
    function fontCss(s) {
        const base = FONTS.find(f => f.id === s.font).css;
        return s.fontCustom ? '"' + s.fontCustom + '", ' + base : base;
    }
    apply(state);

    function update(patch) { state = Object.assign({}, state, patch); save(state); apply(state); render(); }

    /* Couleurs de base du thème actuellement affiché (point de départ d'un nouveau thème) */
    function currentColors() {
        const r = resolveTheme(state);
        if (r.custom) return { bg1: r.custom.bg1, bg2: r.custom.bg2, accent: r.custom.accent, text: r.custom.text };
        const t = r.builtin;
        return { bg1: t.c[0], bg2: t.c[1], accent: t.c[2], text: t.mode === 'light' ? '#14203a' : '#ffffff' };
    }

    const newId = () => 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    /* Code de partage : le thème en JSON encodé base64 (UTF-8 sûr) */
    function encodeTheme(t) {
        const json = JSON.stringify({ n: t.name, b1: t.bg1, b2: t.bg2, a: t.accent, t: t.text });
        return 'LMUTHEME:' + btoa(unescape(encodeURIComponent(json)));
    }
    function decodeTheme(code) {
        try {
            const o = JSON.parse(decodeURIComponent(escape(atob(String(code).trim().replace(/^LMUTHEME:/, '')))));
            const t = { id: newId(), name: String(o.n || 'Thème importé').slice(0, 30), bg1: o.b1, bg2: o.b2, accent: o.a, text: o.t };
            return cleanCustom([t])[0] || null;
        } catch (e) { return null; }
    }

    /* ── Interface ── */
    let overlay = null;
    let message = '';

    function swatch(c) { return '<div class="ap-swatch">' + c.map(x => '<span style="background:' + x + '"></span>').join('') + '</div>'; }

    function render() {
        if (!overlay) return;
        const panel = overlay.querySelector('#appearancePanel');
        panel.innerHTML = draft ? renderEditor() : renderMain();
    }

    function renderMain() {
        const themeBtns = THEMES.map(t =>
            '<button class="ap-theme' + (t.id === state.theme ? ' active' : '') + '" data-theme-id="' + t.id + '">' +
            swatch(t.c) + esc(t.name) + '</button>').join('');
        const customBtns = state.custom.map(t => {
            const id = 'custom:' + t.id, on = id === state.theme;
            return '<div class="ap-theme' + (on ? ' active' : '') + '" data-theme-id="' + id + '" role="button" tabindex="0">' +
                swatch([t.bg1, t.bg2, t.accent, t.text]) + esc(t.name) +
                (on ? '<div class="ap-mini"><button data-act="edit">✏️ Modifier</button><button data-act="share">📋 Code</button><button data-act="delete">🗑️</button></div>' : '') +
                '</div>';
        }).join('');
        const fontOpts = FONT_GROUPS.map(g => '<optgroup label="' + g + '">' + FONTS.filter(f => f.g === g).map(f =>
            '<option value="' + f.id + '" style="font-family:' + f.css.replace(/"/g, "'") + ' !important"' +
            (f.id === state.font ? ' selected' : '') + '>' + f.name + '</option>').join('') + '</optgroup>').join('');
        const accentNow = state.accent || getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
        return '<div class="ap-head"><h2>🎨 Apparence</h2><button class="ap-close" data-act="close">Fermer ✕</button></div>' +
            '<div style="color:var(--text-3);font-size:0.85em;">Ces réglages sont personnels : ils ne changent que votre affichage.</div>' +
            '<h3>Thèmes</h3><div class="ap-themes">' + themeBtns + '</div>' +
            '<h3>Mes thèmes (' + state.custom.length + '/' + MAX_CUSTOM + ')</h3>' +
            '<div class="ap-themes">' + customBtns + '</div>' +
            '<div class="ap-row" style="margin-top:10px;">' +
            (state.custom.length < MAX_CUSTOM ? '<button class="ap-reset" data-act="create">＋ Créer un thème</button>' : '') +
            '<button class="ap-reset" data-act="import">📥 Importer un code</button></div>' +
            (message ? '<div class="ap-msg">' + esc(message) + '</div>' : '') +
            '<h3>Couleur d\'accent</h3><div class="ap-row">' +
            '<input type="color" id="apAccent" value="' + (HEX.test(accentNow) ? accentNow : '#00ff88') + '">' +
            '<span style="color:var(--text-3);font-size:0.85em;">' + (state.accent ? 'Personnalisée (prime sur le thème)' : 'Celle du thème') + '</span>' +
            (state.accent ? '<button class="ap-reset" data-act="reset-accent">Revenir à celle du thème</button>' : '') + '</div>' +
            '<h3>Police</h3><div class="ap-row"><select id="apFont">' + fontOpts + '</select>' +
            '<input type="text" id="apFontCustom" class="ap-text" placeholder="ou nom d\'une police installée" maxlength="40" value="' + esc(state.fontCustom) + '"></div>' +
            '<div class="ap-sample">Stratégie 24h — Relais 3 · 1:45.320 · Pit stop dans 4 tours</div>' +
            '<h3>Taille du texte : <span id="apScaleVal">' + state.scale + '</span> %</h3>' +
            '<div class="ap-row"><input type="range" id="apScale" min="85" max="130" step="5" value="' + state.scale + '"></div>' +
            '<div style="margin-top:18px;text-align:right;"><button class="ap-reset" data-act="reset-all">Tout réinitialiser</button></div>';
    }

    function renderEditor() {
        const d = draft;
        const field = (k, label) => '<label class="ap-field"><input type="color" data-k="' + k + '" value="' + d[k] + '"><span>' + label + '</span></label>';
        return '<div class="ap-head"><h2>' + (d._isNew ? '🎨 Nouveau thème' : '🎨 Modifier le thème') + '</h2></div>' +
            '<h3>Nom</h3><div class="ap-row"><input type="text" id="apName" class="ap-text" maxlength="30" value="' + esc(d.name) + '" style="flex:1"></div>' +
            '<h3>Couleurs <span style="text-transform:none;letter-spacing:0;">(aperçu en direct)</span></h3>' +
            '<div class="ap-fields">' + field('bg1', 'Fond (haut)') + field('bg2', 'Fond (bas, panneaux)') + field('accent', 'Accent') + field('text', 'Texte') + '</div>' +
            '<div class="ap-sample">Stratégie 24h — Relais 3 · <b style="color:var(--accent)">1:45.320</b> · Pit stop dans 4 tours</div>' +
            '<div style="margin-top:18px;display:flex;gap:10px;justify-content:flex-end;">' +
            '<button class="ap-reset" data-act="cancel-edit">Annuler</button>' +
            '<button class="ap-reset ap-primary" data-act="save-edit">Enregistrer</button></div>';
    }

    function open() { message = ''; render(); overlay.classList.add('open'); }
    function close() { if (draft) { draft = null; apply(state); } overlay.classList.remove('open'); }

    function startEdit(base, isNew) {
        draft = Object.assign({ _isNew: isNew }, base);
        apply(state); render();
    }

    function build() {
        const bar = document.getElementById('sessionBar');
        const btn = document.createElement('button');
        btn.id = 'appearanceBtn';
        btn.title = 'Thème, couleur, police';
        btn.textContent = '🎨 Apparence';
        btn.addEventListener('click', open);
        const right = bar && bar.querySelector('div[style*="margin-left:auto"]');
        if (right) right.insertBefore(btn, right.firstChild);
        else document.body.appendChild(btn);

        overlay = document.createElement('div');
        overlay.id = 'appearanceOverlay';
        overlay.innerHTML = '<div id="appearancePanel"></div>';
        document.body.appendChild(overlay);

        const selected = () => state.custom.find(t => 'custom:' + t.id === state.theme);

        overlay.addEventListener('click', e => {
            if (e.target === overlay) return close();
            const act = e.target.closest('[data-act]');
            if (act) {
                message = '';
                switch (act.dataset.act) {
                    case 'close': return close();
                    case 'reset-accent': return update({ accent: '' });
                    case 'reset-all': return update(JSON.parse(JSON.stringify(Object.assign({}, DEFAULTS, { custom: state.custom }))));
                    case 'create': return startEdit(Object.assign({ name: 'Mon thème' }, currentColors()), true);
                    case 'edit': { const t = selected(); if (t) startEdit(t, false); return; }
                    case 'delete': {
                        const t = selected();
                        if (t && confirm('Supprimer le thème « ' + t.name + ' » ?'))
                            update({ custom: state.custom.filter(c => c !== t), theme: DEFAULTS.theme });
                        return;
                    }
                    case 'share': {
                        const t = selected(); if (!t) return;
                        const code = encodeTheme(t);
                        (navigator.clipboard ? navigator.clipboard.writeText(code) : Promise.reject()).then(
                            () => { message = 'Code copié : collez-le à un coéquipier (bouton « Importer un code »).'; render(); },
                            () => { prompt('Copiez ce code de partage :', code); });
                        return;
                    }
                    case 'import': {
                        const code = prompt('Collez le code de partage du thème :');
                        if (!code) return;
                        const t = decodeTheme(code);
                        if (!t) { message = 'Code invalide.'; return render(); }
                        if (state.custom.length >= MAX_CUSTOM) { message = 'Limite de ' + MAX_CUSTOM + ' thèmes atteinte.'; return render(); }
                        return update({ custom: state.custom.concat(t), theme: 'custom:' + t.id });
                    }
                    case 'cancel-edit': draft = null; apply(state); return render();
                    case 'save-edit': {
                        const t = { id: draft._isNew ? newId() : draft.id, name: (draft.name || '').trim() || 'Mon thème',
                                    bg1: draft.bg1, bg2: draft.bg2, accent: draft.accent, text: draft.text };
                        draft = null;
                        const list = state.custom.some(c => c.id === t.id) ? state.custom.map(c => c.id === t.id ? t : c) : state.custom.concat(t);
                        return update({ custom: list, theme: 'custom:' + t.id });
                    }
                }
                return;
            }
            const themeEl = e.target.closest('[data-theme-id]');
            if (themeEl) update({ theme: themeEl.dataset.themeId });
        });
        overlay.addEventListener('change', e => {
            if (e.target.id === 'apAccent') update({ accent: e.target.value });
            else if (e.target.id === 'apFont') update({ font: e.target.value });
            else if (e.target.id === 'apFontCustom') update({ fontCustom: e.target.value.replace(/[^\w \-]/g, '').trim() });
        });
        overlay.addEventListener('input', e => {
            if (e.target.id === 'apScale') {
                // Aperçu en direct sans reconstruire le panneau (le curseur reste saisi)
                const v = Number(e.target.value);
                state = Object.assign({}, state, { scale: v });
                save(state); apply(state);
                overlay.querySelector('#apScaleVal').textContent = v;
            } else if (draft && e.target.dataset && e.target.dataset.k) {
                draft[e.target.dataset.k] = e.target.value;
                apply(state);
            } else if (draft && e.target.id === 'apName') {
                draft.name = e.target.value;
            }
        });
        overlay.addEventListener('keydown', e => {
            if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('div.ap-theme')) { e.preventDefault(); e.target.click(); }
        });
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && overlay.classList.contains('open')) close(); });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
    else build();

    window.LMUAppearance = { open, close, state: () => JSON.parse(JSON.stringify(state)) };
})();
