/* ══════════════════════════════════════════════════════════════
   chat-emoji.js — Sélecteur d'émoticônes du chat d'équipe

   Bouton 😀 à côté du champ de saisie : ouvre une grille d'émojis classés par
   catégorie (plus une catégorie « Récents » gardée sur cet appareil) et un champ
   de recherche par nom (sans tenir compte des accents). Chaque émoji a un nom
   français, affiché en infobulle. Un clic insère l'émoji à la position du curseur.
   Aucune bibliothèque externe : ce sont des caractères Unicode, affichés par la
   police d'émojis du système.

   Format des listes : « émoji nom » séparés par « | » (le nom peut contenir des
   mots-clés supplémentaires, utiles à la recherche).
   ══════════════════════════════════════════════════════════════ */

const CHAT_EMOJI_CATS = [
    { icon: '😀', name: 'Visages', list: [
        '😀 sourire', '😃 sourire yeux ouverts', '😄 rire', '😁 sourire dents', '😆 rire yeux fermés', '😅 sueur froide soulagé',
        '🤣 mort de rire mdr', '😂 larmes de joie', '🙂 sourire léger', '🙃 à l\'envers', '😉 clin d\'oeil', '😊 sourire joues roses',
        '😇 ange auréole', '🥰 amoureux', '😍 yeux en coeur', '🤩 yeux étoilés', '😘 bisou', '😗 bise', '😚 bisou yeux fermés',
        '😋 miam délicieux', '😛 langue tirée', '😜 langue clin d\'oeil', '🤪 fou dingue', '😝 langue yeux fermés', '🤑 argent',
        '🤗 câlin', '🤭 main sur la bouche oups', '🤫 chut silence', '🤔 réflexion hum', '🤐 bouche zippée', '🤨 sourcil levé doute',
        '😐 neutre', '😑 sans expression', '😶 sans bouche', '😏 sourire en coin', '😒 mécontent', '🙄 yeux au ciel',
        '😬 grimace', '🤥 menteur pinocchio', '😌 soulagé serein', '😔 pensif triste', '😪 endormi', '🤤 bave', '😴 dort zzz',
        '😷 masque', '🤒 malade fièvre', '🤕 blessé bandage', '🤢 nausée', '🤮 vomit', '🤧 éternuement', '🥵 chaud',
        '🥶 froid gelé', '😵 étourdi', '🤯 tête qui explose', '🤠 cowboy', '🥳 fête anniversaire', '😎 lunettes de soleil cool',
        '🤓 intello', '🧐 monocle', '😕 perplexe', '😟 inquiet', '🙁 déçu', '☹️ triste', '😮 bouche ouverte surpris',
        '😯 étonné', '😲 stupéfait', '😳 gêné rougit', '🥺 supplie yeux de chiot', '😦 consterné', '😧 angoissé', '😨 peur',
        '😰 anxieux sueur', '😥 déçu', '😢 pleure larme', '😭 sanglote', '😱 cri d\'effroi', '😖 confus', '😣 persévère',
        '😞 abattu', '😓 sueur abattu', '😩 épuisé', '😫 fatigué', '🥱 bâille', '😤 souffle fier', '😡 en colère rouge',
        '😠 fâché', '🤬 jurons insultes', '😈 diable sourire', '👿 diable fâché', '💀 crâne', '☠️ tête de mort', '💩 caca',
        '🤡 clown', '👻 fantôme', '👽 extraterrestre alien', '🤖 robot'] },
    { icon: '👍', name: 'Gestes', list: [
        '👍 pouce en l\'air ok oui', '👎 pouce en bas non', '👌 ok parfait', '✌️ victoire paix', '🤞 doigts croisés chance',
        '🤟 je t\'aime', '🤘 rock', '🤙 appelle-moi', '👈 main gauche', '👉 main droite', '👆 main vers le haut', '👇 main vers le bas',
        '☝️ index levé', '✋ main levée stop', '🤚 dos de la main', '🖐️ main ouverte', '🖖 salut vulcain', '👋 salut coucou bonjour',
        '🤝 poignée de main accord', '👏 applaudissements bravo', '🙌 mains en l\'air hourra', '👐 mains ouvertes',
        '🤲 paumes jointes', '🙏 prière merci s\'il vous plaît', '✍️ écrit', '💪 biceps muscle force', '🦾 bras robotique',
        '🫡 salut militaire', '🫶 mains en coeur', '🤌 doigts pincés', '🫰 doigts coeur', '🤏 un petit peu', '✊ poing levé',
        '👊 coup de poing', '🤛 poing gauche', '🤜 poing droit', '👀 yeux regarde', '👁️ oeil', '🧠 cerveau', '🫵 toi'] },
    { icon: '🏎️', name: 'Course', list: [
        '🏎️ voiture de course', '🏁 drapeau à damier arrivée', '🚩 drapeau rouge', '🏆 trophée coupe', '🥇 médaille or première place',
        '🥈 médaille argent deuxième', '🥉 médaille bronze troisième', '🏅 médaille', '⏱️ chronomètre', '⏲️ minuteur',
        '⏰ réveil', '🕐 horloge heure', '🛞 pneu roue', '⛽ carburant essence', '🔧 clé outil', '🔩 boulon vis',
        '⚙️ engrenage réglages', '🛠️ outils mécanique', '🚗 voiture', '🚙 voiture utilitaire', '🚦 feux', '🚥 feux horizontaux',
        '🛑 stop panneau', '⚠️ attention danger', '🔴 rond rouge', '🟠 rond orange', '🟡 rond jaune', '🟢 rond vert',
        '🔵 rond bleu', '🟣 rond violet', '⚫ rond noir', '⚪ rond blanc', '🌧️ pluie', '☔ parapluie', '☀️ soleil',
        '⛅ éclaircies', '☁️ nuage', '🌙 lune nuit', '🌡️ température', '💨 vitesse vent', '🔥 feu', '💥 collision accident',
        '⚡ éclair', '🔋 batterie énergie', '📡 antenne télémétrie', '🎧 casque audio', '🎙️ micro', '📢 mégaphone annonce',
        '🗺️ carte circuit', '📍 position', '📈 hausse', '📉 baisse', '📊 statistiques', '🧮 calcul boulier',
        '🧯 extincteur', '🛡️ bouclier protection', '🚨 gyrophare alerte', '🚧 travaux'] },
    { icon: '❤️', name: 'Coeurs et symboles', list: [
        '❤️ coeur rouge amour', '🧡 coeur orange', '💛 coeur jaune', '💚 coeur vert', '💙 coeur bleu', '💜 coeur violet',
        '🖤 coeur noir', '🤍 coeur blanc', '🤎 coeur marron', '💔 coeur brisé', '❣️ point d\'exclamation coeur', '💕 deux coeurs',
        '💞 coeurs tournants', '💓 coeur qui bat', '💗 coeur grandissant', '💖 coeur étincelant', '💘 coeur flèche',
        '💝 coeur cadeau', '💯 cent parfait', '✅ validé case cochée', '❌ croix erreur', '❎ croix verte', '✔️ coche',
        '➕ plus', '➖ moins', '❓ question', '❗ exclamation', '‼️ double exclamation', '⁉️ interrogation exclamation',
        '⭐ étoile', '🌟 étoile brillante', '✨ étincelles', '💫 étoiles étourdi', '🎉 fête confettis', '🎊 boule confettis',
        '🎈 ballon', '🎁 cadeau', '🔔 cloche notification', '🔕 muet sans notification', '💡 idée ampoule', '📌 épingle',
        '📎 trombone pièce jointe', '🔗 lien', '🔒 verrouillé cadenas', '🔓 déverrouillé', '🔑 clé'] },
    { icon: '🍕', name: 'Nourriture', list: [
        '☕ café', '🍵 thé', '🥤 soda boisson', '🍺 bière', '🍻 trinquer bières', '🥂 trinquer champagne', '🍷 vin',
        '🍾 bouteille champagne podium', '💧 eau goutte', '🍕 pizza', '🍔 hamburger', '🍟 frites', '🌭 hot-dog', '🥪 sandwich',
        '🌮 taco', '🌯 burrito', '🥗 salade', '🍝 pâtes spaghetti', '🍜 nouilles soupe', '🍣 sushi', '🍱 bento', '🥐 croissant',
        '🥖 baguette', '🧀 fromage', '🥚 oeuf', '🍳 oeuf au plat', '🥓 bacon', '🍗 poulet cuisse', '🍖 viande', '🍎 pomme',
        '🍌 banane', '🍇 raisin', '🍓 fraise', '🍒 cerises', '🍑 pêche', '🥑 avocat', '🍫 chocolat', '🍬 bonbon', '🍭 sucette',
        '🍩 donut beignet', '🍪 biscuit cookie', '🎂 gâteau anniversaire', '🍰 part de gâteau', '🍦 glace'] },
    { icon: '🐶', name: 'Animaux', list: [
        '🐶 chien', '🐱 chat', '🐭 souris', '🐹 hamster', '🐰 lapin', '🦊 renard', '🐻 ours', '🐼 panda', '🐨 koala', '🐯 tigre',
        '🦁 lion', '🐮 vache', '🐷 cochon', '🐸 grenouille', '🐵 singe', '🙈 singe qui ne voit rien', '🙉 singe qui n\'entend rien',
        '🙊 singe qui ne dit rien', '🐔 poule', '🐧 pingouin manchot', '🐦 oiseau', '🦅 aigle', '🦆 canard', '🦉 hibou chouette',
        '🐺 loup', '🐴 cheval', '🦄 licorne', '🐝 abeille', '🐛 chenille', '🦋 papillon', '🐌 escargot lent', '🐞 coccinelle',
        '🐢 tortue', '🐍 serpent', '🐙 pieuvre', '🦀 crabe', '🐠 poisson tropical', '🐟 poisson', '🐬 dauphin', '🐳 baleine',
        '🦈 requin', '🐊 crocodile', '🦖 dinosaure', '🦎 lézard'] },
].map(c => ({
    icon: c.icon,
    name: c.name,
    list: c.list.map(s => { const i = s.indexOf(' '); return { e: s.slice(0, i), n: s.slice(i + 1) }; }),
}));
const CHAT_EMOJI_NAMES = new Map();
CHAT_EMOJI_CATS.forEach(c => c.list.forEach(x => CHAT_EMOJI_NAMES.set(x.e, x.n)));

