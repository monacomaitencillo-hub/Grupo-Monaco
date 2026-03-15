const express = require('express');
const fetch   = require('node-fetch');
const admin   = require('firebase-admin');

let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  try {
    serviceAccount = require('./firebase-service-account.json');
  } catch {
    console.error('❌  Falta firebase-service-account.json o variable FIREBASE_SERVICE_ACCOUNT');
    process.exit(1);
  }
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const app = express();
app.use(express.json());
app.use(express.static(__dirname, {
  etag: false, lastModified: false,
  setHeaders: res => res.set('Cache-Control', 'no-store')
}));

const FUDO_AUTH = 'https://auth.fu.do/authenticate';
const FUDO_API  = 'https://api.fu.do/v1alpha1';

// ── Caches ────────────────────────────────────────────────
const fudoTokenCache   = {}; // { [restaurantId]: { token, cachedAt } }
const summaryCache     = {}; // { [key]: { data, cachedAt } }
const TOKEN_TTL        = 7 * 60 * 60 * 1000; // 7h
const SUMMARY_TTL      = 10 * 60 * 1000;     // 10 min

async function getFudoToken(restaurantId) {
  const cached = fudoTokenCache[restaurantId];
  if (cached && (Date.now() - cached.cachedAt) < TOKEN_TTL) return cached.token;

  const restDoc = await db.collection('restaurants').doc(restaurantId).get();
  if (!restDoc.exists) throw new Error('Local no encontrado');
  const { fudoUser, fudoPassword } = restDoc.data();

  const r = await fetch(FUDO_AUTH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: fudoUser, password: fudoPassword })
  });
  const data = await r.json();
  if (!data.token) throw new Error('No se pudo autenticar con Fudo: ' + JSON.stringify(data));

  fudoTokenCache[restaurantId] = { token: `Bearer ${data.token}`, cachedAt: Date.now() };
  return fudoTokenCache[restaurantId].token;
}

// ── Firebase Auth middleware ──────────────────────────────
async function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
  try {
    const decoded = await admin.auth().verifyIdToken(header.slice(7));
    req.uid   = decoded.uid;
    req.email = decoded.email;
    next();
  } catch {
    res.status(401).json({ error: 'Sesión expirada, vuelve a iniciar sesión' });
  }
}

async function isAdmin(uid) {
  const doc = await db.collection('users').doc(uid).get();
  return doc.exists && doc.data().role === 'admin';
}

// ── Fudo helpers ──────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchFudoPage(auth, url, attempt = 0) {
  console.log(`→ Fudo [${attempt}]: ${url.replace(FUDO_API, '')}`);
  const r    = await fetch(url, { headers: { Authorization: auth } });
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    if (text.trim().toLowerCase().startsWith('retry') && attempt < 8) {
      const wait = 4000 * (attempt + 1); // 4s, 8s, 12s...
      console.log(`  ⏳ Retry later — esperando ${wait/1000}s...`);
      await sleep(wait);
      return fetchFudoPage(auth, url, attempt + 1);
    }
    console.error(`  ❌ Respuesta inesperada: "${text.substring(0, 100)}"`);
    throw new Error(`Fudo API error: ${text}`);
  }
}

async function fetchAll(auth, path) {
  let all = [], page = 1, going = true;
  while (going) {
    const url  = `${FUDO_API}/${path}${path.includes('?') ? '&' : '?'}page%5Bsize%5D=250&page%5Bnumber%5D=${page}`;
    const data = await fetchFudoPage(auth, url);
    const batch = data.data || [];
    all = all.concat(batch);
    going = batch.length === 250;
    page++;
  }
  return all;
}

