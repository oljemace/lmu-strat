/* ══════════════════════════════════════════════════════════════
   chat-files.js — Images et pièces jointes du chat d'équipe

   Les fichiers (50 Mo max) sont envoyés dans Firebase Storage sous
     chat/{équipe}/{uid de l'auteur}/{identifiant}-{nom}
   et le message du chat garde seulement une référence :
     file = { path, name, size, type }
   Une pièce jointe par message. On peut la choisir (📎), la coller (Ctrl+V,
   capture d'écran ou fichier copié) ou la glisser sur le panneau.
   Les images PNG/JPEG/GIF/WebP s'affichent dans le message ; les autres types
   s'affichent comme un bouton de téléchargement (jamais exécutés dans la page).
   Quand un message quitte le tampon circulaire (ou est supprimé), son fichier
   est supprimé aussi.
   ══════════════════════════════════════════════════════════════ */

const CHAT_FILE_MAX = 50 * 1024 * 1024;
const CHAT_IMG_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

let _chatPending = null;          // File en attente d'envoi
let _chatPendingThumb = null;     // URL locale de l'aperçu
let _chatUploading = false;
const _chatUrlCache = new Map();  // path → Promise<url>

function _chatStorageOk() {
    return !!(window._fbStorage && window._fbStorageRef && window._fbUploadBytesResumable && window._fbGetDownloadURL);
}

function _chatFmtSize(n) {
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1) + ' Mo';
    if (n >= 1024) return Math.round(n / 1024) + ' Ko';
    return n + ' o';
}

function _chatAttachClear() {
    if (_chatPendingThumb) { try { URL.revokeObjectURL(_chatPendingThumb); } catch (e) { /* sans conséquence */ } }
    _chatPending = null;
    _chatPendingThumb = null;
    _chatAttachRender();
}

function _chatAttachSet(file) {
    if (!file) return;
    if (!_chatStorageOk()) { _chatError('Les pièces jointes ne sont pas disponibles pour le moment.'); return; }
    if (file.size === 0) { _chatError('Ce fichier est vide.'); return; }
    if (file.size > CHAT_FILE_MAX) {
        _chatError(`Fichier trop volumineux (${_chatFmtSize(file.size)}) : 50 Mo maximum.`);
        return;
    }
    _chatError('');
    // Une image collée s'appelle toujours « image.png » : on lui donne un nom daté
    if (/^image\.(png|jpe?g|gif|webp)$/i.test(file.name)) {
        const d = new Date(), p = n => String(n).padStart(2, '0');
        const ext = file.name.split('.').pop().toLowerCase();
        file = new File([file], `image-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`,
            { type: file.type });
    }
    _chatAttachClear();
    _chatPending = file;
    if (CHAT_IMG_TYPES.includes(file.type)) _chatPendingThumb = URL.createObjectURL(file);
    _chatAttachRender();
    document.getElementById('teamChatInput')?.focus();
}

function _chatAttachRender(progress) {
    const el = document.getElementById('teamChatAttach');
    if (!el) return;
    el.textContent = '';
    if (!_chatPending) { el.style.display = 'none'; return; }
    el.style.display = 'flex';
    if (_chatPendingThumb) {
        const img = document.createElement('img');
        img.src = _chatPendingThumb;
        img.alt = '';
        el.appendChild(img);
    } else {
        const ic = document.createElement('span');
        ic.textContent = '📎';
        el.appendChild(ic);
    }
    const info = document.createElement('div');
    info.className = 'attach-info';
    const nm = document.createElement('b');
    nm.textContent = _chatPending.name;
    const sz = document.createElement('span');
    sz.textContent = typeof progress === 'number'
        ? `Envoi… ${progress} %`
        : _chatFmtSize(_chatPending.size);
    info.appendChild(nm);
    info.appendChild(sz);
    el.appendChild(info);
    if (!_chatUploading) {
        const x = document.createElement('button');
        x.type = 'button';
        x.title = 'Retirer la pièce jointe';
        x.textContent = '✕';
        x.addEventListener('click', _chatAttachClear);
        el.appendChild(x);
    }
}

