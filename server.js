const express        = require('express');
const fetch          = require('node-fetch');
const admin          = require('firebase-admin');
const multer         = require('multer');
const fs             = require('fs');
const os             = require('os');
const path           = require('path');
const { randomUUID } = require('crypto');
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename:    (req, file, cb) => cb(null, `pdf_${Date.now()}_${file.originalname}`)
  }),
  limits: { fileSize: 500 * 1024 * 1024 }
});

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

admin.initializeApp({
  credential:    admin.credential.cert(serviceAccount),
  storageBucket: 'fudo-2cfb7.firebasestorage.app'
});
const db     = admin.firestore();
const bucket = admin.storage().bucket();

const app = express();
app.use(express.json());
app.use(express.static(__dirname, {
  etag: false, lastModified: false,
  setHeaders: res => res.set('Cache-Control', 'no-store')
}));

const FUDO_AUTH = 'https://auth.fu.do/authenticate';
const FUDO_API  = 'https://api.fu.do/v1alpha1';

// ── Caches ────────────────────────────────────────────────
const fudoTokenCache       = {}; // { [restaurantId]: { token, cachedAt } }
const summaryCache         = {}; // { [key]: { data, cachedAt } }
const TOKEN_TTL            = 7 * 60 * 60 * 1000; // 7h
const SUMMARY_TTL          = 10 * 60 * 1000;     // 10 min (in-memory)
const SALES_CACHE_TTL_TODAY = 15 * 60 * 1000;    // 15 min for ranges including today

function getTodayChile() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santiago',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

async function getSalesCached(restaurantId, from, to) {
  const today = getTodayChile();
  const includesToday = !to || to >= today;
  const docId = `${from || 'null'}_${to || 'null'}`;
  try {
    const ref = db.collection('sales_cache').doc(restaurantId).collection('ranges').doc(docId);
    const snap = await ref.get();
    if (!snap.exists) return null;
    const { data, cachedAt } = snap.data();
    if (!includesToday) {
      console.log(`Firestore cache hit (past): ${restaurantId} ${from}-${to}`);
      return data;
    }
    const age = Date.now() - new Date(cachedAt).getTime();
    if (age < SALES_CACHE_TTL_TODAY) {
      console.log(`Firestore cache hit (${Math.round(age/1000)}s old): ${restaurantId} ${from}-${to}`);
      return data;
    }
    return null; // stale
  } catch(e) {
    console.error('getSalesCached error:', e.message);
    return null;
  }
}