// ── Summary builder ───────────────────────────────────────
async function buildSummary(auth, dateFrom, dateTo) {
  const pmData  = await fetchFudoPage(auth, `${FUDO_API}/payment-methods`);
  await sleep(1000);
  const catData = await fetchAll(auth, 'product-categories');
  await sleep(1000);
  const prodData = await fetchAll(auth, 'products');
  await sleep(1000);

  const paymentMethods = {};
  (pmData.data || []).forEach(pm => { paymentMethods[pm.id] = pm.attributes.name; });

  const categories = {};
  catData.forEach(cat => { categories[cat.id] = cat.attributes.name; });

  const products = {};
  prodData.forEach(prod => {
    const catId = prod.relationships?.productCategory?.data?.id || null;
    products[prod.id] = {
      name:         prod.attributes.name,
      categoryName: catId ? (categories[catId] || 'Sin categoría') : 'Sin categoría'
    };
  });

  let allSales = [], allIncluded = [], page = 1, keepGoing = true;
  while (keepGoing) {
    const salesData = await fetchFudoPage(auth,
      `${FUDO_API}/sales?page%5Bsize%5D=250&page%5Bnumber%5D=${page}&include=payments,tips,items`
    );
    const batch = salesData.data || [];
    allSales    = allSales.concat(batch);
    allIncluded = allIncluded.concat(salesData.included || []);
    keepGoing = batch.length === 250;
    page++;
  }

  const paymentLookup = {}, tipLookup = {}, itemLookup = {};
  allIncluded.forEach(inc => {
    if (inc.type === 'Payment') {
      paymentLookup[inc.id] = {
        amount:   inc.attributes.amount || 0,
        canceled: inc.attributes.canceled,
        methodId: inc.relationships?.paymentMethod?.data?.id
      };
    } else if (inc.type === 'Tip') {
      tipLookup[inc.id] = inc.attributes.amount || 0;
    } else if (inc.type === 'Item') {
      const productId = inc.relationships?.product?.data?.id || null;
      const prod = productId ? products[productId] : null;
      itemLookup[inc.id] = {
        name:         prod?.name || inc.attributes.name || `Producto ${inc.id}`,
        categoryName: prod?.categoryName || 'Sin categoría',
        quantity:     inc.attributes.quantity || 1,
        price:        inc.attributes.price || 0,
        canceled:     inc.attributes.canceled || false
      };
    }
  });

  function toChileDate(isoStr) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Santiago',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date(isoStr));
  }

  const byDay = {}, byPayMethod = {}, byType = {}, byProduct = {};
  let totalRevenue = 0, totalTips = 0, totalOrders = 0;

  allSales.forEach(sale => {
    const attrs = sale.attributes;
    if (!attrs.createdAt || attrs.saleState !== 'CLOSED') return;
    const day = toChileDate(attrs.createdAt);
    if (dateFrom && day < dateFrom) return;
    if (dateTo   && day > dateTo)   return;

    const amount = attrs.total || 0;
    const tips   = (sale.relationships?.tips?.data || [])
      .reduce((s, r) => s + (tipLookup[r.id] || 0), 0);

    totalRevenue += amount;
    totalTips    += tips;
    totalOrders++;

    if (!byDay[day]) byDay[day] = { count: 0, revenue: 0, tips: 0 };
    byDay[day].count++;
    byDay[day].revenue += amount;
    byDay[day].tips    += tips;

    const stype = attrs.saleType || 'OTHER';
    if (!byType[stype]) byType[stype] = { count: 0, revenue: 0 };
    byType[stype].count++;
    byType[stype].revenue += amount;

    (sale.relationships?.payments?.data || []).forEach(payRef => {
      const pay = paymentLookup[payRef.id];
      if (pay && !pay.canceled) {
        const methodName = paymentMethods[pay.methodId] || 'Otro';
        if (!byPayMethod[methodName]) byPayMethod[methodName] = 0;
        byPayMethod[methodName] += pay.amount;
      }
    });

    (sale.relationships?.items?.data || []).forEach(itemRef => {
      const item = itemLookup[itemRef.id];
      if (!item || item.canceled) return;
      const key = item.name;
      if (!byProduct[key]) byProduct[key] = { qty: 0, revenue: 0, categoryName: item.categoryName };
      byProduct[key].qty     += item.quantity;
      byProduct[key].revenue += item.price * item.quantity;
    });
  });

  const days = Object.keys(byDay).sort();
  const totalFromPayments = Object.values(byPayMethod).reduce((s, v) => s + v, 0);
  const topProducts = Object.entries(byProduct)
    .map(([name, v]) => ({ name, qty: v.qty, revenue: v.revenue, category: v.categoryName }))
    .sort((a, b) => b.qty - a.qty);

  return {
    totalRevenue, totalFromPayments, totalTips, totalOrders,
    avgTicket: totalOrders > 0 ? totalRevenue / totalOrders : 0,
    dateRange: { from: days[0] || null, to: days[days.length - 1] || null },
    byDay:    days.map(d => ({ date: d, count: byDay[d].count, revenue: byDay[d].revenue, tips: byDay[d].tips })),
    byPayMethod, byType, topProducts
  };
}