function _chatAttachInit() {
    const panel = document.getElementById('teamChatPanel');
    const input = document.getElementById('teamChatInput');
    const picker = document.getElementById('teamChatFile');
    const clip = document.getElementById('teamChatClip');
    if (!panel || !input || !picker || !clip) return;
    if (!_chatStorageOk()) { clip.style.display = 'none'; return; }

    clip.addEventListener('click', () => picker.click());
    picker.addEventListener('change', () => {
        if (picker.files && picker.files[0]) _chatAttachSet(picker.files[0]);
        picker.value = '';
    });
    // Coller : seulement si le presse-papiers contient un fichier (le texte collé reste normal)
    input.addEventListener('paste', e => {
        const files = e.clipboardData && e.clipboardData.files;
        if (files && files.length) {
            e.preventDefault();
            _chatAttachSet(files[0]);
            if (files.length > 1) _chatError('Une seule pièce jointe par message : seul le premier fichier est gardé.');
        }
    });
    // Glisser-déposer sur le panneau
    ['dragenter', 'dragover'].forEach(ev => panel.addEventListener(ev, e => {
        if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
            e.preventDefault();
            panel.classList.add('dragover');
        }
    }));
    ['dragleave', 'drop'].forEach(ev => panel.addEventListener(ev, e => {
        if (ev === 'dragleave' && panel.contains(e.relatedTarget)) return;
        panel.classList.remove('dragover');
    }));
    panel.addEventListener('drop', e => {
        const files = e.dataTransfer && e.dataTransfer.files;
        if (files && files.length) { e.preventDefault(); _chatAttachSet(files[0]); }
    });
}

// Envoie la pièce jointe en attente ; renvoie { path, name, size, type }
function _chatUploadPending(user) {
    const file = _chatPending;
    const safe = file.name.replace(/[^\w.\-]+/g, '_').slice(-80) || 'fichier';
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const path = `chat/${window._teamId}/${user.uid}/${id}-${safe}`;
    const type = file.type || 'application/octet-stream';
    return new Promise((resolve, reject) => {
        _chatUploading = true;
        _chatAttachRender(0);
        const task = window._fbUploadBytesResumable(window._fbStorageRef(window._fbStorage, path), file, { contentType: type });
        task.on('state_changed',
            snap => _chatAttachRender(Math.round(100 * snap.bytesTransferred / Math.max(1, snap.totalBytes))),
            err => { _chatUploading = false; _chatAttachRender(); reject(err); },
            () => {
                _chatUploading = false;
                resolve({ path, name: file.name.slice(0, 150), size: file.size, type: type.slice(0, 100) });
            });
    });
}

function _chatFileUrl(path) {
    if (!_chatUrlCache.has(path)) {
        const p = window._fbGetDownloadURL(window._fbStorageRef(window._fbStorage, path));
        p.catch(() => _chatUrlCache.delete(path));
        _chatUrlCache.set(path, p);
    }
    return _chatUrlCache.get(path);
}

function _chatDeleteFile(path) {
    if (!_chatStorageOk() || typeof path !== 'string' || !path.startsWith('chat/')) return;
    _chatUrlCache.delete(path);
    window._fbDeleteObject(window._fbStorageRef(window._fbStorage, path)).catch(() => { /* déjà supprimé ou non autorisé */ });
}

// Ajoute la pièce jointe d'un message dans son corps
function _chatFillFile(body, m) {
    const f = m.file;
    if (!f || typeof f.path !== 'string' || !f.path.startsWith(`chat/${window._teamId}/`) || !_chatStorageOk()) return;
    const name = String(f.name || 'fichier');
    const size = Number(f.size) || 0;
    if (CHAT_IMG_TYPES.includes(f.type)) {
        const img = document.createElement('img');
        img.className = 'chat-img';
        img.alt = name;
        img.title = `${name} (${_chatFmtSize(size)}) — cliquer pour ouvrir`;
        img.addEventListener('click', () => {
            _chatFileUrl(f.path).then(u => window.open(u, '_blank', 'noopener')).catch(() => {});
        });
        body.appendChild(img);
        _chatFileUrl(f.path).then(u => { img.src = u; }).catch(() => {
            img.remove();
            const miss = document.createElement('div');
            miss.className = 'chat-file-missing';
            miss.textContent = `🖼️ ${name} (image indisponible)`;
            body.appendChild(miss);
        });
        return;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chat-file';
    b.title = 'Télécharger';
    const n = document.createElement('b');
    n.textContent = '📎 ' + name;
    const s = document.createElement('span');
    s.textContent = _chatFmtSize(size);
    b.appendChild(n);
    b.appendChild(s);
    b.addEventListener('click', () => {
        _chatFileUrl(f.path).then(u => window.open(u, '_blank', 'noopener'))
            .catch(() => _chatError('Fichier indisponible (supprimé ou accès refusé).'));
    });
    body.appendChild(b);
}
