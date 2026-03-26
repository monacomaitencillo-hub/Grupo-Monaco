require('dotenv').config();
const admin = require('firebase-admin');
try { admin.initializeApp({ credential: admin.credential.cert(require('./firebase-service-account.json')) }); }
catch { admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) }); }
const db = admin.firestore();

async function run() {
  const [gddSnap, restSnap] = await Promise.all([
    db.collection('gdd_records').get(),
    db.collection('restaurants').get()
  ]);

  const restById = {};
  restSnap.docs.forEach(d => { restById[d.id] = d.data().name || d.id; });

  console.log('Restaurantes en BD:');
  restSnap.docs.forEach(d => console.log(`  ${d.id} → "${d.data().name}"`));

  console.log('\nRestaurantIds en GDD records:');
  const counts = {};
  gddSnap.docs.forEach(d => {
    const rid = d.data().restaurantId || '(vacío)';
    counts[rid] = (counts[rid] || 0) + 1;
  });
  Object.entries(counts).sort().forEach(([rid, n]) => {
    console.log(`  "${rid}" (${n} registros) → "${restById[rid] || '?'}"`);
  });
  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
