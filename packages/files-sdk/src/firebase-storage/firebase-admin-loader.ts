import { createRequire } from "node:module";

import type {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
} from "firebase-admin/app";
import type { getStorage } from "firebase-admin/storage";

const require = createRequire(import.meta.url);

interface FirebaseAdminAppModule {
  applicationDefault: typeof applicationDefault;
  cert: typeof cert;
  getApps: typeof getApps;
  initializeApp: typeof initializeApp;
}

interface FirebaseAdminStorageModule {
  getStorage: typeof getStorage;
}

// SAFETY: `createRequire`'s `require` is untyped; the interface mirrors the
// named exports of the `firebase-admin/app` subpath (typed above via
// `typeof` imports of that very module).
export const loadFirebaseAdminApp = (): FirebaseAdminAppModule =>
  require("firebase-admin/app") as FirebaseAdminAppModule;

// SAFETY: as above, for the `firebase-admin/storage` subpath's `getStorage`.
export const loadFirebaseAdminStorage = (): FirebaseAdminStorageModule =>
  require("firebase-admin/storage") as FirebaseAdminStorageModule;
