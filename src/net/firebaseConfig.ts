import type { FirebaseOptions } from 'firebase/app';

/**
 * Konfiguration der Firebase-Web-App (Projekteinstellungen → Meine Apps).
 * Das ist kein Geheimnis: Die Werte stehen ohnehin im ausgelieferten Code.
 * Geschützt wird die Datenbank durch database.rules.json.
 *
 * Solange hier null steht, ist nur der Offline-Modus verfügbar.
 */
export const firebaseConfig: FirebaseOptions | null = null;
