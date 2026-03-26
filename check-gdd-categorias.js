require('dotenv').config();
const admin = require('firebase-admin');
try { admin.initializeApp({ credential: admin.credential.cert(require('./firebase-service-account.json')) }); }
catch { admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) }); }
const db = admin.firestore();

async function run() {
  const snap = await db.collection('gdd_records').get();
  const cats = new Set();
  snap.docs.forEach(d => {
    (d.data().items || []).forEach(item => {
      if (item.categoria) cats.add(item.categoria);
    });
  });
  console.log('Categorías en GDD items:');
  [...cats].sort().forEach(c => console.log(' ', c));
  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
