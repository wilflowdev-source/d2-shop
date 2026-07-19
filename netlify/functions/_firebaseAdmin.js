const admin = require("firebase-admin");

let app;

function getAdmin() {
  if (!app) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) {
      throw new Error("Variable d'environnement FIREBASE_SERVICE_ACCOUNT manquante.");
    }
    const serviceAccount = JSON.parse(raw);
    app = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DATABASE_URL,
    });
  }
  return admin;
}

module.exports = { getAdmin };