const CHAT_EMOJI_RECENT_KEY = 'lmuChatEmojiRecent';
let _chatEmojiCat = 0;
let _chatEmojiQuery = '';

function _chatEmojiNorm(s) {
    return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

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

// Émojis à afficher : résultats de la recherche, sinon la catégorie choisie
function _chatEmojiShown() {
    const q = _chatEmojiNorm(_chatEmojiQuery.trim());
    if (q) {
        const seen = new Set(), out = [];
        CHAT_EMOJI_CATS.forEach(c => c.list.forEach(x => {
            if (!seen.has(x.e) && _chatEmojiNorm(x.n).includes(q)) { seen.add(x.e); out.push(x); }
        }));
        return out;
    }
    if (_chatEmojiCat === 0) return _chatEmojiRecent().map(e => ({ e, n: CHAT_EMOJI_NAMES.get(e) || '' }));
    return CHAT_EMOJI_CATS[_chatEmojiCat - 1].list;
}

function _chatEmojiRenderGrid() {
    const grid = document.querySelector('#teamChatEmoji .emo-grid');
    if (!grid) return;
    grid.textContent = '';
    const shown = _chatEmojiShown();
    if (!shown.length) {
        const none = document.createElement('div');
        none.className = 'emo-none';
        none.textContent = _chatEmojiQuery.trim() ? 'Aucun émoji trouvé.' : 'Aucun émoji récent.';
        grid.appendChild(none);
        return;
    }
    shown.forEach(x => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = x.e;
        b.title = x.n;
        b.addEventListener('click', () => _chatEmojiInsert(x.e));
        grid.appendChild(b);
    });
}

