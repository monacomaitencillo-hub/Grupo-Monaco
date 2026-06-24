const admin = require('firebase-admin');
const serviceAccount = require('./firebase-service-account.json');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const HELADERIA_ID = 'fUahUzX2tK477JMmAxbB';

async function main() {
  const snap = await db.collection('recipes').get();
  const heladoRecipes = snap.docs.filter(d => {
    const name = d.data().name || '';
    return name.toLowerCase().includes('helado') && name.toLowerCase().includes('5l');
  });

  console.log(`Encontradas ${heladoRecipes.length} recetas de helado 5L`);

  const batch = db.batch();
  heladoRecipes.forEach(doc => {
    const data = doc.data();
    const currentIds = data.inventoryRestaurantIds || [];
    if (!currentIds.includes(HELADERIA_ID)) {
      const newIds = [...currentIds, HELADERIA_ID];
      batch.update(doc.ref, { inventoryRestaurantIds: newIds });
      console.log(`  → ${data.name}`);
    } else {
      console.log(`  ✓ ${data.name} (ya tiene Heladería)`);
    }
  });

  await batch.commit();
  console.log('Listo.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
