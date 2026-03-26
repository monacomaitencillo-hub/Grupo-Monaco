// Restaura nombres de productos en GDD records para que coincidan exactamente con `products`
// Usa normalización para hacer fuzzy matching
require('dotenv').config();
const admin = require('firebase-admin');

let serviceAccount;
try { serviceAccount = require('./firebase-service-account.json'); }
catch { serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT); }

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// Normaliza un nombre para comparación: minúsculas, sin tildes, sin paréntesis, sin espacios extra
function normalize(str) {
  return str
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quitar tildes
    .replace(/\s*\([^)]*\)\s*/g, ' ')                 // quitar paréntesis
    .replace(/[^a-z0-9\s\/]/g, ' ')                   // solo letras, números, slash
    .replace(/\s+/g, ' ')
    .trim();
}

function findBestMatch(name, productNames) {
  const normName = normalize(name);
  let best = null, bestScore = 0;

  for (const pname of productNames) {
    const normP = normalize(pname);
    if (normP === normName) return pname; // match exacto normalizado

    // Score: palabras en común
    const wordsA = new Set(normName.split(' ').filter(w => w.length > 2));
    const wordsB = new Set(normP.split(' ').filter(w => w.length > 2));
    let common = 0;
    for (const w of wordsA) if (wordsB.has(w)) common++;
    const score = common / Math.max(wordsA.size, wordsB.size, 1);

    if (score > bestScore) { bestScore = score; best = pname; }
  }

  // Solo retornar match si hay suficiente similitud
  return bestScore >= 0.6 ? best : null;
}

async function run() {
  const [gddSnap, prodSnap] = await Promise.all([
    db.collection('gdd_records').get(),
    db.collection('products').get()
  ]);

  const productNames = prodSnap.docs.map(d => d.data().name).filter(Boolean);
  const productSet   = new Set(productNames);

  console.log(`Productos en BD: ${productNames.length}`);
  console.log(`GDD records: ${gddSnap.docs.length}\n`);

  let docsFixed = 0, itemsFixed = 0, noMatch = [];

  for (const doc of gddSnap.docs) {
    const data  = doc.data();
    const items = data.items || [];
    let changed = false;

    const newItems = items.map(item => {
      if (!item.producto) return item;
      if (productSet.has(item.producto)) return item; // ya correcto

      const match = findBestMatch(item.producto, productNames);
      if (match) {
        console.log(`  [${doc.id.slice(0,8)}] "${item.producto}" → "${match}"`);
        itemsFixed++;
        changed = true;
        return { ...item, producto: match };
      } else {
        noMatch.push({ doc: doc.id.slice(0,8), name: item.producto });
        return item;
      }
    });

    if (changed) {
      await db.collection('gdd_records').doc(doc.id).update({ items: newItems });
      docsFixed++;
    }
  }

  console.log(`\nDocs actualizados: ${docsFixed}`);
  console.log(`Items corregidos: ${itemsFixed}`);
  if (noMatch.length) {
    console.log(`\nSin match (${noMatch.length}):`);
    [...new Set(noMatch.map(x => x.name))].forEach(n => console.log(`  - ${n}`));
  }
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