async function setSalesCache(restaurantId, from, to, data) {
  const docId = `${from || 'null'}_${to || 'null'}`;
  try {
    const ref = db.collection('sales_cache').doc(restaurantId).collection('ranges').doc(docId);
    // Cap topProducts to avoid Firestore 1MB document limit
    const trimmed = { ...data, topProducts: (data.topProducts || []).slice(0, 200) };
    await ref.set({ data: trimmed, cachedAt: new Date().toISOString(), from: from || null, to: to || null });
    console.log(`✓ Firestore cache saved: ${restaurantId} ${from}-${to} (${(data.topProducts||[]).length} products, ${(data.byDay||[]).length} days)`);
  } catch(e) {
    console.error('setSalesCache error:', e.message);
  }
}

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
      restaurants = snap.docs.map(d => ({ id: d.id, name: d.data().name, sections: d.data().sections || [] }));
    } else {
      const ids  = userData.restaurantIds || [];
      const docs = await Promise.all(ids.map(id => db.collection('restaurants').doc(id).get()));
      restaurants = docs.filter(d => d.exists).map(d => ({ id: d.id, name: d.data().name, sections: d.data().sections || [] }));
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

    const from  = req.query.from  || null;
    const to    = req.query.to    || null;
    const force = req.query.force === 'true';
    const cacheKey = `${restaurantId}|${from}|${to}`;

    if (!force) {
      // 1. In-memory cache (fastest, same process)
      const memCached = summaryCache[cacheKey];
      if (memCached && (Date.now() - memCached.cachedAt) < SUMMARY_TTL) {
        console.log(`Memory cache hit: ${cacheKey}`);
        return res.json(memCached.data);
      }
      // 2. Firestore cache (persists across restarts and Vercel cold starts)
      const fsCached = await getSalesCached(restaurantId, from, to);
      if (fsCached) {
        summaryCache[cacheKey] = { data: fsCached, cachedAt: Date.now() };
        return res.json(fsCached);
      }
    }

    const auth    = await getFudoToken(restaurantId);
    const summary = await buildSummary(auth, from, to);
    summaryCache[cacheKey] = { data: summary, cachedAt: Date.now() };
    setSalesCache(restaurantId, from, to, summary); // async, don't await
    res.json(summary);
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: cache management ───────────────────────────────
app.delete('/api/admin/sales-cache/:restaurantId', requireAuth, async (req, res) => {
  if (!await isAdmin(req.uid)) return res.status(403).json({ error: 'Solo administradores' });
  const { restaurantId } = req.params;
  try {
    const snap = await db.collection('sales_cache').doc(restaurantId).collection('ranges').get();
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    // Also clear in-memory
    Object.keys(summaryCache).forEach(k => { if (k.startsWith(restaurantId + '|')) delete summaryCache[k]; });
    res.json({ ok: true, deleted: snap.size });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: restaurants ────────────────────────────────────
app.get('/api/admin/restaurants', requireAuth, async (req, res) => {
  if (!await isAdmin(req.uid)) return res.status(403).json({ error: 'Solo administradores' });
  const snap = await db.collection('restaurants').get();
  res.json({ restaurants: snap.docs.map(d => ({ id: d.id, name: d.data().name, fudoUser: d.data().fudoUser, sections: d.data().sections || [] })) });
});

app.patch('/api/admin/restaurants/:id', requireAuth, async (req, res) => {
  if (!await isAdmin(req.uid)) return res.status(403).json({ error: 'Solo administradores' });
  const { sections } = req.body;
  await db.collection('restaurants').doc(req.params.id).update({ sections: sections || [] });
  res.json({ ok: true });
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
  const { name, category, unit, supplierIds, restaurantIds, restaurantSections } = req.body;
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  const ref = await db.collection('products').add({
    name, category: category||'', unit: unit||'unidad',
    supplierIds: supplierIds||[], restaurantIds: restaurantIds||[],
    restaurantSections: restaurantSections||{}
  });
  res.json({ id: ref.id });
});

app.put('/api/inv/products/:id', requireAuth, async (req, res) => {
  if (!await isAdmin(req.uid)) return res.status(403).json({ error: 'Solo administradores' });
  const { name, category, unit, supplierIds, restaurantIds, restaurantSections } = req.body;
  await db.collection('products').doc(req.params.id).update({
    name, category: category||'', unit: unit||'unidad',
    supplierIds: supplierIds||[], restaurantIds: restaurantIds||[],
    restaurantSections: restaurantSections||{}
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

  const [prodSnap, stockSnap, supSnap] = await Promise.all([
    db.collection('products').orderBy('name').get(),
    db.collection('stock').doc(restaurantId).collection('products').get(),
    db.collection('suppliers').get()
  ]);

  const stockMap = {};
  stockSnap.docs.forEach(d => { stockMap[d.id] = d.data(); });
  const suppliersMap = {};
  supSnap.docs.forEach(d => { suppliersMap[d.id] = d.data().name; });

  const allowedCats = userData.categories || []; // empty = all
  const sectionFilter = req.query.section || '';

  // Only products assigned to this restaurant (and filtered by user categories)
  const items = prodSnap.docs
    .filter(d => {
      const data = d.data();
      const inRest = (data.restaurantIds || []).includes(restaurantId);
      const inCat  = allowedCats.length === 0 || allowedCats.includes(data.category);
      if (!inRest || !inCat) return false;
      if (sectionFilter) {
        const assignedSections = (data.restaurantSections || {})[restaurantId] || [];
        if (!assignedSections.includes(sectionFilter)) return false;
      }
      return true;
    })
    .map(d => ({
      id: d.id,
      name: d.data().name,
      category: d.data().category || '',
      unit: d.data().unit || 'unidad',
      supplierIds:   d.data().supplierIds || [],
      supplierNames: (d.data().supplierIds || []).map(id => suppliersMap[id] || id),
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

  const { date, items, section } = req.body;
  if (!date || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Fecha e items requeridos' });
  }

  // 1. Save historical record
  const allSupplierIds = [...new Set(items.flatMap(item => item.supplierIds || []))];
  const record = {
    restaurantId,
    date,
    section:        section || '',
    createdAt:      new Date().toISOString(),
    createdBy:      req.email,
    createdByName:  userData.name || req.email,
    itemCount:      items.length,
    supplierIds:    allSupplierIds,
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
    section:       d.data().section || '',
    createdByName: d.data().createdByName,
    createdBy:     d.data().createdBy,
    itemCount:     d.data().itemCount,
    createdAt:     d.data().createdAt,
    supplierIds:   d.data().supplierIds || []
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

  const [doc, supSnap] = await Promise.all([
    db.collection('inventoryRecords').doc(recordId).get(),
    db.collection('suppliers').get()
  ]);
  if (!doc.exists) return res.status(404).json({ error: 'Registro no encontrado' });

  const suppliersMap = {};
  supSnap.docs.forEach(d => { suppliersMap[d.id] = d.data().name; });

  const data = doc.data();
  const itemsWithoutSupplier = (data.items || []).filter(i => !i.supplierIds);
  let productMap = {};
  if (itemsWithoutSupplier.length) {
    const prodDocs = await Promise.all(
      [...new Set(itemsWithoutSupplier.map(i => i.productId))].map(id => db.collection('products').doc(id).get())
    );
    prodDocs.forEach(d => { if (d.exists) productMap[d.id] = d.data(); });
  }

  const enrichedItems = (data.items || []).map(item => {
    const supIds = item.supplierIds?.length ? item.supplierIds : (productMap[item.productId]?.supplierIds || []);
    return { ...item, supplierIds: supIds, supplierNames: supIds.map(id => suppliersMap[id] || id) };
  });

  res.json({ id: doc.id, ...data, items: enrichedItems });
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

// ── Cierres de caja ───────────────────────────────────────
const cierresCache = {}; // { [restaurantId]: { data, cachedAt } }
const CIERRES_TTL  = 10 * 60 * 1000; // 10 min

async function getCierresForRest(restaurantId) {
  const cached = cierresCache[restaurantId];
  if (cached && (Date.now() - cached.cachedAt) < CIERRES_TTL) return cached.data;

  const snap = await db.collection('ingresos')
    .where('restaurantId', '==', restaurantId)
    .get();
  const data = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
  cierresCache[restaurantId] = { data, cachedAt: Date.now() };
  return data;
}

app.get('/api/cierres/:restaurantId', requireAuth, async (req, res) => {
  const { restaurantId } = req.params;
  const userDoc = await db.collection('users').doc(req.uid).get();
  if (!userDoc.exists) return res.status(403).json({ error: 'Sin acceso' });
  const userData = userDoc.data();
  if (userData.role !== 'admin' && !(userData.restaurantIds||[]).includes(restaurantId)) {
    return res.status(403).json({ error: 'Sin acceso a este local' });
  }
  let cierres = await getCierresForRest(restaurantId);
  if (!req.query.all) cierres = cierres.slice(0, 90);
  res.json({ cierres });
});

app.post('/api/cierres', requireAuth, async (req, res) => {
  const userDoc = await db.collection('users').doc(req.uid).get();
  if (!userDoc.exists) return res.status(403).json({ error: 'Sin acceso' });
  const userData = userDoc.data();
  const { restaurantId, fecha, local, totalPrograma, propinasPrograma, transbank, transbankPropinas,
    efectivo, propinaAMano, gastos, garzones, propnasPagadas, comentarios,
    envioDelivery, propinasDelivery, montoDelivery, cantidadDelivery,
    cantidadRetiro, montoRetiro, bookingTotal } = req.body;
  if (!restaurantId || !fecha) return res.status(400).json({ error: 'Local y fecha requeridos' });
  if (userData.role !== 'admin' && !(userData.restaurantIds||[]).includes(restaurantId)) {
    return res.status(403).json({ error: 'Sin acceso a este local' });
  }
  const ref = await db.collection('ingresos').add({
    restaurantId, fecha, local: local||'',
    totalPrograma:    totalPrograma    != null ? Number(totalPrograma)    : null,
    propinasPrograma: propinasPrograma != null ? Number(propinasPrograma) : null,
    transbank:        transbank        != null ? Number(transbank)        : null,
    transbankPropinas:transbankPropinas!= null ? Number(transbankPropinas): null,
    efectivo:         efectivo         != null ? Number(efectivo)         : null,
    propinaAMano:     propinaAMano     != null ? Number(propinaAMano)     : null,
    gastos:           gastos           != null ? Number(gastos)           : null,
    garzones:         garzones         != null ? Number(garzones)         : null,
    propnasPagadas:   propnasPagadas   || null,
    comentarios:      comentarios      || null,
    envioDelivery:    envioDelivery    != null ? Number(envioDelivery)    : null,
    propinasDelivery: propinasDelivery != null ? Number(propinasDelivery) : null,
    montoDelivery:    montoDelivery    != null ? Number(montoDelivery)    : null,
    cantidadDelivery: cantidadDelivery != null ? Number(cantidadDelivery) : null,
    cantidadRetiro:   cantidadRetiro   != null ? Number(cantidadRetiro)   : null,
    montoRetiro:      montoRetiro      != null ? Number(montoRetiro)      : null,
    bookingTotal:     bookingTotal     != null ? Number(bookingTotal)     : null,
    createdAt:   new Date().toISOString(),
    createdBy:   req.email,
    createdByName: userData.name || req.email,
  });
  delete cierresCache[restaurantId]; // invalidar caché
  res.json({ id: ref.id });
});

app.put('/api/cierres/:id', requireAuth, async (req, res) => {
  const userDoc = await db.collection('users').doc(req.uid).get();
  if (!userDoc.exists) return res.status(403).json({ error: 'Sin acceso' });
  const { restaurantId, fecha, local, totalPrograma, propinasPrograma, transbank, transbankPropinas,
    efectivo, propinaAMano, gastos, garzones, propnasPagadas, comentarios,
    envioDelivery, propinasDelivery, montoDelivery, cantidadDelivery,
    cantidadRetiro, montoRetiro, bookingTotal } = req.body;
  const n = v => v != null && v !== '' ? Number(v) : null;
  await db.collection('ingresos').doc(req.params.id).update({
    fecha, local: local||'', restaurantId,
    totalPrograma: n(totalPrograma), propinasPrograma: n(propinasPrograma),
    transbank: n(transbank), transbankPropinas: n(transbankPropinas),
    efectivo: n(efectivo), propinaAMano: n(propinaAMano),
    gastos: n(gastos), garzones: n(garzones),
    propnasPagadas: propnasPagadas||null, comentarios: comentarios||null,
    envioDelivery: n(envioDelivery), propinasDelivery: n(propinasDelivery),
    montoDelivery: n(montoDelivery), cantidadDelivery: n(cantidadDelivery),
    cantidadRetiro: n(cantidadRetiro), montoRetiro: n(montoRetiro),
    bookingTotal: n(bookingTotal),
  });
  if (restaurantId) delete cierresCache[restaurantId];
  res.json({ ok: true });
});

app.delete('/api/cierres/:id', requireAuth, async (req, res) => {
  if (!await isAdmin(req.uid)) return res.status(403).json({ error: 'Solo administradores' });
  const doc = await db.collection('ingresos').doc(req.params.id).get();
  const restId = doc.exists ? doc.data().restaurantId : null;
  await db.collection('ingresos').doc(req.params.id).delete();
  if (restId) delete cierresCache[restId]; // invalidar caché
  res.json({ ok: true });
});

// ── Umbrales por categoría ────────────────────────────────
app.get('/api/settings/thresholds', requireAuth, async (req, res) => {
  const doc = await db.collection('settings').doc('categoryThresholds').get();
  res.json({ thresholds: doc.exists ? doc.data() : {} });
});

app.put('/api/settings/thresholds', requireAuth, async (req, res) => {
  if (!await isAdmin(req.uid)) return res.status(403).json({ error: 'Solo administradores' });
  await db.collection('settings').doc('categoryThresholds').set(req.body);
  res.json({ ok: true });
});

// ── Manuales / PDFs (Firebase Storage) ───────────────────
app.get('/api/manuals', requireAuth, async (req, res) => {
  try {
    const snap = await db.collection('manuals').orderBy('createdAt', 'desc').get();
    res.json({ manuals: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/manuals/:id/file', requireAuth, async (req, res) => {
  try {
    const doc = await db.collection('manuals').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'No encontrado' });
    const { fileName, title, size } = doc.data();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(title)}.pdf"`);
    if (size) res.setHeader('Content-Length', size);
    bucket.file(fileName).createReadStream()
      .on('error', e => res.status(500).end())
      .pipe(res);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/manuals', requireAuth, (req, res, next) => {
  upload.single('pdf')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  try {
    if (!await isAdmin(req.uid)) return res.status(403).json({ error: 'Solo administradores' });
    if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });
    const { title, restaurantId } = req.body;
    if (!title) return res.status(400).json({ error: 'Título requerido' });

    const fileName = `manuals/${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g,'_')}`;
    await new Promise((resolve, reject) => {
      const ws = bucket.file(fileName).createWriteStream({ contentType: 'application/pdf', resumable: true });
      fs.createReadStream(req.file.path).on('error', reject).pipe(ws).on('error', reject).on('finish', resolve);
    });
    fs.unlink(req.file.path, () => {});

    const ref = await db.collection('manuals').add({
      title, fileName, size: req.file.size,
      restaurantId: restaurantId || null,
      createdAt: new Date().toISOString(),
      createdBy: req.uid
    });
    res.json({ id: ref.id });
  } catch(e) {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/manuals/:id', requireAuth, async (req, res) => {
  try {
    if (!await isAdmin(req.uid)) return res.status(403).json({ error: 'Solo administradores' });
    const { title, restaurantId } = req.body;
    if (!title) return res.status(400).json({ error: 'Título requerido' });
    await db.collection('manuals').doc(req.params.id).update({ title, restaurantId: restaurantId || null });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/manuals/:id', requireAuth, async (req, res) => {
  try {
    if (!await isAdmin(req.uid)) return res.status(403).json({ error: 'Solo administradores' });
    const doc = await db.collection('manuals').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'No encontrado' });
    const { fileName } = doc.data();
    try { await bucket.file(fileName).delete(); } catch {}
    await db.collection('manuals').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = app;

if (require.main === module) {
  const PORT = 3737;
  app.listen(PORT, () => console.log(`\n  ✓ Fudo Connect: http://localhost:${PORT}\n`));
}