function _chatEmojiRender() {
    const box = document.getElementById('teamChatEmoji');
    if (!box) return;
    if (_chatEmojiCat === 0 && !_chatEmojiRecent().length) _chatEmojiCat = 1;
    box.textContent = '';
    const tabs = document.createElement('div');
    tabs.className = 'emo-tabs';
    [{ icon: '🕘', name: 'Récents' }].concat(CHAT_EMOJI_CATS).forEach((c, i) => {
        const t = document.createElement('button');
        t.type = 'button';
        t.textContent = c.icon;
        t.title = c.name;
        if (i === _chatEmojiCat && !_chatEmojiQuery.trim()) t.className = 'active';
        t.addEventListener('click', () => { _chatEmojiCat = i; _chatEmojiQuery = ''; _chatEmojiRender(); });
        tabs.appendChild(t);
    });
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'emo-search';
    search.placeholder = 'Rechercher un émoji (ex. pneu, merci, pluie)';
    search.value = _chatEmojiQuery;
    search.addEventListener('input', () => {
        _chatEmojiQuery = search.value;
        tabs.querySelectorAll('button').forEach((t, i) => {
            t.className = (i === _chatEmojiCat && !_chatEmojiQuery.trim()) ? 'active' : '';
        });
        _chatEmojiRenderGrid();
    });
    search.addEventListener('keydown', e => {
        if (e.key === 'Escape') { e.preventDefault(); _chatEmojiToggle(false); document.getElementById('teamChatInput')?.focus(); }
    });
    const grid = document.createElement('div');
    grid.className = 'emo-grid';
    box.appendChild(tabs);
    box.appendChild(search);
    box.appendChild(grid);
    _chatEmojiRenderGrid();
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
