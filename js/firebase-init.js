  import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
  import { getDatabase, ref, onValue, set, update, get, remove, onDisconnect }
    from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
  import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, createUserWithEmailAndPassword, sendPasswordResetEmail, connectAuthEmulator }
    from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const firebaseConfig = {
  apiKey:            "AIzaSyB_b9xgmS2262EiMz82BIWVrC4ddUHBF2E",
  authDomain:        "lmu-france-strat.firebaseapp.com",
  databaseURL:       "https://lmu-france-strat-default-rtdb.europe-west1.firebasedatabase.app",
  projectId:         "lmu-france-strat",
  storageBucket:     "lmu-france-strat.firebasestorage.app",
  messagingSenderId: "1098079829773",
  appId:             "1:1098079829773:web:ada8331f84903536763a44"
};

  const app  = initializeApp(firebaseConfig);

  // ── Mode développement : émulateurs Firebase locaux ──
  // Activé UNIQUEMENT depuis localhost avec "?emulator=1" dans l'URL (jamais sur
  // le site publié). Permet de tester l'app de bout en bout sans toucher aux
  // données réelles (voir tests/e2e/seed_emulator.py). La base émulée est
  // adressée par son espace de noms pour que les règles de sécurité du projet
  // émulé (firebase/database.rules.json) s'appliquent réellement.
  const _isLocalHost = ['localhost', '127.0.0.1'].includes(location.hostname);
  const _useEmulator = _isLocalHost && new URLSearchParams(location.search).get('emulator') === '1';
  const db   = _useEmulator
    ? getDatabase(app, 'http://127.0.0.1:9000/?ns=demo-lmu-e2e-default-rtdb')
    : getDatabase(app);
  const auth = getAuth(app);
  if (_useEmulator) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    window._firebaseEmulator = true;
    console.info('[firebase] Mode émulateur local actif (Auth :9099, Database :9000).');
  }

  window._firebaseDb = db;
  window._firebaseRef = ref;
  window._firebaseSet = set;
  window._firebaseUpdate = update;
  window._firebaseOnValue = onValue;
  window._firebaseGet = get;
  window._firebaseRemove = remove;
  window._firebaseOnDisconnect = onDisconnect;

  // ── Authentification (remplace l'ancien gate par mot de passe client) ──
  // L'autorisation réelle est appliquée par les règles de sécurité (voir
  // firebase/database.rules.json : appartenance à une équipe + rôle), jamais
  // par ce code — ce code ne fait qu'afficher l'état et proposer le formulaire.
  window._firebaseAuth = auth;
  window._firebaseSignIn = signInWithEmailAndPassword;
  window._firebaseSignUp = createUserWithEmailAndPassword;   // uniquement via un lien d'invitation (voir access-gate.js)
  window._firebaseResetPassword = sendPasswordResetEmail;
  window._firebaseSignOut = () => signOut(auth);
  window._firebaseOnAuthStateChanged = onAuthStateChanged;

  // ── Initialisation après chargement Firebase ──
  window._firebaseReady = true;
  window.dispatchEvent(new Event('firebaseReady'));

