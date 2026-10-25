const admin = require('firebase-admin');
const serviceAccount = require('./firebase-service-account.json');
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const IDS = {
  'uENFrJJ6zlOMroLENtnI': 'Agua',
  'PRrjNh0mWUdx5hFM7gBS': 'Pulpa Mango (kg)',
  'ldZRVZtMmOjoAb9PkaOU': 'Azúcar (kg)',
  'iRQRp8MIh5491CMqwOda': 'Dextrosa Monohidratada (kg)',
  '1QGG8We9MTPdcI87WzAK': 'Estabilizante Neutro AC (kg)',
  'lECWgy538KlYhoZEumPI': 'Bachas de Helado 5L',
  'RIbbqaMhBLXaNMDKze5w': 'Tapas de Bachas 5L',
  'tUUD7oMZ712cxUK7Lgpa': 'Leche Natural Entera (L)',
  '3PWfP8Lkf2FOo2zp2uzm': 'Crema de Leche (L)',
  '6hwFsn062X6T8dQJKEhX': 'Cacao Heladería (kg)',
  '4a04cmRXoL0kb92ByhtT': 'Leche en Polvo Descremada (kg)',
  '6PtpqY3APVXXp9VDKO2r': 'Frambuesa IQF (kg)',
  'zTs6bYguCkwOZMBY6lFE': 'Vainilla Umsha (un)',
  'hpg0RQtCtQFmT7xGT2Z8': 'Galleta Oreo (pqte)',
  'arOgzENFDNuMtLzKUQTn': 'Maní con Sal (kg)',
};

async function main() {
  const snap = await db.collection('product_price_history').get();
  
  const latestMap = {};
  snap.docs.forEach(d => {
    const { productId, mes, precio } = d.data();
    if (!productId || !IDS[productId]) return;
    if (!latestMap[productId] || mes > latestMap[productId].mes) {
      latestMap[productId] = { mes, precio };
    }
  });

  console.log('Precios más recientes:');
  Object.entries(IDS).forEach(([id, name]) => {
    const entry = latestMap[id];
    console.log(`${name}: ${entry ? '$' + entry.precio + ' (mes: ' + entry.mes + ')' : 'SIN PRECIO'}`);
  });

  // Also check preparation: Mantequilla de Maní
  console.log('\nBuscando preparación Mantequilla de Maní...');
  const prepSnap = await db.collection('preparations').get();
  const mb = prepSnap.docs.find(d => (d.data().name||'').toLowerCase().includes('mantequilla'));
  if (mb) console.log(JSON.stringify({ id: mb.id, ...mb.data() }, null, 2));

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