// ── API: restaurants for current user ────────────────────
app.get('/api/restaurants', requireAuth, async (req, res) => {
  try {
    let userDoc = await db.collection('users').doc(req.uid).get();

    // First-time setup: if Firestore has no users yet, make this user admin
    if (!userDoc.exists) {
      const snap = await db.collection('users').limit(1).get();
      if (snap.empty) {
        await db.collection('users').doc(req.uid).set({
          email: req.email, name: req.email, role: 'admin', restaurantIds: []
        });
        userDoc = await db.collection('users').doc(req.uid).get();
      } else {
        return res.status(403).json({ error: 'Usuario no autorizado. Contacta al administrador.' });
      }
    }

    const userData = userDoc.data();
    let restaurants;
    if (userData.role === 'admin') {
      const snap = await db.collection('restaurants').get();
      restaurants = snap.docs.map(d => ({ id: d.id, name: d.data().name }));
    } else {
      const ids  = userData.restaurantIds || [];
      const docs = await Promise.all(ids.map(id => db.collection('restaurants').doc(id).get()));
      restaurants = docs.filter(d => d.exists).map(d => ({ id: d.id, name: d.data().name }));
    }

    res.json({
      restaurants,
      role:       userData.role,
      name:       userData.name,
      modules:    userData.modules    || ['ventas'],
      categories: userData.categories || []
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: summary for one restaurant ──────────────────────
app.get('/api/summary/:restaurantId', requireAuth, async (req, res) => {
  const { restaurantId } = req.params;
  try {
    const userDoc = await db.collection('users').doc(req.uid).get();
    if (!userDoc.exists) return res.status(403).json({ error: 'Usuario no autorizado' });
    const userData = userDoc.data();
    if (userData.role !== 'admin' && !(userData.restaurantIds || []).includes(restaurantId)) {
      return res.status(403).json({ error: 'Sin acceso a este local' });
    }

    const from = req.query.from || null;
    const to   = req.query.to   || null;
    const cacheKey = `${restaurantId}|${from}|${to}`;

    const cached = summaryCache[cacheKey];
    if (cached && (Date.now() - cached.cachedAt) < SUMMARY_TTL) {
      console.log(`Cache hit: ${cacheKey}`);
      return res.json(cached.data);
    }

    const auth    = await getFudoToken(restaurantId);
    const summary = await buildSummary(auth, from, to);
    summaryCache[cacheKey] = { data: summary, cachedAt: Date.now() };
    res.json(summary);
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: restaurants ────────────────────────────────────
app.get('/api/admin/restaurants', requireAuth, async (req, res) => {
  if (!await isAdmin(req.uid)) return res.status(403).json({ error: 'Solo administradores' });
  const snap = await db.collection('restaurants').get();
  res.json({ restaurants: snap.docs.map(d => ({ id: d.id, name: d.data().name, fudoUser: d.data().fudoUser })) });
});

app.post('/api/admin/restaurants', requireAuth, async (req, res) => {
  if (!await isAdmin(req.uid)) return res.status(403).json({ error: 'Solo administradores' });
  const { name, fudoUser, fudoPassword } = req.body;
  if (!name || !fudoUser || !fudoPassword) return res.status(400).json({ error: 'Faltan campos' });
  const ref = await db.collection('restaurants').add({ name, fudoUser, fudoPassword });
  res.json({ id: ref.id });
});

app.delete('/api/admin/restaurants/:id', requireAuth, async (req, res) => {
  if (!await isAdmin(req.uid)) return res.status(403).json({ error: 'Solo administradores' });
  await db.collection('restaurants').doc(req.params.id).delete();
  delete fudoTokenCache[req.params.id];
  res.json({ ok: true });
});

// ── Admin: users ──────────────────────────────────────────
app.get('/api/admin/users', requireAuth, async (req, res) => {
  if (!await isAdmin(req.uid)) return res.status(403).json({ error: 'Solo administradores' });
  const snap = await db.collection('users').get();
  res.json({ users: snap.docs.map(d => ({ uid: d.id, ...d.data() })) });
});

app.post('/api/admin/users', requireAuth, async (req, res) => {
  if (!await isAdmin(req.uid)) return res.status(403).json({ error: 'Solo administradores' });
  const { email, password, name, role, restaurantIds, categories, modules } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
  try {
    const record = await admin.auth().createUser({ email, password, displayName: name || email });
    await db.collection('users').doc(record.uid).set({
      email, name: name || email, role: role || 'user',
      restaurantIds: restaurantIds || [],
      categories:    categories    || [],
      modules:       modules       || ['ventas']
    });
    res.json({ uid: record.uid });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/users/:uid', requireAuth, async (req, res) => {
  if (!await isAdmin(req.uid)) return res.status(403).json({ error: 'Solo administradores' });
  const update = {};
  const { role, restaurantIds, name, categories, modules } = req.body;
  if (role          !== undefined) update.role          = role;
  if (restaurantIds !== undefined) update.restaurantIds = restaurantIds;
  if (name          !== undefined) update.name          = name;
  if (categories    !== undefined) update.categories    = categories;
  if (modules       !== undefined) update.modules       = modules;
  await db.collection('users').doc(req.params.uid).update(update);
  res.json({ ok: true });
});

app.delete('/api/admin/users/:uid', requireAuth, async (req, res) => {
  if (!await isAdmin(req.uid)) return res.status(403).json({ error: 'Solo administradores' });
  await admin.auth().deleteUser(req.params.uid);
  await db.collection('users').doc(req.params.uid).delete();
  res.json({ ok: true });
});

// ── Me ────────────────────────────────────────────────────
app.get('/api/me', requireAuth, async (req, res) => {
  const doc = await db.collection('users').doc(req.uid).get();
  if (!doc.exists) return res.status(403).json({ error: 'Usuario no encontrado' });
  res.json({ uid: req.uid, ...doc.data() });
});

// ── Inventario: Categorías ────────────────────────────────
app.get('/api/inv/categories', requireAuth, async (req, res) => {
  const snap = await db.collection('products').get();
  const cats = new Set();
  snap.docs.forEach(d => { if (d.data().category) cats.add(d.data().category); });
  res.json({ categories: [...cats].sort() });
});

// ── Inventario: Proveedores ───────────────────────────────
app.get('/api/inv/suppliers', requireAuth, async (req, res) => {
  const snap = await db.collection('suppliers').orderBy('name').get();
  res.json({ suppliers: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
});

app.post('/api/inv/suppliers', requireAuth, async (req, res) => {
  if (!await isAdmin(req.uid)) return res.status(403).json({ error: 'Solo administradores' });
  const { name, phone, email, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  const ref = await db.collection('suppliers').add({ name, phone: phone||'', email: email||'', notes: notes||'' });
  res.json({ id: ref.id });
});

app.put('/api/inv/suppliers/:id', requireAuth, async (req, res) => {
  if (!await isAdmin(req.uid)) return res.status(403).json({ error: 'Solo administradores' });
  const { name, phone, email, notes } = req.body;
  await db.collection('suppliers').doc(req.params.id).update({ name, phone: phone||'', email: email||'', notes: notes||'' });
  res.json({ ok: true });
});

app.delete('/api/inv/suppliers/:id', requireAuth, async (req, res) => {
  if (!await isAdmin(req.uid)) return res.status(403).json({ error: 'Solo administradores' });
  await db.collection('suppliers').doc(req.params.id).delete();
  res.json({ ok: true });
});

// ── Inventario: Productos ─────────────────────────────────
app.get('/api/inv/products', requireAuth, async (req, res) => {
  const [prodSnap, supSnap, restSnap] = await Promise.all([
    db.collection('products').orderBy('name').get(),
    db.collection('suppliers').get(),
    db.collection('restaurants').get()
  ]);
  const suppliers   = {};
  const restNames   = {};
  supSnap.docs.forEach(d  => { suppliers[d.id]  = d.data().name; });
  restSnap.docs.forEach(d => { restNames[d.id]  = d.data().name; });
  const products = prodSnap.docs.map(d => {
    const data = d.data();
    return {
      id: d.id, ...data,
      supplierNames:   (data.supplierIds   || []).map(id => suppliers[id]  || id),
      restaurantNames: (data.restaurantIds || []).map(id => restNames[id]  || id)
    };
  });
  res.json({ products });
});

app.post('/api/inv/products', requireAuth, async (req, res) => {
  if (!await isAdmin(req.uid)) return res.status(403).json({ error: 'Solo administradores' });
  const { name, category, unit, supplierIds, restaurantIds } = req.body;
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  const ref = await db.collection('products').add({
    name, category: category||'', unit: unit||'unidad',
    supplierIds: supplierIds||[], restaurantIds: restaurantIds||[]
  });
  res.json({ id: ref.id });
});

app.put('/api/inv/products/:id', requireAuth, async (req, res) => {
  if (!await isAdmin(req.uid)) return res.status(403).json({ error: 'Solo administradores' });
  const { name, category, unit, supplierIds, restaurantIds } = req.body;
  await db.collection('products').doc(req.params.id).update({
    name, category: category||'', unit: unit||'unidad',
    supplierIds: supplierIds||[], restaurantIds: restaurantIds||[]
  });
  res.json({ ok: true });
});

app.delete('/api/inv/products/:id', requireAuth, async (req, res) => {
  if (!await isAdmin(req.uid)) return res.status(403).json({ error: 'Solo administradores' });
  await db.collection('products').doc(req.params.id).delete();
  res.json({ ok: true });
});

// ── Inventario: Stock ─────────────────────────────────────
app.get('/api/inv/stock/:restaurantId', requireAuth, async (req, res) => {
  const { restaurantId } = req.params;
  const userDoc = await db.collection('users').doc(req.uid).get();
  if (!userDoc.exists) return res.status(403).json({ error: 'Sin acceso' });
  const userData = userDoc.data();
  if (userData.role !== 'admin' && !(userData.restaurantIds||[]).includes(restaurantId)) {
    return res.status(403).json({ error: 'Sin acceso a este local' });
  }

  const [prodSnap, stockSnap] = await Promise.all([
    db.collection('products').orderBy('name').get(),
    db.collection('stock').doc(restaurantId).collection('products').get()
  ]);

  const stockMap = {};
  stockSnap.docs.forEach(d => { stockMap[d.id] = d.data(); });

  const allowedCats = userData.categories || []; // empty = all

  // Only products assigned to this restaurant (and filtered by user categories)
  const items = prodSnap.docs
    .filter(d => {
      const data = d.data();
      const inRest = (data.restaurantIds || []).includes(restaurantId);
      const inCat  = allowedCats.length === 0 || allowedCats.includes(data.category);
      return inRest && inCat;
    })
    .map(d => ({
      id: d.id,
      name: d.data().name,
      category: d.data().category || '',
      unit: d.data().unit || 'unidad',
      quantity:    stockMap[d.id]?.quantity    ?? null,
      minQuantity: stockMap[d.id]?.minQuantity ?? null,
      lastUpdated: stockMap[d.id]?.lastUpdated ?? null,
      updatedBy:   stockMap[d.id]?.updatedBy   ?? null,
    }));

  res.json({ items });
});

app.put('/api/inv/stock/:restaurantId/:productId', requireAuth, async (req, res) => {
  const { restaurantId, productId } = req.params;
  const userDoc = await db.collection('users').doc(req.uid).get();
  if (!userDoc.exists) return res.status(403).json({ error: 'Sin acceso' });
  const userData = userDoc.data();
  if (userData.role !== 'admin' && !(userData.restaurantIds||[]).includes(restaurantId)) {
    return res.status(403).json({ error: 'Sin acceso a este local' });
  }

  const { quantity, minQuantity } = req.body;
  await db.collection('stock').doc(restaurantId).collection('products').doc(productId).set({
    quantity:    quantity    !== undefined ? Number(quantity)    : null,
    minQuantity: minQuantity !== undefined ? Number(minQuantity) : null,
    lastUpdated: new Date().toISOString(),
    updatedBy:   req.email
  }, { merge: true });

  res.json({ ok: true });
});

// Guardar inventario histórico + actualizar stock actual
app.post('/api/inv/inventories/:restaurantId', requireAuth, async (req, res) => {
  const { restaurantId } = req.params;
  const userDoc = await db.collection('users').doc(req.uid).get();
  if (!userDoc.exists) return res.status(403).json({ error: 'Sin acceso' });
  const userData = userDoc.data();
  if (userData.role !== 'admin' && !(userData.restaurantIds||[]).includes(restaurantId)) {
    return res.status(403).json({ error: 'Sin acceso a este local' });
  }

  const { date, items } = req.body; // items: [{ productId, name, category, unit, quantity }]
  if (!date || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Fecha e items requeridos' });
  }

  // 1. Save historical record
  const record = {
    restaurantId,
    date,
    createdAt:      new Date().toISOString(),
    createdBy:      req.email,
    createdByName:  userData.name || req.email,
    itemCount:      items.length,
    items
  };
  const ref = await db.collection('inventoryRecords').add(record);

  // 2. Update current stock
  const batch = db.batch();
  for (const { productId, quantity } of items) {
    if (!productId || quantity === undefined) continue;
    const stockRef = db.collection('stock').doc(restaurantId).collection('products').doc(productId);
    batch.set(stockRef, {
      quantity:    Number(quantity),
      lastUpdated: new Date().toISOString(),
      updatedBy:   req.email
    }, { merge: true });
  }
  await batch.commit();

  res.json({ ok: true, id: ref.id });
});

// Listar inventarios históricos de un local
app.get('/api/inv/inventories/:restaurantId', requireAuth, async (req, res) => {
  const { restaurantId } = req.params;
  const userDoc = await db.collection('users').doc(req.uid).get();
  if (!userDoc.exists) return res.status(403).json({ error: 'Sin acceso' });
  const userData = userDoc.data();
  if (userData.role !== 'admin' && !(userData.restaurantIds||[]).includes(restaurantId)) {
    return res.status(403).json({ error: 'Sin acceso a este local' });
  }

  const snap = await db.collection('inventoryRecords')
    .where('restaurantId', '==', restaurantId)
    .orderBy('date', 'desc')
    .limit(60)
    .get();

  const records = snap.docs.map(d => ({
    id: d.id,
    date:          d.data().date,
    createdByName: d.data().createdByName,
    createdBy:     d.data().createdBy,
    itemCount:     d.data().itemCount,
    createdAt:     d.data().createdAt
  }));

  res.json({ records });
});

// Obtener detalle de un inventario
app.get('/api/inv/inventories/:restaurantId/:recordId', requireAuth, async (req, res) => {
  const { restaurantId, recordId } = req.params;
  const userDoc = await db.collection('users').doc(req.uid).get();
  if (!userDoc.exists) return res.status(403).json({ error: 'Sin acceso' });
  const userData = userDoc.data();
  if (userData.role !== 'admin' && !(userData.restaurantIds||[]).includes(restaurantId)) {
    return res.status(403).json({ error: 'Sin acceso a este local' });
  }

  const doc = await db.collection('inventoryRecords').doc(recordId).get();
  if (!doc.exists) return res.status(404).json({ error: 'Registro no encontrado' });
  res.json({ id: doc.id, ...doc.data() });
});

// Añadir cantidad al stock existente
app.post('/api/inv/stock/:restaurantId/:productId/add', requireAuth, async (req, res) => {
  const { restaurantId, productId } = req.params;
  const userDoc = await db.collection('users').doc(req.uid).get();
  if (!userDoc.exists) return res.status(403).json({ error: 'Sin acceso' });
  const userData = userDoc.data();
  if (userData.role !== 'admin' && !(userData.restaurantIds||[]).includes(restaurantId)) {
    return res.status(403).json({ error: 'Sin acceso a este local' });
  }

  const { amount } = req.body;
  if (amount === undefined || isNaN(Number(amount))) return res.status(400).json({ error: 'Cantidad inválida' });

  const ref = db.collection('stock').doc(restaurantId).collection('products').doc(productId);
  const doc = await ref.get();
  const current = doc.exists ? (doc.data().quantity || 0) : 0;
  const newQty  = Math.max(0, current + Number(amount));

  await ref.set({
    quantity:    newQty,
    lastUpdated: new Date().toISOString(),
    updatedBy:   req.email
  }, { merge: true });

  res.json({ ok: true, quantity: newQty });
});

module.exports = app;

if (require.main === module) {
  const PORT = 3737;
  app.listen(PORT, () => console.log(`\n  ✓ Fudo Connect: http://localhost:${PORT}\n`));
}
