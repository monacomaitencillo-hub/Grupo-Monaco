require('dotenv').config();
const admin = require('firebase-admin');
try { admin.initializeApp({ credential: admin.credential.cert(require('./firebase-service-account.json')) }); }
catch { admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) }); }
const db = admin.firestore();

async function run() {
  const snap = await db.collection('gdd_records').get();
  const provs = new Set();
  snap.docs.forEach(d => { if (d.data().proveedor) provs.add(d.data().proveedor); });
  console.log('Proveedores en GDD records:');
  [...provs].sort().forEach(p => console.log(' ', p));
  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
