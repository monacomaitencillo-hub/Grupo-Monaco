// Limpia nombres de productos con descripciones de sabores en paréntesis
// Ej: "Torta Amor (Hojarasca, frambuesa, manjar, ...)" → "Torta Amor"
require('dotenv').config();
const admin = require('firebase-admin');

let serviceAccount;
try {
  serviceAccount = require('./firebase-service-account.json');
} catch {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const flavorRe = /\s*\([^)]*,[^)]*\)\s*$/;

async function run() {
  const snap = await db.collection('gdd_records').get();
  let docsFixed = 0, itemsFixed = 0;

  for (const doc of snap.docs) {
    const data   = doc.data();
    const items  = data.items || [];
    let changed  = false;

    const newItems = items.map(item => {
      if (!item.producto) return item;
      const original = item.producto;
      const cleaned  = original.replace(flavorRe, '').trim();
      if (cleaned !== original) {
        console.log(`  [${doc.id}] "${original}" → "${cleaned}"`);
        itemsFixed++;
        changed = true;
        return { ...item, producto: cleaned };
      }
      return item;
    });

    if (changed) {
      await db.collection('gdd_records').doc(doc.id).update({ items: newItems });
      docsFixed++;
    }
  }

  console.log(`\nDocs actualizados: ${docsFixed}`);
  console.log(`Items corregidos: ${itemsFixed}`);
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
