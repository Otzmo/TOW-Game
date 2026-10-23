import type { FirebaseOptions } from 'firebase/app';

/**
 * Konfiguration der Firebase-Web-App (Projekteinstellungen → Meine Apps).
 * Das ist kein Geheimnis: Die Werte stehen ohnehin im ausgelieferten Code.
 * Geschützt wird die Datenbank durch database.rules.json.
 *
 * Steht hier null, ist nur der Offline-Modus verfügbar – so auch im Demo-Build.
 */
export const firebaseConfig: FirebaseOptions | null = import.meta.env.VITE_DEMO ? null : {
  apiKey: 'AIzaSyAr_YN1-Les7o1COHrcIxdpQf1m-0Md_Dk',
  authDomain: 'tow-game-f92c3.firebaseapp.com',
  databaseURL: 'https://tow-game-f92c3-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'tow-game-f92c3',
  storageBucket: 'tow-game-f92c3.firebasestorage.app',
  messagingSenderId: '16236758049',
  appId: '1:16236758049:web:9342a45e0c7d205bab0f60',
};
