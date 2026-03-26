require('dotenv').config();
const admin = require('firebase-admin');

let serviceAccount;
try { serviceAccount = require('./firebase-service-account.json'); }
catch { serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT); }

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function run() {
  const snap = await db.collection('products').get();
  const names = snap.docs.map(d => d.data().name || d.data().nombre || '(sin nombre)').sort();
  console.log(`Total productos: ${names.length}\n`);
  names.forEach(n => console.log(n));
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
