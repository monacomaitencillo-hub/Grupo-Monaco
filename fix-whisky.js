require('dotenv').config();
const admin = require('firebase-admin');
try { admin.initializeApp({ credential: admin.credential.cert(require('./firebase-service-account.json')) }); }
catch { admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) }); }
const db = admin.firestore();

async function run() {
  const snap = await db.collection('gdd_records').get();
  let fixed = 0;
  for (const doc of snap.docs) {
    const items = doc.data().items || [];
    let changed = false;
    const newItems = items.map(item => {
      if (item.producto === 'Whisky Johnnie Walker 750cc') {
        changed = true; fixed++;
        return { ...item, producto: 'Whisky Jhonnie Walker Red Label 750cc' };
      }
      return item;
    });
    if (changed) await db.collection('gdd_records').doc(doc.id).update({ items: newItems });
  }
  console.log(`Items corregidos: ${fixed}`);
  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
