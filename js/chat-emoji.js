/* ══════════════════════════════════════════════════════════════
   chat-emoji.js — Sélecteur d'émoticônes du chat d'équipe

   Bouton 😀 à côté du champ de saisie : ouvre une grille d'émojis classés par
   catégorie (plus une catégorie « Récents » gardée sur cet appareil). Un clic
   insère l'émoji à la position du curseur. Aucune bibliothèque externe : ce
   sont des caractères Unicode, affichés par la police d'émojis du système.
   ══════════════════════════════════════════════════════════════ */

const CHAT_EMOJI_CATS = [
    { icon: '😀', name: 'Visages', list: '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🤧 🥵 🥶 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 ☹️ 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 ☠️ 💩 🤡 👻 👽 🤖' },
    { icon: '👍', name: 'Gestes', list: '👍 👎 👌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 🤝 👏 🙌 👐 🤲 🙏 ✍️ 💪 🦾 🫡 🫶 🤌 🫰 🤏 ✊ 👊 🤛 🤜 👀 👁️ 🧠 🫵' },
    { icon: '🏎️', name: 'Course', list: '🏎️ 🏁 🚩 🏆 🥇 🥈 🥉 🏅 ⏱️ ⏲️ ⏰ 🕐 🛞 ⛽ 🔧 🔩 ⚙️ 🛠️ 🚗 🚙 🚦 🚥 🛑 ⚠️ 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🌧️ ☔ ☀️ ⛅ ☁️ 🌙 🌡️ 💨 🔥 💥 ⚡ 🔋 📡 🎧 🎙️ 📢 🗺️ 📍 📈 📉 📊 🧮 🧯 🛡️ 🚨 🚧' },
    { icon: '❤️', name: 'Cœurs', list: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💯 ✅ ❌ ❎ ✔️ ➕ ➖ ❓ ❗ ‼️ ⁉️ ⭐ 🌟 ✨ 💫 🎉 🎊 🎈 🎁 🔔 🔕 💡 📌 📎 🔗 🔒 🔓 🔑' },
    { icon: '🍕', name: 'Nourriture', list: '☕ 🍵 🥤 🍺 🍻 🥂 🍷 🍾 💧 🍕 🍔 🍟 🌭 🥪 🌮 🌯 🥗 🍝 🍜 🍣 🍱 🥐 🥖 🧀 🥚 🍳 🥓 🍗 🍖 🍎 🍌 🍇 🍓 🍒 🍑 🥑 🍫 🍬 🍭 🍩 🍪 🎂 🍰 🍦' },
    { icon: '🐶', name: 'Animaux', list: '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🦅 🦆 🦉 🐺 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐢 🐍 🐙 🦀 🐠 🐟 🐬 🐳 🦈 🐊 🦖 🦎' },
];
const CHAT_EMOJI_RECENT_KEY = 'lmuChatEmojiRecent';
let _chatEmojiCat = 0;

function _chatEmojiRecent() {
    try {
        const a = JSON.parse(localStorage.getItem(CHAT_EMOJI_RECENT_KEY) || '[]');
        return Array.isArray(a) ? a.filter(x => typeof x === 'string').slice(0, 24) : [];
    } catch (e) { return []; }
}

function _chatEmojiRemember(em) {
    try {
        const a = [em].concat(_chatEmojiRecent().filter(x => x !== em)).slice(0, 24);
        localStorage.setItem(CHAT_EMOJI_RECENT_KEY, JSON.stringify(a));
    } catch (e) { /* stockage indisponible : sans conséquence */ }
}

function _chatEmojiInsert(em) {
    const input = document.getElementById('teamChatInput');
    if (!input) return;
    const max = input.maxLength > 0 ? input.maxLength : Infinity;
    const start = input.selectionStart == null ? input.value.length : input.selectionStart;
    const end = input.selectionEnd == null ? start : input.selectionEnd;
    const next = input.value.slice(0, start) + em + input.value.slice(end);
    if (next.length > max) return;
    input.value = next;
    const pos = start + em.length;
    input.focus();
    input.setSelectionRange(pos, pos);
    _chatEmojiRemember(em);
    input.dispatchEvent(new Event('input'));   // remet à jour les suggestions @ / #
}

function _chatEmojiRender() {
    const box = document.getElementById('teamChatEmoji');
    if (!box) return;
    const recent = _chatEmojiRecent();
    const cats = [{ icon: '🕘', name: 'Récents', list: recent }].concat(
        CHAT_EMOJI_CATS.map(c => ({ icon: c.icon, name: c.name, list: c.list.split(' ') })));
    if (_chatEmojiCat >= cats.length) _chatEmojiCat = 1;
    if (_chatEmojiCat === 0 && !recent.length) _chatEmojiCat = 1;
    box.textContent = '';
    const tabs = document.createElement('div');
    tabs.className = 'emo-tabs';
    cats.forEach((c, i) => {
        const t = document.createElement('button');
        t.type = 'button';
        t.textContent = c.icon;
        t.title = c.name;
        if (i === _chatEmojiCat) t.className = 'active';
        t.addEventListener('mousedown', e => e.preventDefault());   // garde le focus dans le champ
        t.addEventListener('click', () => { _chatEmojiCat = i; _chatEmojiRender(); });
        tabs.appendChild(t);
    });
    const grid = document.createElement('div');
    grid.className = 'emo-grid';
    cats[_chatEmojiCat].list.forEach(em => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = em;
        b.addEventListener('mousedown', e => e.preventDefault());
        b.addEventListener('click', () => _chatEmojiInsert(em));
        grid.appendChild(b);
    });
    box.appendChild(tabs);
    box.appendChild(grid);
}

function _chatEmojiToggle(show) {
    const box = document.getElementById('teamChatEmoji');
    if (!box) return;
    if (typeof show !== 'boolean') show = box.style.display === 'none';
    box.style.display = show ? 'block' : 'none';
    if (show) _chatEmojiRender();
}

function _chatEmojiInit() {
    const btn = document.getElementById('teamChatEmojiBtn');
    if (!btn) return;
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('click', () => { _chatEmojiToggle(); document.getElementById('teamChatInput')?.focus(); });
    document.getElementById('teamChatInput')?.addEventListener('keydown', e => {
        if (e.key === 'Escape') _chatEmojiToggle(false);
    });
}
