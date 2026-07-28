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

export const loadFirebaseAdminApp = (): FirebaseAdminAppModule =>
  require("firebase-admin/app") as FirebaseAdminAppModule;

export const loadFirebaseAdminStorage = (): FirebaseAdminStorageModule =>
  require("firebase-admin/storage") as FirebaseAdminStorageModule;
