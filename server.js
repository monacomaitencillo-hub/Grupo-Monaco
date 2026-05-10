require('dotenv').config();
const express        = require('express');
const fetch          = require('node-fetch');
const admin          = require('firebase-admin');
const multer         = require('multer');
const fs             = require('fs');
const os             = require('os');
const path           = require('path');
const { randomUUID } = require('crypto');
const Anthropic      = require('@anthropic-ai/sdk');
const XLSX           = require('xlsx');

const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
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
app.use(express.json({ limit: '5mb' }));
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'landing.html'));
});
app.get('/admin', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/portal', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'portal.html'));
});
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

// Per-day cache helpers
// sales_cache/{restaurantId}/days/{YYYY-MM-DD}

function getDaysInRange(from, to) {
  const days = [];
  const d   = new Date(from + 'T12:00:00Z');
  const end = new Date(to   + 'T12:00:00Z');
  while (d <= end) {
    days.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

async function getDaysCached(restaurantId, days, today) {
  if (!days.length) return {};
  const refs = days.map(d =>
    db.collection('sales_cache').doc(restaurantId).collection('days').doc(d)
  );
  const snaps = await db.getAll(...refs);
  const result = {};
  snaps.forEach((snap, i) => {
    if (!snap.exists) return;
    result[days[i]] = snap.data(); // días pasados Y hoy: siempre devolver si existe
  });
  return result;
}

// Devuelve true si hoy está en cache pero viejo (necesita refresh en background)
function todayIsStale(dayDocs, today) {
  if (!dayDocs[today]) return false;
  return (Date.now() - new Date(dayDocs[today].cachedAt).getTime()) > SALES_CACHE_TTL_TODAY;
}

// Devuelve true si ayer fue cacheado antes de que terminara el día (puede estar incompleto)
function yesterdayIsStale(dayDocs, yesterday, today) {
  if (!dayDocs[yesterday]) return false;
  // Si fue cacheado antes de hoy (es decir, durante el día de ayer), puede tener datos incompletos
  const cachedAt = new Date(dayDocs[yesterday].cachedAt);
  const todayStart = new Date(today + 'T03:00:00Z'); // medianoche Chile = 03:00 UTC
  return cachedAt < todayStart;
}

function getYesterdayChile(today) {
  const d = new Date(today + 'T12:00:00Z');
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Fetch one or more specific days from Fudo using date filters.
// Lookups (payment methods, categories, products) are fetched only once for all days.
async function fetchDaysFromFudo(auth, days) {
  if (!days.length) return {};

  const [pmData, catData, prodData] = await Promise.all([
    fetchFudoPage(auth, `${FUDO_API}/payment-methods`),
    fetchAll(auth, 'product-categories'),
    fetchAll(auth, 'products')
  ]);

  const paymentMethods = {};
  (pmData.data || []).forEach(pm => { paymentMethods[pm.id] = pm.attributes.name; });

  const categories = {};
  catData.forEach(c => { categories[c.id] = c.attributes.name; });

  const products = {};
  prodData.forEach(p => {
    const catId = p.relationships?.productCategory?.data?.id || null;
    products[p.id] = {
      name:         p.attributes.name,
      categoryName: catId ? (categories[catId] || 'Sin categoría') : 'Sin categoría'
    };
  });

  // Fetch all days in a single range request instead of one per day
  const sortedDays = [...days].sort();
  const firstDay   = sortedDays[0];
  const lastDay    = sortedDays[sortedDays.length - 1];
  const dayAfterLast = new Date(new Date(lastDay + 'T00:00:00Z').getTime() + 86400000).toISOString().substring(0, 10);
  const dateFilter = `filter%5BcreatedAt%5D=${encodeURIComponent(`gte.${firstDay}T03:00:00,lte.${dayAfterLast}T02:59:59`)}`;

  let allSales = [], allIncluded = [], page = 1, keepGoing = true;
  while (keepGoing) {
    const salesData = await fetchFudoPage(auth,
      `${FUDO_API}/sales?${dateFilter}&page%5Bsize%5D=250&page%5Bnumber%5D=${page}&include=payments,tips,items`
    );
    const batch = salesData.data || [];
    allSales    = allSales.concat(batch);
    allIncluded = allIncluded.concat(salesData.included || []);
    keepGoing   = batch.length === 250;
    page++;
  }
  console.log(`  Fudo (${firstDay}→${lastDay}): ${allSales.length} ventas en ${days.length} días`);

  const paymentLookup = {}, tipLookup = {}, itemLookup = {};
  allIncluded.forEach(inc => {
    if (inc.type === 'Payment') {
      paymentLookup[inc.id] = { amount: inc.attributes.amount || 0, canceled: inc.attributes.canceled, methodId: inc.relationships?.paymentMethod?.data?.id };
    } else if (inc.type === 'Tip') {
      tipLookup[inc.id] = inc.attributes.amount || 0;
    } else if (inc.type === 'Item') {
      const prod = products[inc.relationships?.product?.data?.id];
      itemLookup[inc.id] = {
        name: prod?.name || inc.attributes.name || 'Producto',
        categoryName: prod?.categoryName || 'Sin categoría',
        quantity: inc.attributes.quantity || 1,
        price:    inc.attributes.price    || 0,
        canceled: inc.attributes.canceled || false
      };
    }
  });

  // Initialize empty data for all requested days (marks them as fetched even if no sales)
  const daySet = new Set(days);
  const result = {};
  days.forEach(d => {
    result[d] = { total: 0, tips: 0, ordersCount: 0, byPayMethod: {}, byType: {}, products: {} };
  });

  // Assign each sale to its Chile date (UTC-3)
  allSales.forEach(sale => {
    const createdAt = sale.attributes.createdAt;
    if (!createdAt) return;
    const chileDay = new Date(new Date(createdAt).getTime() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (!daySet.has(chileDay)) return;
    const dayData = result[chileDay];

    const amount = sale.attributes.total || 0;
    const tips   = (sale.relationships?.tips?.data || []).reduce((s, r) => s + (tipLookup[r.id] || 0), 0);
    (sale.relationships?.payments?.data || []).forEach(r => {
      const pay = paymentLookup[r.id];
      if (pay && !pay.canceled) {
        const m = paymentMethods[pay.methodId] || 'Otro';
        dayData.byPayMethod[m] = (dayData.byPayMethod[m] || 0) + pay.amount;
      }
    });
    dayData.total       += amount;
    dayData.tips        += tips;
    dayData.ordersCount += 1;
    const stype = sale.attributes.saleType || 'OTHER';
    if (!dayData.byType[stype]) dayData.byType[stype] = { count: 0, revenue: 0 };
    dayData.byType[stype].count++;
    dayData.byType[stype].revenue += amount;
    (sale.relationships?.items?.data || []).forEach(r => {
      const item = itemLookup[r.id];
      if (!item || item.canceled) return;
      if (!dayData.products[item.name]) dayData.products[item.name] = { qty: 0, revenue: 0, category: item.categoryName };
      dayData.products[item.name].qty     += item.quantity;
      dayData.products[item.name].revenue += item.price * item.quantity;
    });
  });

  // Convert products dict to array
  days.forEach(d => {
    result[d].products = Object.entries(result[d].products)
      .map(([name, v]) => ({ name, qty: v.qty, revenue: v.revenue, category: v.category }));
  });

  return result;
}

async function refreshTodayInBackground(restaurantId, today) {
  try {
    console.log(`Background refresh hoy (${today}) para ${restaurantId}...`);
    const auth   = await getFudoToken(restaurantId);
    const result = await fetchDaysFromFudo(auth, [today]);
    await storeDaysCache(restaurantId, result);
    Object.keys(summaryCache).forEach(k => { if (k.startsWith(restaurantId + '|')) delete summaryCache[k]; });
    console.log(`✓ Refresh completado para ${today} (${result[today]?.ordersCount} ventas)`);
  } catch(e) {
    console.error('refreshTodayInBackground error:', e.message);
  }
}

async function storeDaysCache(restaurantId, perDay) {
  const entries = Object.entries(perDay);
  if (!entries.length) return;
  const batch    = db.batch();
  const cachedAt = new Date().toISOString();
  entries.forEach(([fecha, dayData]) => {
    const ref = db.collection('sales_cache').doc(restaurantId).collection('days').doc(fecha);
    batch.set(ref, { ...dayData, cachedAt });
  });
  try {
    await batch.commit();
    console.log(`✓ Guardados ${entries.length} día(s) en Firestore cache (${restaurantId})`);
  } catch(e) {
    console.error('storeDaysCache error:', e.message);
  }
}

function assembleFromDayCache(dayDocs, days) {
  let totalRevenue = 0, totalTips = 0, totalOrders = 0;
  const byDayArr = [], byPayMethod = {}, byType = {}, byProductMap = {};
  for (const fecha of days) {
    const d = dayDocs[fecha];
    if (!d) continue;
    totalRevenue += d.total      || 0;
    totalTips    += d.tips       || 0;
    totalOrders  += d.ordersCount|| 0;
    byDayArr.push({ date: fecha, count: d.ordersCount || 0, revenue: d.total || 0, tips: d.tips || 0 });
    for (const [k, v] of Object.entries(d.byPayMethod || {})) {
      byPayMethod[k] = (byPayMethod[k] || 0) + v;
    }
    for (const [k, v] of Object.entries(d.byType || {})) {
      if (!byType[k]) byType[k] = { count: 0, revenue: 0 };
      byType[k].count   += v.count   || 0;
      byType[k].revenue += v.revenue || 0;
    }
    for (const p of (d.products || [])) {
      if (!byProductMap[p.name]) byProductMap[p.name] = { qty: 0, revenue: 0, category: p.category };
      byProductMap[p.name].qty     += p.qty     || 0;
      byProductMap[p.name].revenue += p.revenue || 0;
    }
  }
  const topProducts = Object.entries(byProductMap)
    .map(([name, v]) => ({ name, qty: v.qty, revenue: v.revenue, category: v.category }))
    .sort((a, b) => b.qty - a.qty);
  const presentDays = days.filter(d => dayDocs[d]);
  return {
    totalRevenue,
    totalFromPayments: Object.values(byPayMethod).reduce((s, v) => s + v, 0),
    totalTips, totalOrders,
    avgTicket: totalOrders > 0 ? totalRevenue / totalOrders : 0,
    dateRange: { from: presentDays[0] || null, to: presentDays[presentDays.length - 1] || null },
    byDay: byDayArr, byPayMethod, byType, topProducts
  };
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

async function requireBuyer(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'No autenticado' });
  try {
    const decoded = await admin.auth().verifyIdToken(auth.slice(7));
    if (decoded.type !== 'buyer') return res.status(403).json({ error: 'Acceso denegado' });
    req.uid   = decoded.uid;
    req.email = decoded.email;
    next();
  } catch { res.status(401).json({ error: 'Token inválido' }); }
}

async function isAdmin(uid) {
  const doc = await db.collection('users').doc(uid).get();
  return doc.exists && doc.data().role === 'superadmin';
}

async function isEditor(uid) {
  const doc = await db.collection('users').doc(uid).get();
  const role = doc.exists && doc.data().role;
  return role === 'admin' || role === 'superadmin';
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

  // ── Paso 1: acumular TODOS los días de Fudo en perDay (sin filtro de fecha) ──
  const perDay = {};

  allSales.forEach(sale => {
    const attrs = sale.attributes;
    if (!attrs.createdAt) return;
    const day    = toChileDate(attrs.createdAt);
    const amount = attrs.total || 0;
    const tips   = (sale.relationships?.tips?.data || [])
      .reduce((s, r) => s + (tipLookup[r.id] || 0), 0);

    if (!perDay[day]) perDay[day] = { total: 0, tips: 0, ordersCount: 0, byPayMethod: {}, byType: {}, products: {} };
    perDay[day].tips        += tips;
    perDay[day].ordersCount += 1;
    perDay[day].total       += amount;

    const stype = attrs.saleType || 'OTHER';
    if (!perDay[day].byType[stype]) perDay[day].byType[stype] = { count: 0, revenue: 0 };
    perDay[day].byType[stype].count++;
    perDay[day].byType[stype].revenue += amount;

    (sale.relationships?.payments?.data || []).forEach(payRef => {
      const pay = paymentLookup[payRef.id];
      if (pay && !pay.canceled) {
        const m = paymentMethods[pay.methodId] || 'Otro';
        if (!perDay[day].byPayMethod[m]) perDay[day].byPayMethod[m] = 0;
        perDay[day].byPayMethod[m] += pay.amount;
      }
    });

    (sale.relationships?.items?.data || []).forEach(itemRef => {
      const item = itemLookup[itemRef.id];
      if (!item || item.canceled) return;
      if (!perDay[day].products[item.name]) perDay[day].products[item.name] = { qty: 0, revenue: 0, category: item.categoryName };
      perDay[day].products[item.name].qty     += item.quantity;
      perDay[day].products[item.name].revenue += item.price * item.quantity;
    });
  });

  // ── Paso 2: convertir products a array ──
  const perDayFinal = {};
  for (const [fecha, d] of Object.entries(perDay)) {
    perDayFinal[fecha] = {
      total: d.total, tips: d.tips, ordersCount: d.ordersCount,
      byPayMethod: d.byPayMethod, byType: d.byType,
      products: Object.entries(d.products)
        .map(([name, v]) => ({ name, qty: v.qty, revenue: v.revenue, category: v.category }))
    };
  }

  // ── Paso 3: armar resumen del rango pedido desde perDayFinal ──
  const rangeDays = Object.keys(perDayFinal)
    .filter(d => (!dateFrom || d >= dateFrom) && (!dateTo || d <= dateTo))
    .sort();

  const summary = assembleFromDayCache(perDayFinal, rangeDays);
  console.log(`Fudo → ${Object.keys(perDayFinal).length} días totales, mostrando ${rangeDays.length} días (${dateFrom}-${dateTo})`);

  return { ...summary, perDay: perDayFinal };
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
      restaurants = snap.docs.map(d => ({ id: d.id, name: d.data().name, sections: d.data().sections || [], noFudo: !!d.data().noFudo }));
    } else {
      const ids  = userData.restaurantIds || [];
      const docs = await Promise.all(ids.map(id => db.collection('restaurants').doc(id).get()));
      restaurants = docs.filter(d => d.exists).map(d => ({ id: d.id, name: d.data().name, sections: d.data().sections || [], noFudo: !!d.data().noFudo }));
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
  res.set('Cache-Control', 'no-store');
  const { restaurantId } = req.params;
  try {
    const userDoc = await db.collection('users').doc(req.uid).get();
    if (!userDoc.exists) return res.status(403).json({ error: 'Usuario no autorizado' });
    const userData = userDoc.data();
    if (userData.role !== 'admin' && userData.role !== 'superadmin' && !(userData.restaurantIds || []).includes(restaurantId)) {
      return res.status(403).json({ error: 'Sin acceso a este local' });
    }

    const today     = getTodayChile();
    const yesterday = getYesterdayChile(today);
    const from     = req.query.from  || null;
    const to       = req.query.to    || null;
    const force    = req.query.force === 'true';
    const cacheKey = `${restaurantId}|${from}|${to}`;

    if (!force) {
      // 1. In-memory (mismo proceso, más rápido)
      const memCached = summaryCache[cacheKey];
      if (memCached && (Date.now() - memCached.cachedAt) < SUMMARY_TTL) {
        console.log(`Memory cache hit: ${cacheKey}`);
        return res.json(memCached.data);
      }

      // 2. Sin fechas ("Todo") → leer todos los días de Firestore
      if (!from && !to) {
        const snap = await db.collection('sales_cache').doc(restaurantId).collection('days').get();
        if (!snap.empty) {
          const dayDocs = {};
          snap.docs.forEach(d => { dayDocs[d.id] = d.data(); });
          const days = Object.keys(dayDocs).sort();
          console.log(`Firestore all-time hit: ${days.length} días para ${restaurantId}`);
          const assembled = assembleFromDayCache(dayDocs, days);
          summaryCache[cacheKey] = { data: assembled, cachedAt: Date.now() };
          // Refresh hoy y ayer si están desactualizados
          if (!dayDocs[today] || todayIsStale(dayDocs, today)) refreshTodayInBackground(restaurantId, today);
          if (yesterdayIsStale(dayDocs, yesterday, today)) refreshTodayInBackground(restaurantId, yesterday);
          return res.json(assembled);
        }
        // Sin cache en Firestore → fetch inicial completo desde Fudo
      }

      // 3. Firestore per-day cache para rangos con fechas
      if (from && to) {
        const allDays = getDaysInRange(from, to);
        // Los días futuros nunca están en Fudo — solo consultamos hasta hoy
        const days    = allDays.filter(d => d <= today);
        const dayDocs = await getDaysCached(restaurantId, days, today);
        const missingDays = days.filter(d => !dayDocs[d]);

        if (missingDays.length === 0) {
          // Todos los días hasta hoy están en Firestore → responder al instante
          console.log(`Firestore cache hit: ${restaurantId} ${from}-${to} (${days.length} días)`);
          const assembled = assembleFromDayCache(dayDocs, allDays);
          summaryCache[cacheKey] = { data: assembled, cachedAt: Date.now() };
          if (todayIsStale(dayDocs, today)) refreshTodayInBackground(restaurantId, today);
          if (yesterdayIsStale(dayDocs, yesterday, today)) refreshTodayInBackground(restaurantId, yesterday);
          return res.json(assembled);
        }

        // Solo falta hoy → devolver pasado al instante + refrescar hoy en background
        const missingPastDays = missingDays.filter(d => d < today);
        if (missingPastDays.length === 0 && Object.keys(dayDocs).length > 0) {
          console.log(`Pasado en Firestore (${Object.keys(dayDocs).length} días), solo falta hoy → background refresh`);
          const assembled = assembleFromDayCache(dayDocs, allDays);
          summaryCache[cacheKey] = { data: assembled, cachedAt: Date.now() };
          refreshTodayInBackground(restaurantId, today);
          if (yesterdayIsStale(dayDocs, yesterday, today)) refreshTodayInBackground(restaurantId, yesterday);
          return res.json(assembled);
        }

        // Faltan días pasados → fetch solo los días faltantes hasta hoy (nunca futuros)
        console.log(`Fetching ${missingDays.length} días faltantes de Fudo: ${missingDays.join(', ')}`);
        const auth        = await getFudoToken(restaurantId);
        const fetchedDays = await fetchDaysFromFudo(auth, missingDays);
        await storeDaysCache(restaurantId, fetchedDays);
        const allDayDocs  = { ...dayDocs, ...fetchedDays };
        const assembled   = assembleFromDayCache(allDayDocs, allDays);
        summaryCache[cacheKey] = { data: assembled, cachedAt: Date.now() };
        return res.json(assembled);
      }
    }

    // Fetch inicial completo desde Fudo — solo para "Todo" sin ningún cache en Firestore
    const auth    = await getFudoToken(restaurantId);
    const summary = await buildSummary(auth, from, to);
    const { perDay, ...clientSummary } = summary;
    summaryCache[cacheKey] = { data: clientSummary, cachedAt: Date.now() };
    if (perDay && Object.keys(perDay).length) storeDaysCache(restaurantId, perDay);
    res.json(clientSummary);
  } catch(e) {
    console.error(e);
    // Si el error es de credenciales Fudo, devolver datos vacíos con aviso (no crashear el frontend)
    if (e.message?.includes('autenticar con Fudo') || e.message?.includes('No se pudo')) {
      return res.json({ noData: true, reason: 'Sin credenciales de Fudo válidas para este local' });
    }
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: diagnóstico Fudo ───────────────────────────────
app.get('/api/admin/fudo-test/:restaurantId', requireAuth, async (req, res) => {
  if (!await isAdmin(req.uid)) return res.status(403).json({ error: 'Solo administradores' });
  try {
    const auth     = await getFudoToken(req.params.restaurantId);
    const salesData = await fetchFudoPage(auth,
      `${FUDO_API}/sales?page%5Bsize%5D=10&page%5Bnumber%5D=1&include=payments,tips,items`
    );
    const sales    = salesData.data || [];
    const states   = [...new Set(sales.map(s => s.attributes?.saleState))];
    const sample   = sales.slice(0, 3).map(s => ({
      id:        s.id,
      state:     s.attributes?.saleState,
      total:     s.attributes?.total,
      createdAt: s.attributes?.createdAt
    }));
    res.json({ totalFetched: sales.length, states, sample, authOk: true });
  } catch(e) {
    res.json({ authOk: false, error: e.message });
  }
});

// ── Admin: diagnóstico detallado para un día específico ───
// GET /api/admin/day-check/:restaurantId?date=2026-03-15
app.get('/api/admin/day-check/:restaurantId', requireAuth, async (req, res) => {
  if (!await isAdmin(req.uid)) return res.status(403).json({ error: 'Solo administradores' });
  try {
    const { restaurantId } = req.params;
    const date = req.query.date || getTodayChile();
    const nextDay = new Date(new Date(date + 'T00:00:00Z').getTime() + 86400000).toISOString().substring(0, 10);
    const dateFilter = `filter%5BcreatedAt%5D=${encodeURIComponent(`gte.${date}T03:00:00,lte.${nextDay}T02:59:59`)}`;

    const auth = await getFudoToken(restaurantId);
    let allSales = [], page = 1, keepGoing = true;
    while (keepGoing) {
      const data = await fetchFudoPage(auth,
        `${FUDO_API}/sales?${dateFilter}&page%5Bsize%5D=250&page%5Bnumber%5D=${page}`
      );
      const batch = data.data || [];
      allSales = allSales.concat(batch);
      keepGoing = batch.length === 250;
      page++;
    }

    // Agrupar por saleState
    const byState = {};
    let totalAll = 0;
    allSales.forEach(s => {
      const state = s.attributes?.saleState || 'UNKNOWN';
      if (!byState[state]) byState[state] = { count: 0, total: 0 };
      byState[state].count++;
      byState[state].total += s.attributes?.total || 0;
      totalAll += s.attributes?.total || 0;
    });

    // Caché en Firestore para ese día
    const cached = await db.collection('sales_cache').doc(restaurantId).collection('days').doc(date).get();
    const cachedData = cached.exists ? cached.data() : null;

    res.json({
      date,
      fudo: { totalOrders: allSales.length, totalRevenue: totalAll, byState },
      cached: cachedData ? { ordersCount: cachedData.ordersCount, total: cachedData.total, cachedAt: cachedData.cachedAt } : null
    });
  } catch(e) {
    res.json({ error: e.message });
  }
});

// ── Admin: cache management ───────────────────────────────
app.delete('/api/admin/sales-cache/:restaurantId', requireAuth, async (req, res) => {
  if (!await isAdmin(req.uid)) return res.status(403).json({ error: 'Solo administradores' });
  const { restaurantId } = req.params;
  try {
    const snap = await db.collection('sales_cache').doc(restaurantId).collection('days').get();
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
  res.json({ restaurants: snap.docs.map(d => ({ id: d.id, name: d.data().name, fudoUser: d.data().fudoUser, sections: d.data().sections || [], noFudo: !!d.data().noFudo })) });
});

app.patch('/api/admin/restaurants/:id', requireAuth, async (req, res) => {
  if (!await isAdmin(req.uid)) return res.status(403).json({ error: 'Solo administradores' });
  const { sections } = req.body;
  await db.collection('restaurants').doc(req.params.id).update({ sections: sections || [] });
  res.json({ ok: true });
});

app.post('/api/admin/restaurants', requireAuth, async (req, res) => {
  if (!await isAdmin(req.uid)) return res.status(403).json({ error: 'Solo administradores' });
  const { name, fudoUser, fudoPassword, noFudo } = req.body;
  if (!name) return res.status(400).json({ error: 'Faltan campos' });
  if (!noFudo && (!fudoUser || !fudoPassword)) return res.status(400).json({ error: 'Faltan usuario y contraseña Fudo' });
  const data = { name, noFudo: !!noFudo };
  if (!noFudo) { data.fudoUser = fudoUser; data.fudoPassword = fudoPassword; }
  const ref = await db.collection('restaurants').add(data);
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
  if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
  const { name, phone, email, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  const ref = await db.collection('suppliers').add({ name, phone: phone||'', email: email||'', notes: notes||'' });
  res.json({ id: ref.id });
});

app.put('/api/inv/suppliers/:id', requireAuth, async (req, res) => {
  if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
  const { name, phone, email, notes } = req.body;
  await db.collection('suppliers').doc(req.params.id).update({ name, phone: phone||'', email: email||'', notes: notes||'' });
  res.json({ ok: true });
});

app.delete('/api/inv/suppliers/:id', requireAuth, async (req, res) => {
  if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
  await db.collection('suppliers').doc(req.params.id).delete();
  res.json({ ok: true });
});

// ── Inventario: Productos ─────────────────────────────────
app.get('/api/inv/products', requireAuth, async (req, res) => {
  const [prodSnap, supSnap, restSnap, priceSnap] = await Promise.all([
    db.collection('products').orderBy('name').get(),
    db.collection('suppliers').get(),
    db.collection('restaurants').get(),
    db.collection('product_price_history').get()
  ]);
  const suppliers = {};
  const restNames = {};
  supSnap.docs.forEach(d  => { suppliers[d.id] = d.data().name; });
  restSnap.docs.forEach(d => { restNames[d.id] = d.data().name; });

  // Build latestPrice map: productId → precio del mes más reciente
  const latestPriceMap = {};
  priceSnap.docs.forEach(d => {
    const { productId, mes, precio } = d.data();
    if (!productId) return;
    if (!latestPriceMap[productId] || mes > latestPriceMap[productId].mes) {
      latestPriceMap[productId] = { mes, precio };
    }
  });

  const products = prodSnap.docs.map(d => {
    const data = d.data();
    return {
      id: d.id, ...data,
      supplierNames:   (data.supplierIds  || []).map(id => suppliers[id] || id),
      restaurantNames: (data.restaurantIds|| []).map(id => restNames[id] || id),
      costPerUnit: latestPriceMap[d.id]?.precio ?? data.costPerUnit ?? 0,
      latestPriceMes: latestPriceMap[d.id]?.mes ?? null
    };
  });
  res.json({ products });
});

app.post('/api/inv/products', requireAuth, async (req, res) => {
  if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
  const { name, category, unit, tipoImpuesto, supplierIds, restaurantIds, restaurantSections, esGDD, costPerUnit } = req.body;
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  const ref = await db.collection('products').add({
    name, category: category||'', unit: unit||'unidad',
    tipoImpuesto: tipoImpuesto || 'alimento',
    supplierIds: supplierIds||[], restaurantIds: restaurantIds||[],
    restaurantSections: restaurantSections||{},
    esGDD: esGDD === true,
    costPerUnit: costPerUnit != null ? Number(costPerUnit) : 0
  });
  res.json({ id: ref.id });
});

app.put('/api/inv/products/:id', requireAuth, async (req, res) => {
  if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
  const { name, category, unit, tipoImpuesto, supplierIds, restaurantIds, restaurantSections, esGDD, costPerUnit, capacidadCC } = req.body;
  await db.collection('products').doc(req.params.id).update({
    name, category: category||'', unit: unit||'unidad',
    tipoImpuesto: tipoImpuesto || 'alimento',
    supplierIds: supplierIds||[], restaurantIds: restaurantIds||[],
    restaurantSections: restaurantSections||{},
    esGDD: esGDD === true,
    costPerUnit: costPerUnit != null ? Number(costPerUnit) : 0,
    capacidadCC: capacidadCC != null ? Math.max(0, Number(capacidadCC) || 0) : 0
  });
  res.json({ ok: true });
});

app.patch('/api/inv/products/:id/cost', requireAuth, async (req, res) => {
  if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
  const { costPerUnit } = req.body;
  await db.collection('products').doc(req.params.id).update({ costPerUnit: Number(costPerUnit) || 0 });
  res.json({ ok: true });
});

// ── Historial de Precios por Producto ─────────────────────
app.get('/api/inv/products/:id/prices', requireAuth, async (req, res) => {
  const snap = await db.collection('product_price_history')
    .where('productId', '==', req.params.id)
    .get();
  const prices = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => b.mes.localeCompare(a.mes));
  res.json({ prices });
});

// Divisores de impuesto por tipo (Chile)
const TAX_DIVISORS = {
  alimento:        1.19,   // IVA 19%
  carne:           1.24,   // IVA 19% + imp. carne 5%
  cerveza:         1.395,  // IVA 19% + ILA 20.5%
  vino_licor:      1.505,  // IVA 19% + ILA 31.5%
  beb_azucarada:   1.37,   // IVA 19% + IABA 18%
  beb_sin_azucar:  1.29,   // IVA 19% + IABA 10%
  harina:          1.31,   // IVA 19% + imp. 12%
  sin_impuesto:    1.00
};
// Tasas adicionales (sin IVA) — incluidas en costo, IVA excluido
const ILA_RATES = {
  alimento:        0,
  carne:           0.05,   // 5%
  cerveza:         0.205,  // 20.5%
  vino_licor:      0.315,  // 31.5%
  beb_azucarada:   0.18,   // 18%
  beb_sin_azucar:  0.10,   // 10%
  harina:          0.12,   // 12%
  sin_impuesto:    0
};

app.post('/api/inv/products/:id/prices', requireAuth, async (req, res) => {
  if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
  const { mes, precio, precioBruto, precioNeto, descuento, cantidadCompra, unidadCompra, tipoImpuesto, fleteNeto, capacidadCC, unidadesPorEnvase } = req.body;
  if (!mes) return res.status(400).json({ error: 'Faltan campos' });

  // Si viene el flujo detallado, calcular costo unitario
  let costoUnitario;
  const envase = (unidadesPorEnvase != null && Number(unidadesPorEnvase) > 0) ? Number(unidadesPorEnvase) : 1;
  let entry = { productId: req.params.id, mes, unidadesPorEnvase: envase };

  if (precioNeto != null) {
    // Flujo nuevo: usuario ingresa precio neto → calculamos bruto
    const divisor          = TAX_DIVISORS[tipoImpuesto] || 1.19;
    const dto              = Math.max(0, Math.min(100, Number(descuento) || 0));
    const cantidad         = Math.max(0.0001, Number(cantidadCompra) || 1);
    const neto             = Number(precioNeto);
    const netoConDto       = neto * (1 - dto / 100);
    const brutoRef         = neto * divisor;
    const ccBotella        = Math.max(0, Number(capacidadCC) || 0);
    const flete            = Math.max(0, Number(fleteNeto) || 0);

    const ilaRate = ILA_RATES[tipoImpuesto] || 0;
    const ila     = netoConDto * ilaRate;
    if (ccBotella > 0) {
      // Fórmula tragos: (netoConDto + ILA) / cantidad + fleteNeto → dividir por cc
      const costoBotella = (netoConDto + ila) / cantidad + flete;
      costoUnitario      = costoBotella / ccBotella;
    } else {
      // Fórmula normal: (netoConDto + imp.adicional) / cantidad + flete por unidad
      costoUnitario = (netoConDto + ila) / cantidad + flete;
    }

    entry = { ...entry,
      precioNeto: Math.round(neto * 100) / 100,
      precioBruto: Math.round(brutoRef * 100) / 100,
      descuento: dto,
      cantidadCompra: cantidad, unidadCompra: unidadCompra || '',
      tipoImpuesto: tipoImpuesto || 'alimento',
      precioNetoConDto: Math.round(netoConDto * 100) / 100,
      fleteNeto: flete,
      ...(ccBotella > 0 ? { capacidadCC: ccBotella } : {}),
      precio: Math.round(costoUnitario * 100) / 100
    };
  } else if (precioBruto != null) {
    // Flujo legado: usuario ingresó bruto → calculamos neto
    const divisor          = TAX_DIVISORS[tipoImpuesto] || 1.19;
    const dto              = Math.max(0, Math.min(100, Number(descuento) || 0));
    const cantidad         = Math.max(0.0001, Number(cantidadCompra) || 1);
    const brutoConDto      = Number(precioBruto) * (1 - dto / 100);
    const neto             = brutoConDto / divisor;
    costoUnitario          = neto / cantidad;

    entry = { ...entry,
      precioBruto: Number(precioBruto), descuento: dto,
      cantidadCompra: cantidad, unidadCompra: unidadCompra || '',
      tipoImpuesto: tipoImpuesto || 'alimento',
      precioBrutoConDto: Math.round(brutoConDto * 100) / 100,
      precioNeto: Math.round(neto * 100) / 100,
      precio: Math.round(costoUnitario * 100) / 100
    };
  } else if (precio != null) {
    // Flujo simple (compatibilidad hacia atrás)
    costoUnitario = Number(precio);
    entry.precio = costoUnitario;
  } else {
    return res.status(400).json({ error: 'Faltan campos' });
  }

  // Upsert: if same productId+mes exists, overwrite
  const existing = await db.collection('product_price_history')
    .where('productId', '==', req.params.id)
    .where('mes', '==', mes)
    .get();
  let entryId;
  if (!existing.empty) {
    await existing.docs[0].ref.update({ ...entry, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    entryId = existing.docs[0].id;
  } else {
    const ref = await db.collection('product_price_history').add({ ...entry, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    entryId = ref.id;
  }

  // Actualizar costPerUnit en el producto si el mes es igual o más reciente (solo si es un producto real)
  const prodSnap = await db.collection('products').doc(req.params.id).get();
  if (prodSnap.exists) {
    const currentMonth = prodSnap.data().lastPriceMonth || '';
    if (entry.mes >= currentMonth) {
      await db.collection('products').doc(req.params.id).update({
        costPerUnit:    entry.precio,
        lastPriceMonth: entry.mes
      });
    }
  }

  res.json({ id: entryId, precio: entry.precio });
});

app.delete('/api/inv/products/:id/prices/:entryId', requireAuth, async (req, res) => {
  if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
  await db.collection('product_price_history').doc(req.params.entryId).delete();
  res.json({ ok: true });
});

app.delete('/api/inv/products/:id', requireAuth, async (req, res) => {
  if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
  await db.collection('products').doc(req.params.id).delete();
  res.json({ ok: true });
});

// ── Inventario: Stock ─────────────────────────────────────
app.get('/api/inv/stock/:restaurantId', requireAuth, async (req, res) => {
  const { restaurantId } = req.params;
  const userDoc = await db.collection('users').doc(req.uid).get();
  if (!userDoc.exists) return res.status(403).json({ error: 'Sin acceso' });
  const userData = userDoc.data();
  if (userData.role !== 'admin' && userData.role !== 'superadmin' && !(userData.restaurantIds||[]).includes(restaurantId)) {
    return res.status(403).json({ error: 'Sin acceso a este local' });
  }

  const [prodSnap, prepSnap, stockSnap, supSnap] = await Promise.all([
    db.collection('products').orderBy('name').get(),
    db.collection('preparations').orderBy('name').get(),
    db.collection('stock').doc(restaurantId).collection('products').get(),
    db.collection('suppliers').get()
  ]);

  const stockMap = {};
  stockSnap.docs.forEach(d => { stockMap[d.id] = d.data(); });
  const suppliersMap = {};
  supSnap.docs.forEach(d => { suppliersMap[d.id] = d.data().name; });

  const allowedCats   = userData.categories || [];
  const sectionFilter = req.query.section   || '';

  function passesFilters(data) {
    const inRest = (data.restaurantIds || []).includes(restaurantId);
    const inCat  = allowedCats.length === 0 || allowedCats.includes(data.category);
    if (!inRest || !inCat) return false;
    if (sectionFilter) {
      const assignedSections = (data.restaurantSections || {})[restaurantId] || [];
      if (!assignedSections.includes(sectionFilter)) return false;
    }
    return true;
  }

  const prodItems = prodSnap.docs
    .filter(d => passesFilters(d.data()))
    .map(d => ({
      id: d.id, type: 'ingredient',
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

  const prepItems = prepSnap.docs
    .filter(d => passesFilters(d.data()))
    .map(d => ({
      id: d.id, type: 'preparation',
      name: d.data().name,
      category: d.data().category || '',
      unit: d.data().unit || 'unidad',
      supplierIds: [], supplierNames: [],
      quantity:    stockMap[d.id]?.quantity    ?? null,
      minQuantity: stockMap[d.id]?.minQuantity ?? null,
      lastUpdated: stockMap[d.id]?.lastUpdated ?? null,
      updatedBy:   stockMap[d.id]?.updatedBy   ?? null,
    }));

  const items = [...prodItems, ...prepItems].sort((a, b) => a.name.localeCompare(b.name, 'es'));

  res.json({ items });
});

app.put('/api/inv/stock/:restaurantId/:productId', requireAuth, async (req, res) => {
  const { restaurantId, productId } = req.params;
  const userDoc = await db.collection('users').doc(req.uid).get();
  if (!userDoc.exists) return res.status(403).json({ error: 'Sin acceso' });
  const userData = userDoc.data();
  if (userData.role !== 'admin' && userData.role !== 'superadmin' && !(userData.restaurantIds||[]).includes(restaurantId)) {
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
  if (userData.role !== 'admin' && userData.role !== 'superadmin' && !(userData.restaurantIds||[]).includes(restaurantId)) {
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
  if (userData.role !== 'admin' && userData.role !== 'superadmin' && !(userData.restaurantIds||[]).includes(restaurantId)) {
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
  if (userData.role !== 'admin' && userData.role !== 'superadmin' && !(userData.restaurantIds||[]).includes(restaurantId)) {
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

app.delete('/api/inv/inventories/:restaurantId/:recordId', requireAuth, async (req, res) => {
  try {
    if (!await isAdmin(req.uid)) return res.status(403).json({ error: 'Solo superadmin' });
    const { recordId } = req.params;
    await db.collection('inventoryRecords').doc(recordId).delete();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Añadir cantidad al stock existente
app.post('/api/inv/stock/:restaurantId/:productId/add', requireAuth, async (req, res) => {
  const { restaurantId, productId } = req.params;
  const userDoc = await db.collection('users').doc(req.uid).get();
  if (!userDoc.exists) return res.status(403).json({ error: 'Sin acceso' });
  const userData = userDoc.data();
  if (userData.role !== 'admin' && userData.role !== 'superadmin' && !(userData.restaurantIds||[]).includes(restaurantId)) {
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

// ── Clientes ─────────────────────────────────────────────
app.get('/api/inv/clients', requireAuth, async (req, res) => {
  const snap = await db.collection('clients').orderBy('name').get();
  // Never expose portalPassword hash to the frontend
  res.json({ clients: snap.docs.map(d => {
    const { portalPasswordHash, ...data } = d.data();
    return { id: d.id, ...data };
  })});
});

app.post('/api/inv/clients', requireAuth, async (req, res) => {
  if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
  const { name, rut, fantasyName, phone, address, hasPortalAccess, portalEmail, portalPassword } = req.body;
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });

  let portalUid = null;
  if (hasPortalAccess && portalEmail) {
    if (!portalPassword) return res.status(400).json({ error: 'Contraseña requerida para el portal' });
    try {
      const authUser = await admin.auth().createUser({
        email: portalEmail, password: portalPassword, displayName: name
      });
      await admin.auth().setCustomUserClaims(authUser.uid, { type: 'buyer' });
      portalUid = authUser.uid;
    } catch(e) {
      return res.status(400).json({ error: `Error al crear acceso: ${e.message}` });
    }
  }

  const ref = await db.collection('clients').add({
    name, rut: rut||'', fantasyName: fantasyName||'', phone: phone||'', address: address||'',
    hasPortalAccess: hasPortalAccess || false,
    portalEmail:     hasPortalAccess ? (portalEmail||'') : '',
    portalUid:       portalUid
  });
  res.json({ id: ref.id });
});

app.put('/api/inv/clients/:id', requireAuth, async (req, res) => {
  if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
  const { name, rut, fantasyName, phone, address, hasPortalAccess, portalEmail, portalPassword } = req.body;
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });

  const ref      = db.collection('clients').doc(req.params.id);
  const snap     = await ref.get();
  if (!snap.exists) return res.status(404).json({ error: 'No encontrado' });
  const existing = snap.data();

  let portalUid = existing.portalUid || null;

  // Enabling portal for the first time
  if (hasPortalAccess && !existing.hasPortalAccess) {
    if (!portalEmail) return res.status(400).json({ error: 'Email requerido para el portal' });
    if (!portalPassword) return res.status(400).json({ error: 'Contraseña requerida para el portal' });
    try {
      const authUser = await admin.auth().createUser({
        email: portalEmail, password: portalPassword, displayName: name
      });
      await admin.auth().setCustomUserClaims(authUser.uid, { type: 'buyer' });
      portalUid = authUser.uid;
    } catch(e) {
      return res.status(400).json({ error: `Error al crear acceso: ${e.message}` });
    }
  }

  // Disabling portal
  if (!hasPortalAccess && existing.hasPortalAccess && existing.portalUid) {
    try { await admin.auth().deleteUser(existing.portalUid); } catch {}
    portalUid = null;
  }

  // Updating password (portal already active)
  if (hasPortalAccess && existing.hasPortalAccess && portalPassword && existing.portalUid) {
    try { await admin.auth().updateUser(existing.portalUid, { password: portalPassword }); } catch {}
  }

  // Updating email (portal already active)
  if (hasPortalAccess && existing.hasPortalAccess && portalEmail && portalEmail !== existing.portalEmail && existing.portalUid) {
    try { await admin.auth().updateUser(existing.portalUid, { email: portalEmail }); } catch {}
  }

  await ref.update({
    name, rut: rut||'', fantasyName: fantasyName||'', phone: phone||'', address: address||'',
    hasPortalAccess: hasPortalAccess || false,
    portalEmail:     hasPortalAccess ? (portalEmail||'') : '',
    portalUid
  });
  res.json({ ok: true });
});

app.delete('/api/inv/clients/:id', requireAuth, async (req, res) => {
  if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
  const snap = await db.collection('clients').doc(req.params.id).get();
  if (snap.exists && snap.data().portalUid) {
    try { await admin.auth().deleteUser(snap.data().portalUid); } catch {}
  }
  await db.collection('clients').doc(req.params.id).delete();
  res.json({ ok: true });
});

// ── Catálogo de productos ─────────────────────────────────
app.get('/api/inv/catalog', requireAuth, async (req, res) => {
  const snap = await db.collection('catalog').orderBy('name').get();
  res.json({ catalog: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
});

app.post('/api/inv/catalog', requireAuth, async (req, res) => {
  if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
  const { name, category, unit, currentPrice } = req.body;
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
  const ref = await db.collection('catalog').add({
    name,
    category:          category || '',
    unit:              unit || 'unidad',
    currentPrice:      currentPrice ?? null,
    currentPriceSince: currentPrice != null ? month : null,
    priceHistory:      []
  });
  res.json({ id: ref.id });
});

app.put('/api/inv/catalog/:id', requireAuth, async (req, res) => {
  if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
  const { name, category, unit, currentPrice } = req.body;
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });

  const ref      = db.collection('catalog').doc(req.params.id);
  const snap     = await ref.get();
  if (!snap.exists) return res.status(404).json({ error: 'No encontrado' });
  const existing = snap.data();

  const month        = new Date().toISOString().slice(0, 7);
  let priceHistory   = existing.priceHistory || [];
  const priceChanged = currentPrice != null && existing.currentPrice != null
                       && currentPrice !== existing.currentPrice;

  if (priceChanged) {
    // Log old price to history (avoid duplicating same month)
    const alreadyLogged = priceHistory.some(h => h.month === existing.currentPriceSince);
    if (!alreadyLogged && existing.currentPriceSince) {
      priceHistory = [...priceHistory, {
        price:  existing.currentPrice,
        month:  existing.currentPriceSince,
        setAt:  new Date().toISOString()
      }];
    }
  }

  await ref.update({
    name,
    category:          category || '',
    unit:              unit || 'unidad',
    currentPrice:      currentPrice ?? null,
    currentPriceSince: priceChanged ? month : (existing.currentPriceSince || (currentPrice != null ? month : null)),
    priceHistory
  });
  res.json({ ok: true });
});

app.delete('/api/inv/catalog/:id', requireAuth, async (req, res) => {
  if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
  await db.collection('catalog').doc(req.params.id).delete();
  res.json({ ok: true });
});

app.post('/api/inv/price-history', requireAuth, async (req, res) => {
  console.log('[price-history] POST received from', req.email);
  try {
    if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
    const { items } = req.body;
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Sin items' });

    const now  = new Date();
    const date = now.toISOString().substring(0, 10); // "2026-03-18"
    const mes  = now.toISOString().substring(0, 7);  // "2026-03"

    await db.collection('price_history').add({
      savedAt:  admin.firestore.FieldValue.serverTimestamp(),
      savedBy:  req.email,
      date,
      mes,
      items: items
        .filter(p => p.currentPrice != null)
        .map(p => ({
          productId: p.id,
          name:      p.name,
          category:  p.category || '',
          unit:      p.unit || '',
          price:     p.currentPrice,
        })),
    });

    console.log('[price-history] Snapshot guardado:', date, '—', items.length, 'productos');
    res.json({ ok: true, saved: items.length, date });
  } catch(e) {
    console.error('[price-history] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Reuniones ───────────────────────────────────────────────
// Sections
app.get('/api/reuniones/sections', requireAuth, async (req, res) => {
  const userDoc = await db.collection('users').doc(req.uid).get();
  const role = userDoc.data()?.role;
  let snap;
  if (role === 'superadmin') {
    snap = await db.collection('reuniones_sections').get();
  } else {
    snap = await db.collection('reuniones_sections')
      .where('allowedUids', 'array-contains', req.uid).get();
  }
  const sections = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ sections });
});

app.post('/api/reuniones/sections', requireAuth, async (req, res) => {
  if (!await isAdmin(req.uid)) return res.status(403).json({ error: 'Solo superadmin' });
  const { name, color, allowedUids } = req.body;
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  const ref = await db.collection('reuniones_sections').add({
    name,
    color: color || '#ff5023',
    allowedUids: allowedUids || [],
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    createdBy: req.uid,
  });
  res.json({ id: ref.id });
});

app.put('/api/reuniones/sections/:id', requireAuth, async (req, res) => {
  if (!await isAdmin(req.uid)) return res.status(403).json({ error: 'Solo superadmin' });
  const { name, color, allowedUids } = req.body;
  const update = {};
  if (name !== undefined) update.name = name;
  if (color !== undefined) update.color = color;
  if (allowedUids !== undefined) update.allowedUids = allowedUids;
  await db.collection('reuniones_sections').doc(req.params.id).update(update);
  res.json({ ok: true });
});

app.delete('/api/reuniones/sections/:id', requireAuth, async (req, res) => {
  if (!await isAdmin(req.uid)) return res.status(403).json({ error: 'Solo superadmin' });
  // Delete all pages in section
  const pages = await db.collection('reuniones_pages').where('sectionId', '==', req.params.id).get();
  const batch = db.batch();
  pages.docs.forEach(d => batch.delete(d.ref));
  batch.delete(db.collection('reuniones_sections').doc(req.params.id));
  await batch.commit();
  res.json({ ok: true });
});

// Pages
app.get('/api/reuniones/sections/:sectionId/pages', requireAuth, async (req, res) => {
  const snap = await db.collection('reuniones_pages')
    .where('sectionId', '==', req.params.sectionId)
    .get();
  const pages = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => {
      const ta = a.createdAt?._seconds ?? 0;
      const tb = b.createdAt?._seconds ?? 0;
      return ta - tb;
    });
  res.json({ pages });
});

app.post('/api/reuniones/sections/:sectionId/pages', requireAuth, async (req, res) => {
  const { name } = req.body;
  const ref = await db.collection('reuniones_pages').add({
    sectionId: req.params.sectionId,
    name: name || 'Nueva página',
    content: '',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  res.json({ id: ref.id });
});

app.put('/api/reuniones/pages/:id', requireAuth, async (req, res) => {
  const { name, content } = req.body;
  const update = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
  if (name !== undefined) update.name = name;
  if (content !== undefined) update.content = content;
  await db.collection('reuniones_pages').doc(req.params.id).update(update);
  res.json({ ok: true });
});

app.delete('/api/reuniones/pages/:id', requireAuth, async (req, res) => {
  await db.collection('reuniones_pages').doc(req.params.id).delete();
  res.json({ ok: true });
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
  if (userData.role !== 'admin' && userData.role !== 'superadmin' && !(userData.restaurantIds||[]).includes(restaurantId)) {
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
  if (userData.role !== 'admin' && userData.role !== 'superadmin' && !(userData.restaurantIds||[]).includes(restaurantId)) {
    return res.status(403).json({ error: 'Sin acceso a este local' });
  }
  const n0 = v => v != null && v !== '' ? Number(v) : 0;
  const ref = await db.collection('ingresos').add({
    restaurantId, fecha, local: local||'',
    totalPrograma:    totalPrograma    != null && totalPrograma    !== '' ? Number(totalPrograma)    : null,
    propinasPrograma: n0(propinasPrograma),
    transbank:        n0(transbank),
    transbankPropinas:n0(transbankPropinas),
    efectivo:         n0(efectivo),
    propinaAMano:     n0(propinaAMano),
    gastos:           n0(gastos),
    garzones:         n0(garzones),
    propnasPagadas:   n0(propnasPagadas),
    comentarios:      comentarios      || null,
    envioDelivery:    n0(envioDelivery),
    propinasDelivery: n0(propinasDelivery),
    montoDelivery:    n0(montoDelivery),
    cantidadDelivery: n0(cantidadDelivery),
    cantidadRetiro:   n0(cantidadRetiro),
    montoRetiro:      n0(montoRetiro),
    bookingTotal:     n0(bookingTotal),
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
  const n  = v => v != null && v !== '' ? Number(v) : null; // solo para totalPrograma
  const n0 = v => v != null && v !== '' ? Number(v) : 0;
  await db.collection('ingresos').doc(req.params.id).update({
    fecha, local: local||'', restaurantId,
    totalPrograma: n(totalPrograma),
    propinasPrograma: n0(propinasPrograma), transbankPropinas: n0(transbankPropinas),
    transbank: n0(transbank), efectivo: n0(efectivo), propinaAMano: n0(propinaAMano),
    gastos: n0(gastos), garzones: n0(garzones), propnasPagadas: n0(propnasPagadas),
    comentarios: comentarios||null,
    envioDelivery: n0(envioDelivery), propinasDelivery: n0(propinasDelivery),
    montoDelivery: n0(montoDelivery), cantidadDelivery: n0(cantidadDelivery),
    cantidadRetiro: n0(cantidadRetiro), montoRetiro: n0(montoRetiro),
    bookingTotal: n0(bookingTotal),
  });
  if (restaurantId) delete cierresCache[restaurantId];
  res.json({ ok: true });
});

app.delete('/api/cierres/:id', requireAuth, async (req, res) => {
  if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
  const doc = await db.collection('ingresos').doc(req.params.id).get();
  const restId = doc.exists ? doc.data().restaurantId : null;
  await db.collection('ingresos').doc(req.params.id).delete();
  if (restId) delete cierresCache[restId]; // invalidar caché
  res.json({ ok: true });
});

// ── Importar cierres desde Excel ──────────────────────────
app.post('/api/cierres/import-excel', requireAuth, upload.single('file'), async (req, res) => {
  if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });

  try {
    // Cargar restaurantes para mapear nombre → id
    const restSnap = await db.collection('restaurants').get();
    const nameToId = {};
    restSnap.docs.forEach(d => {
      const name = (d.data().name || '').trim();
      nameToId[name.toLowerCase()] = { id: d.id, name };
    });

    const wb = XLSX.readFile(req.file.path);
    const ws = wb.Sheets['Respuestas Actualizada'];
    if (!ws) return res.status(400).json({ error: 'No se encontró hoja "Respuestas Actualizada"' });

    const rows = XLSX.utils.sheet_to_json(ws, { defval: null });

    const n0 = v => (v != null && v !== '') ? Number(v) : 0;
    const excelDate = v => {
      if (!v) return null;
      if (typeof v === 'string' && v.match(/^\d{4}-\d{2}-\d{2}/)) return v.slice(0, 10);
      if (typeof v === 'number') {
        const d = new Date(Math.round((v - 25569) * 86400 * 1000));
        return d.toISOString().slice(0, 10);
      }
      return null;
    };

    let inserted = 0, updated = 0, skipped = 0;
    const batchSize = 400;
    let batchOps = [];

    const flush = async () => {
      await Promise.all(batchOps.map(op => op()));
      batchOps = [];
    };

    for (const row of rows) {
      const fecha = excelDate(row['Fecha']);
      const localName = (row['Local'] || '').trim();
      if (!fecha || !localName) { skipped++; continue; }

      const restMatch = nameToId[localName.toLowerCase()];
      if (!restMatch) { skipped++; continue; }

      const { id: restaurantId, name: local } = restMatch;

      const data = {
        restaurantId, fecha, local,
        totalPrograma:    n0(row['Total Programa']),
        propinasPrograma: n0(row['Propina Programa']),
        transbank:        n0(row['Total POS']),
        transbankPropinas:n0(row['Propina POS']),
        efectivo:         n0(row['Total Efectivo']),
        propinaAMano:     n0(row['Propina Efectivo']),
        gastos:           n0(row['Gasto']),
        cantidadDelivery: n0(row['Cantidad Delivery']),
        montoDelivery:    n0(row['Venta Delivery']),
        envioDelivery:    n0(row['Envio Delivery']),
        propinasDelivery: n0(row['Propina Delivery']),
        montoRetiro:      n0(row['Venta Retiro']),
        cantidadRetiro:   n0(row['Cantidad Retiro']),
        comentarios:      row['Comentarios'] || null,
        bookingTotal:     n0(row['Total Cabaña']),
        importedAt:       new Date().toISOString(),
      };

      // Buscar si ya existe un cierre para esta fecha+restaurante
      batchOps.push(async () => {
        const existing = await db.collection('ingresos')
          .where('restaurantId', '==', restaurantId)
          .where('fecha', '==', fecha)
          .limit(1).get();
        if (!existing.empty) {
          await existing.docs[0].ref.update(data);
          updated++;
        } else {
          await db.collection('ingresos').add({ ...data, createdAt: new Date().toISOString() });
          inserted++;
        }
        delete cierresCache[restaurantId];
      });

      if (batchOps.length >= batchSize) await flush();
    }
    await flush();
    fs.unlinkSync(req.file.path);
    res.json({ ok: true, inserted, updated, skipped });
  } catch (e) {
    console.error('import-excel error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Umbrales por categoría ────────────────────────────────
app.get('/api/settings/thresholds', requireAuth, async (req, res) => {
  const doc = await db.collection('settings').doc('categoryThresholds').get();
  res.json({ thresholds: doc.exists ? doc.data() : {} });
});

app.put('/api/settings/thresholds', requireAuth, async (req, res) => {
  if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
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
    if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
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
    if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
    const { title, restaurantId } = req.body;
    if (!title) return res.status(400).json({ error: 'Título requerido' });
    await db.collection('manuals').doc(req.params.id).update({ title, restaurantId: restaurantId || null });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/manuals/:id', requireAuth, async (req, res) => {
  try {
    if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
    const doc = await db.collection('manuals').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'No encontrado' });
    const { fileName } = doc.data();
    try { await bucket.file(fileName).delete(); } catch {}
    await db.collection('manuals').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Configuración general ─────────────────────────────────
app.get('/api/settings/general', requireAuth, async (req, res) => {
  const doc = await db.collection('settings').doc('general').get();
  res.json(doc.exists ? doc.data() : { whatsappNumber: '56994409188' });
});

app.put('/api/settings/general', requireAuth, async (req, res) => {
  if (req.role !== 'superadmin') {
    // need to check role from firestore
    const u = await db.collection('users').doc(req.uid).get();
    if (!u.exists || u.data().role !== 'superadmin') return res.status(403).json({ error: 'Sin permisos' });
  }
  const { whatsappNumber } = req.body;
  await db.collection('settings').doc('general').set({ whatsappNumber }, { merge: true });
  res.json({ ok: true });
});

// ── Portal: catálogo público para compradores ─────────────
app.get('/api/portal/catalog', requireBuyer, async (req, res) => {
  const snap = await db.collection('catalog').orderBy('name').get();
  res.json({ catalog: snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(p => p.currentPrice != null) });
});

// ── Portal: pedidos del comprador ─────────────────────────
app.post('/api/portal/orders', requireBuyer, async (req, res) => {
  const { items, notes } = req.body;
  if (!items?.length) return res.status(400).json({ error: 'El pedido está vacío' });

  // Get client info
  const clientSnap = await db.collection('clients').where('portalUid', '==', req.uid).limit(1).get();
  const client = clientSnap.empty ? null : { id: clientSnap.docs[0].id, ...clientSnap.docs[0].data() };

  const total = items.reduce((s, i) => s + (i.price * i.quantity), 0);

  const ref = await db.collection('orders').add({
    buyerUid:    req.uid,
    buyerEmail:  req.email,
    clientId:    client?.id || null,
    clientName:  client?.name || req.email,
    items,
    notes:       notes || '',
    total,
    status:      'pendiente',
    createdAt:   new Date().toISOString()
  });

  // Get WA number from settings
  const settingsDoc = await db.collection('settings').doc('general').get();
  const waNumber = settingsDoc.exists ? (settingsDoc.data().whatsappNumber || '56994409188') : '56994409188';

  res.json({ id: ref.id, waNumber });
});

app.get('/api/portal/orders', requireBuyer, async (req, res) => {
  const snap = await db.collection('orders')
    .where('buyerUid', '==', req.uid)
    .get();
  const orders = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  res.json({ orders });
});

// ── Admin: ver todos los pedidos ──────────────────────────
app.get('/api/orders', requireAuth, async (req, res) => {
  const snap = await db.collection('orders').orderBy('createdAt', 'desc').get();
  res.json({ orders: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
});

app.put('/api/orders/:id/status', requireAuth, async (req, res) => {
  if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
  const { status } = req.body;
  await db.collection('orders').doc(req.params.id).update({ status });
  res.json({ ok: true });
});

// Actualizar items del pedido (sinStock por índice)
app.patch('/api/orders/:id/items', requireAuth, async (req, res) => {
  if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
  const { idx, sinStock } = req.body;
  const doc  = db.collection('orders').doc(req.params.id);
  const snap = await doc.get();
  if (!snap.exists) return res.status(404).json({ error: 'No encontrado' });
  const items = snap.data().items || [];
  if (idx < 0 || idx >= items.length) return res.status(400).json({ error: 'Índice inválido' });
  items[idx] = { ...items[idx], sinStock: !!sinStock };
  // Recalcular total solo con items con stock
  const total = items.filter(i => !i.sinStock).reduce((s, i) => s + (i.price * i.quantity), 0);
  await doc.update({ items, total });
  res.json({ ok: true, items, total });
});

// Subir comprobante de pago (múltiples permitidos)
app.post('/api/orders/:id/comprobantes', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });
  try {
    const buf  = fs.readFileSync(req.file.path);
    const ext  = req.file.originalname.split('.').pop() || 'jpg';
    const mime = req.file.mimetype;
    const dest = `orders/${req.params.id}/comprobantes/${Date.now()}_${randomUUID()}.${ext}`;
    const ref  = bucket.file(dest);
    await ref.save(buf, { contentType: mime, resumable: false });
    await ref.makePublic();
    const url = `https://storage.googleapis.com/${bucket.name}/${dest}`;
    const doc = db.collection('orders').doc(req.params.id);
    const snap = await doc.get();
    const comprobantes = snap.data()?.comprobantes || [];
    comprobantes.push(url);
    await doc.update({ comprobantes });
    try { fs.unlinkSync(req.file.path); } catch {}
    res.json({ ok: true, url, comprobantes });
  } catch(e) {
    try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: e.message });
  }
});

// Eliminar comprobante por índice
app.delete('/api/orders/:id/comprobantes/:idx', requireAuth, async (req, res) => {
  const doc  = db.collection('orders').doc(req.params.id);
  const snap = await doc.get();
  const arr  = snap.data()?.comprobantes || [];
  arr.splice(Number(req.params.idx), 1);
  await doc.update({ comprobantes: arr });
  res.json({ ok: true, comprobantes: arr });
});

// Subir factura (una sola)
app.post('/api/orders/:id/factura', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });
  try {
    const buf  = fs.readFileSync(req.file.path);
    const ext  = req.file.originalname.split('.').pop() || 'pdf';
    const mime = req.file.mimetype;
    const dest = `orders/${req.params.id}/factura/${Date.now()}.${ext}`;
    const ref  = bucket.file(dest);
    await ref.save(buf, { contentType: mime, resumable: false });
    await ref.makePublic();
    const url = `https://storage.googleapis.com/${bucket.name}/${dest}`;
    await db.collection('orders').doc(req.params.id).update({ facturaUrl: url });
    try { fs.unlinkSync(req.file.path); } catch {}
    res.json({ ok: true, url });
  } catch(e) {
    try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: e.message });
  }
});

// Eliminar factura
app.delete('/api/orders/:id/factura', requireAuth, async (req, res) => {
  await db.collection('orders').doc(req.params.id).update({ facturaUrl: null });
  res.json({ ok: true });
});

// ── GDD: Guías de Despacho ────────────────────────────────
app.post('/api/gdd/scan', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY no configurada' });

  try {
    const buf      = fs.readFileSync(req.file.path);
    const b64      = buf.toString('base64');
    const mime     = req.file.mimetype;
    const isPdf    = mime === 'application/pdf';

    const contentBlock = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
      : { type: 'image',    source: { type: 'base64', media_type: mime,               data: b64 } };

    // Cargar lista de productos, preparaciones y recetas marcados como GDD para que Claude haga matching
    const [prodSnap, prepSnap, recipeSnap] = await Promise.all([
      db.collection('products').get(),
      db.collection('preparations').get(),
      db.collection('recipes').get()
    ]);
    const productNames = [
      ...prodSnap.docs.map(d => d.data()).filter(p => p.esGDD === true && p.name).map(p => p.name),
      ...prepSnap.docs.map(d => d.data()).filter(p => p.esGDD === true && p.name).map(p => p.name),
      ...recipeSnap.docs.map(d => d.data()).filter(p => p.esGDD === true && p.name).map(p => p.name)
    ].sort();
    const productList  = productNames.join('\n');

    const prompt = `Eres un asistente que extrae datos de guías de despacho chilenas.
Analiza la imagen/documento y extrae la siguiente información en JSON puro (sin markdown):
{
  "proveedor": "nombre del proveedor del encabezado",
  "fecha": "fecha en formato YYYY-MM-DD si se puede leer, sino null",
  "items": [
    { "categoria": "CATEGORÍA", "producto": "nombre EXACTO del producto según la lista", "unidad": "unidad", "cantidad": número o null si está vacío, "comentarios": "texto si hay" }
  ]
}

LISTA DE PRODUCTOS (usa EXACTAMENTE estos nombres, incluyendo la unidad entre paréntesis si la tiene):
${productList}

IMPORTANTE:
- Para cada producto de la guía, primero busca una coincidencia EXACTA en la LISTA DE PRODUCTOS (ignorando mayúsculas/minúsculas). Si existe un match exacto, úsalo siempre.
- ATENCIÓN: muchos nombres en la lista tienen ingredientes entre paréntesis, ej: "Torta Cuatro Leches (Leche, Leche Condensada, Leche Evaporada, Manjar)". En la guía puede aparecer solo la parte principal: "Torta Cuatro Leches" o incluso "Cuatro Leches". Compara IGNORANDO el contenido entre paréntesis y elige el producto de la lista cuya parte principal (antes del paréntesis) coincida mejor con el texto de la guía.
- Solo si no hay match exacto ni por nombre base, busca el nombre más parecido. Cuando hay productos similares (ej: "Rallado" vs "Barra"), elige el que coincida en TODOS los descriptores del texto original.
- Si no encuentras ningún match claro, usa el nombre tal como aparece en la guía.
- SIEMPRE usa el nombre COMPLETO de la lista (incluyendo los paréntesis si los tiene) como valor de "producto" en el JSON.
- Incluye TODOS los productos de la tabla, tengan o no cantidad.
- Si la cantidad está vacía/no marcada, ponla como null.
- Sé preciso con las cantidades manuscritas (números escritos a mano).
- Si una categoría agrupa varias filas, repite la categoría en cada item.
Devuelve SOLO el JSON, nada más.`;

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json'
      },
      body: JSON.stringify({
        model:      'claude-opus-4-6',
        max_tokens: 2048,
        messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: prompt }] }]
      })
    });

    const anthropicData = await anthropicRes.json();
    if (!anthropicRes.ok) throw new Error(anthropicData.error?.message || 'Error Claude API');

    const raw  = anthropicData.content?.[0]?.text || '';
    const json = raw.replace(/```json|```/g, '').trim();
    const data = JSON.parse(json);
    // Limpieza: quitar unidad entre paréntesis del nombre si quedó igual
    // Subir imagen a Firebase Storage
    let imageUrl = null;
    try {
      const ext        = req.file.originalname.split('.').pop() || 'jpg';
      const destName   = `gdd/${Date.now()}_${randomUUID()}.${ext}`;
      const fileRef    = bucket.file(destName);
      await fileRef.save(buf, { contentType: mime, resumable: false });
      await fileRef.makePublic();
      imageUrl = `https://storage.googleapis.com/${bucket.name}/${destName}`;
    } catch(storageErr) {
      console.error('Storage upload error (no fatal):', storageErr.message);
    }

    fs.unlinkSync(req.file.path);
    res.json({ ok: true, data, imageUrl });
  } catch(e) {
    try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/gdd/records', requireAuth, async (req, res) => {
  const { proveedor, fecha, items, restaurantId, imageUrl } = req.body;
  if (!items?.length) return res.status(400).json({ error: 'Items requeridos' });
  const userDoc  = await db.collection('users').doc(req.uid).get();
  const userData = userDoc.data();
  const ref = await db.collection('gdd_records').add({
    proveedor:    proveedor || '',
    fecha:        fecha || '',
    items,
    restaurantId: restaurantId || '',
    imageUrl:     imageUrl || null,
    createdAt:    new Date().toISOString(),
    createdBy:    req.email,
    createdByName: userData?.name || req.email
  });
  res.json({ ok: true, id: ref.id });
});

app.patch('/api/gdd/records/:id/items', requireAuth, async (req, res) => {
  const { idx, cantidad } = req.body;
  if (idx === undefined) return res.status(400).json({ error: 'idx requerido' });
  const docRef = db.collection('gdd_records').doc(req.params.id);
  const doc = await docRef.get();
  if (!doc.exists) return res.status(404).json({ error: 'No encontrado' });
  const items = doc.data().items || [];
  if (idx < 0 || idx >= items.length) return res.status(400).json({ error: 'Índice inválido' });
  items[idx] = { ...items[idx], cantidad: cantidad === null ? null : Number(cantidad) };
  await docRef.update({ items });
  res.json({ ok: true });
});

app.delete('/api/gdd/records/:id', requireAuth, async (req, res) => {
  await db.collection('gdd_records').doc(req.params.id).delete();
  res.json({ ok: true });
});

app.get('/api/gdd/records', requireAuth, async (req, res) => {
  const snap = await db.collection('gdd_records').orderBy('createdAt', 'desc').limit(50).get();
  res.json({ records: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
});

app.get('/api/gdd/export-data', requireAuth, async (req, res) => {
  const [gddSnap, prodSnap, prepSnap, recipeSnap, priceSnap, restSnap] = await Promise.all([
    db.collection('gdd_records').orderBy('createdAt', 'desc').get(),
    db.collection('products').get(),
    db.collection('preparations').get(),
    db.collection('recipes').get(),
    db.collection('product_price_history').get(),
    db.collection('restaurants').get()
  ]);
  res.json({
    records:      gddSnap.docs.map(d  => ({ id: d.id,  ...d.data()  })),
    products:     prodSnap.docs.map(d => ({ id: d.id,  ...d.data()  })),
    preparations: prepSnap.docs.map(d => ({ id: d.id,  ...d.data()  })),
    recipes:      recipeSnap.docs.map(d=> ({ id: d.id,  ...d.data()  })),
    priceHistory: priceSnap.docs.map(d=> ({ id: d.id,  ...d.data()  })),
    restaurants:  restSnap.docs.map(d => ({ id: d.id,  ...d.data()  }))
  });
});

app.patch('/api/gdd/records/:id', requireAuth, async (req, res) => {
  const allowed = ['fecha', 'proveedor'];
  const update = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
  if (!Object.keys(update).length) return res.status(400).json({ error: 'Sin campos' });
  await db.collection('gdd_records').doc(req.params.id).update(update);
  res.json({ ok: true });
});

// ── Márgenes: Recetas ─────────────────────────────────────
app.get('/api/recipes', requireAuth, async (req, res) => {
  const snap = await db.collection('recipes').orderBy('name').get();
  res.json({ recipes: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
});

app.post('/api/recipes/import', requireAuth, async (req, res) => {
  if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
  const { recipes } = req.body;
  if (!Array.isArray(recipes) || !recipes.length) return res.status(400).json({ error: 'Sin recetas' });

  // For each recipe, upsert by (name + restaurantId)
  const existing = await db.collection('recipes').get();
  const existMap = {};
  existing.docs.forEach(d => {
    const key = `${d.data().name}__${d.data().restaurantId}`;
    existMap[key] = d.id;
  });

  const batch = db.batch();
  let count = 0;
  for (const r of recipes) {
    if (!r.name) continue;
    const key = `${r.name}__${r.restaurantId}`;
    const docId = existMap[key];
    const data = {
      name: r.name,
      restaurantId: r.restaurantId || null,
      restaurantName: r.restaurantName || '',
      restaurantIds: r.restaurantIds || (r.restaurantId ? [r.restaurantId] : []),
      sellingPrice: r.sellingPrice || 0,
      sellingPrices: r.sellingPrices || (r.restaurantId && r.sellingPrice ? { [r.restaurantId]: r.sellingPrice } : {}),
      ingredients: r.ingredients || [],
      esGDD: r.esGDD === true,
      rendimientoAgua: Number(r.rendimientoAgua) || 0,
      rendimientoAire: Number(r.rendimientoAire) || 0,
      merma: Number(r.merma) || 0,
      porciones: Math.max(1, parseInt(r.porciones) || 1),
      category: r.category || r.categoria || '',
      subcategoria: r.subcategoria || '',
      comentario: r.comentario || '',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    if (docId) {
      batch.update(db.collection('recipes').doc(docId), data);
    } else {
      const ref = db.collection('recipes').doc();
      data.createdAt = admin.firestore.FieldValue.serverTimestamp();
      batch.set(ref, data);
    }
    count++;
  }
  await batch.commit();
  res.json({ ok: true, count });
});

app.put('/api/recipes/:id', requireAuth, async (req, res) => {
  if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
  const update = {};
  const { sellingPrice, sellingPrices, restaurantIds, restaurantId, restaurantName, ingredients, name, esPromedio, esGDD, rendimientoAgua, rendimientoAire, merma, porciones, category, categoria, subcategoria, comentario } = req.body;
  if (sellingPrice     !== undefined) update.sellingPrice     = Number(sellingPrice) || 0;
  if (sellingPrices    !== undefined) update.sellingPrices    = sellingPrices;
  if (restaurantIds    !== undefined) update.restaurantIds    = restaurantIds;
  if (restaurantId     !== undefined) update.restaurantId     = restaurantId;
  if (restaurantName   !== undefined) update.restaurantName   = restaurantName;
  if (ingredients      !== undefined) update.ingredients      = ingredients;
  if (name             !== undefined) update.name             = name;
  if (esPromedio       !== undefined) update.esPromedio       = esPromedio === true;
  if (esGDD            !== undefined) update.esGDD            = esGDD === true;
  if (rendimientoAgua  !== undefined) update.rendimientoAgua  = Number(rendimientoAgua)  || 0;
  if (rendimientoAire  !== undefined) update.rendimientoAire  = Number(rendimientoAire)  || 0;
  if (merma            !== undefined) update.merma            = Number(merma)            || 0;
  if (porciones        !== undefined) update.porciones        = Math.max(1, parseInt(porciones) || 1);
  const catVal = category !== undefined ? category : categoria;
  if (catVal           !== undefined) { update.category = catVal || ''; update.categoria = admin.firestore.FieldValue.delete(); }
  if (subcategoria     !== undefined) update.subcategoria     = subcategoria || '';
  if (comentario       !== undefined) update.comentario       = comentario   || '';
  update.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  await db.collection('recipes').doc(req.params.id).update(update);
  res.json({ ok: true });
});

app.delete('/api/recipes/:id', requireAuth, async (req, res) => {
  if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
  await db.collection('recipes').doc(req.params.id).delete();
  res.json({ ok: true });
});

// ── Márgenes: Preparaciones ───────────────────────────────
app.get('/api/preparations', requireAuth, async (req, res) => {
  const snap = await db.collection('preparations').orderBy('name').get();
  res.json({ preparations: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
});

app.post('/api/preparations', requireAuth, async (req, res) => {
  if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
  const { name, ingredients, esGDD, esPromedio, category, unit, restaurantIds, restaurantSections, rendimientoAgua, rendimientoAire, porciones, comentario } = req.body;
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  const ref = await db.collection('preparations').add({
    name, ingredients: ingredients || [],
    esGDD: esGDD === true,
    esPromedio: esPromedio === true,
    category: category || '',
    unit: unit || 'unidad',
    restaurantIds: restaurantIds || [],
    restaurantSections: restaurantSections || {},
    rendimientoAgua: Number(rendimientoAgua) || 0,
    rendimientoAire: Number(rendimientoAire) || 0,
    porciones: Math.max(1, parseInt(porciones) || 1),
    comentario: comentario || '',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  res.json({ id: ref.id });
});

app.put('/api/preparations/:id', requireAuth, async (req, res) => {
  if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
  const { name, ingredients, esGDD, esPromedio, category, unit, restaurantIds, restaurantSections, rendimientoAgua, rendimientoAire, merma, porciones, comentario } = req.body;
  const update = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
  if (name               !== undefined) update.name               = name;
  if (ingredients        !== undefined) update.ingredients        = ingredients;
  if (esGDD              !== undefined) update.esGDD              = esGDD === true;
  if (esPromedio         !== undefined) update.esPromedio         = esPromedio === true;
  if (category           !== undefined) update.category           = category;
  if (unit               !== undefined) update.unit               = unit;
  if (restaurantIds      !== undefined) update.restaurantIds      = restaurantIds;
  if (restaurantSections !== undefined) update.restaurantSections = restaurantSections;
  if (rendimientoAgua    !== undefined) update.rendimientoAgua    = Number(rendimientoAgua)  || 0;
  if (rendimientoAire    !== undefined) update.rendimientoAire    = Number(rendimientoAire)  || 0;
  if (merma              !== undefined) update.merma              = Number(merma)            || 0;
  if (porciones          !== undefined) update.porciones          = Math.max(1, parseInt(porciones) || 1);
  if (comentario         !== undefined) update.comentario         = comentario || '';
  await db.collection('preparations').doc(req.params.id).update(update);
  res.json({ ok: true });
});

app.post('/api/preparations/:id/cost-snapshot', requireAuth, async (req, res) => {
  if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
  const { mes, costo } = req.body; // mes = 'YYYY-MM', costo = number
  if (!mes || costo === undefined) return res.status(400).json({ error: 'Faltan datos' });
  const ref = db.collection('preparations').doc(req.params.id);
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ error: 'No encontrado' });
  const history = doc.data().costHistory || [];
  const idx = history.findIndex(h => h.mes === mes);
  if (idx >= 0) {
    history[idx] = { mes, costo: Number(costo) };
  } else {
    history.push({ mes, costo: Number(costo) });
    history.sort((a, b) => b.mes.localeCompare(a.mes));
  }
  await ref.update({ costHistory: history, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  res.json({ ok: true, history });
});

// Helper: chequea uso de cualquier ID (ingrediente o preparación)
async function checkUsage(id, { isPrep = false } = {}) {
  const usage = [];

  const [recipesSnap, prepsSnap, restsSnap, invSnap] = await Promise.all([
    db.collection('recipes').get(),
    db.collection('preparations').get(),
    db.collection('restaurants').get(),
    db.collection('inventoryRecords').orderBy('createdAt', 'desc').limit(500).get()
  ]);

  // Recetas que lo usan
  const ingField = isPrep ? 'preparationId' : 'productId';
  const usedRecipes = recipesSnap.docs.filter(d =>
    (d.data().ingredients || []).some(i => i[ingField] === id));
  if (usedRecipes.length)
    usage.push({ tipo: 'Recetas', items: usedRecipes.map(d => d.data().name) });

  // Preparaciones que lo usan
  const usedPreps = prepsSnap.docs.filter(d =>
    d.id !== id && (d.data().ingredients || []).some(i => i[ingField] === id));
  if (usedPreps.length)
    usage.push({ tipo: 'Preparaciones', items: usedPreps.map(d => d.data().name) });

  // Stock actual en cada local (por ID — aplica a productos y preparaciones)
  const stockChecks = await Promise.all(
    restsSnap.docs.map(r => db.collection('stock').doc(r.id).collection('products').doc(id).get())
  );
  const restsWithStock = restsSnap.docs.filter((r, i) => {
    const s = stockChecks[i];
    return s.exists && (s.data().quantity || 0) > 0;
  });
  if (restsWithStock.length)
    usage.push({ tipo: 'Stock en locales', items: restsWithStock.map(d => d.data().name) });

  // Registros de inventario históricos (productId = id, aplica a ingredientes y preparaciones)
  const usedInv = invSnap.docs.filter(d =>
    (d.data().items || []).some(i => i.productId === id));
  if (usedInv.length)
    usage.push({ tipo: 'Registros de inventario', items: [`${usedInv.length} registro(s) histórico(s)`] });

  return usage;
}

// Verificar uso de un ingrediente antes de eliminar
app.get('/api/inv/products/:id/usage', requireAuth, async (req, res) => {
  const usage = await checkUsage(req.params.id, { isPrep: false });
  res.json({ usage, seguro: usage.length === 0 });
});

// Verificar uso de una preparación antes de eliminar
app.get('/api/preparations/:id/usage', requireAuth, async (req, res) => {
  const usage = await checkUsage(req.params.id, { isPrep: true });
  res.json({ usage, seguro: usage.length === 0 });
});

// Convertir ingrediente → preparación
app.post('/api/inv/products/:id/convert-to-prep', requireAuth, async (req, res) => {
  if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
  const prodSnap = await db.collection('products').doc(req.params.id).get();
  if (!prodSnap.exists) return res.status(404).json({ error: 'Ingrediente no encontrado' });
  const prod = prodSnap.data();
  const ref = await db.collection('preparations').add({
    name: prod.name,
    ingredients: [],
    esGDD: prod.esGDD === true,
    category: prod.category || '',
    unit: prod.unit || 'unidad',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  await db.collection('products').doc(req.params.id).delete();
  res.json({ ok: true, prepId: ref.id });
});

app.delete('/api/preparations/:id', requireAuth, async (req, res) => {
  if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
  await db.collection('preparations').doc(req.params.id).delete();
  res.json({ ok: true });
});

// ── Márgenes: Promos ─────────────────────────────────────────────────────────
app.get('/api/promos', requireAuth, async (req, res) => {
  const snap = await db.collection('promos').orderBy('name').get();
  res.json({ promos: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
});

app.post('/api/promos', requireAuth, async (req, res) => {
  if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
  const { name, restaurantId, restaurantName, sellingPrice, recipes, comentario } = req.body;
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  const ref = await db.collection('promos').add({
    name, restaurantId: restaurantId || null, restaurantName: restaurantName || '',
    sellingPrice: Number(sellingPrice) || 0,
    recipes: recipes || [],
    comentario: comentario || '',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  res.json({ id: ref.id });
});

app.put('/api/promos/:id', requireAuth, async (req, res) => {
  if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
  const { name, restaurantId, restaurantName, sellingPrice, recipes, comentario } = req.body;
  const update = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
  if (name             !== undefined) update.name             = name;
  if (restaurantId     !== undefined) update.restaurantId     = restaurantId;
  if (restaurantName   !== undefined) update.restaurantName   = restaurantName;
  if (sellingPrice     !== undefined) update.sellingPrice     = Number(sellingPrice) || 0;
  if (recipes          !== undefined) update.recipes          = recipes;
  if (comentario       !== undefined) update.comentario       = comentario;
  await db.collection('promos').doc(req.params.id).update(update);
  res.json({ ok: true });
});

app.delete('/api/promos/:id', requireAuth, async (req, res) => {
  if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
  await db.collection('promos').doc(req.params.id).delete();
  res.json({ ok: true });
});

// ── Config: unidades personalizadas ──────────────────────────────────────────
const UNITS_DOC = () => db.collection('config').doc('units');

app.get('/api/config/units', requireAuth, async (req, res) => {
  const snap = await UNITS_DOC().get();
  res.json({ units: snap.exists ? (snap.data().list || []) : [] });
});

app.post('/api/config/units', requireAuth, async (req, res) => {
  if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
  const { value, label } = req.body;
  if (!value || !label) return res.status(400).json({ error: 'Faltan campos' });
  const snap = await UNITS_DOC().get();
  const list = snap.exists ? (snap.data().list || []) : [];
  if (list.find(u => u.value === value)) return res.status(400).json({ error: 'Ya existe' });
  list.push({ value, label });
  await UNITS_DOC().set({ list });
  res.json({ ok: true, units: list });
});

app.delete('/api/config/units/:value', requireAuth, async (req, res) => {
  if (!await isEditor(req.uid)) return res.status(403).json({ error: 'Sin permisos' });
  const snap = await UNITS_DOC().get();
  const list = snap.exists ? (snap.data().list || []) : [];
  const updated = list.filter(u => u.value !== req.params.value);
  await UNITS_DOC().set({ list: updated });
  res.json({ ok: true, units: updated });
});

// ── Agente IA ─────────────────────────────────────────────────────────────────
function agentCalcPrepCost(prep, preparations, ingredients) {
  if (!prep) return 0;
  const items = (prep.ingredients || []).filter(i => i.quantity > 0);
  let cost = 0;
  items.forEach(item => {
    if (item.type === 'preparation') {
      const sub = preparations.find(p => p.id === item.preparationId || p.name === item.name);
      cost += agentCalcPrepCost(sub, preparations, ingredients) * (item.quantity || 0);
    } else {
      const prod = ingredients.find(p => p.id === item.productId || p.name === item.name);
      cost += (prod?.costPerUnit || 0) * (item.quantity || 0);
    }
  });
  if (prep.esPromedio && items.length > 1) cost = cost / items.length;
  const agua = prep.rendimientoAgua || 0;
  const aire = prep.rendimientoAire || 0;
  if (agua > 0) cost = cost / (1 + agua / 100);
  if (aire > 0) cost = cost / (1 + aire / 100);
  const porciones = prep.porciones > 1 ? prep.porciones : 1;
  return porciones > 1 ? cost / porciones : cost;
}

function agentCalcRecipeCost(recipe, preparations, ingredients) {
  const items = (recipe.ingredients || []).filter(i => i.quantity > 0);
  let cost = 0;
  items.forEach(item => {
    if (item.type === 'preparation') {
      const prep = preparations.find(p => p.id === item.preparationId || p.name === item.name);
      cost += agentCalcPrepCost(prep, preparations, ingredients) * (item.quantity || 0);
    } else {
      const prod = ingredients.find(p => p.id === item.productId || p.name === item.name);
      cost += (prod?.costPerUnit || 0) * (item.quantity || 0);
    }
  });
  if (recipe.esPromedio && items.length > 1) cost = cost / items.length;
  const agua = recipe.rendimientoAgua || 0;
  const aire = recipe.rendimientoAire || 0;
  if (agua > 0) cost = cost / (1 + agua / 100);
  if (aire > 0) cost = cost / (1 + aire / 100);
  const porciones = recipe.porciones > 1 ? recipe.porciones : 1;
  return porciones > 1 ? cost / porciones : cost;
}

const AGENT_TOOLS = [
  {
    name: 'get_restaurants',
    description: 'Devuelve la lista de restaurantes/locales disponibles.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_recipes',
    description: 'Devuelve recetas con costo y margen calculado. Filtra opcionalmente por nombre de restaurante.',
    input_schema: {
      type: 'object',
      properties: {
        restaurantName: { type: 'string', description: 'Nombre del local (opcional). Ej: "Daily Grind"' }
      }
    }
  },
  {
    name: 'get_promos',
    description: 'Devuelve promos con costo total y margen. Filtra opcionalmente por nombre de restaurante.',
    input_schema: {
      type: 'object',
      properties: {
        restaurantName: { type: 'string', description: 'Nombre del local (opcional)' }
      }
    }
  },
  {
    name: 'get_ingredients',
    description: 'Devuelve ingredientes con su costo por unidad actual.',
    input_schema: { type: 'object', properties: {} }
  }
];

async function executeAgentTool(toolName, toolInput) {
  if (toolName === 'get_restaurants') {
    const snap = await db.collection('restaurants').get();
    return snap.docs.map(d => ({ id: d.id, name: d.data().name }));
  }

  if (toolName === 'get_ingredients') {
    const snap = await db.collection('products').get();
    return snap.docs.map(d => ({
      name: d.data().name, unit: d.data().unit || '',
      costPerUnit: d.data().costPerUnit || 0, category: d.data().category || ''
    }));
  }

  if (toolName === 'get_recipes') {
    const [rSnap, pSnap, iSnap] = await Promise.all([
      db.collection('recipes').get(),
      db.collection('preparations').get(),
      db.collection('products').get()
    ]);
    const preparations = pSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const ingredients  = iSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    let recipes = rSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (toolInput.restaurantName) {
      const q = toolInput.restaurantName.toLowerCase();
      recipes = recipes.filter(r => (r.restaurantName || '').toLowerCase().includes(q));
    }
    return recipes.map(r => {
      const cost       = agentCalcRecipeCost(r, preparations, ingredients);
      const selling    = r.sellingPrice || 0;
      const sellingNet = selling > 0 ? selling / 1.19 : 0;
      const margin     = sellingNet > 0 ? ((sellingNet - cost) / sellingNet * 100) : null;
      return {
        nombre: r.name, local: r.restaurantName || '—', categoria: r.category || '—',
        costo: Math.round(cost), precioVenta: selling,
        margen: margin !== null ? Math.round(margin) + '%' : 'sin precio',
        porciones: r.porciones || 1,
        ingredientes: (r.ingredients || []).filter(i => i.quantity > 0).length
      };
    }).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  }

  if (toolName === 'get_promos') {
    const [promoSnap, recipeSnap, prepSnap, ingSnap] = await Promise.all([
      db.collection('promos').get(),
      db.collection('recipes').get(),
      db.collection('preparations').get(),
      db.collection('products').get()
    ]);
    const recipes      = recipeSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const preparations = prepSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const ingredients  = ingSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    let promos = promoSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (toolInput.restaurantName) {
      const q = toolInput.restaurantName.toLowerCase();
      promos = promos.filter(p => (p.restaurantName || '').toLowerCase().includes(q));
    }
    return promos.map(p => {
      const recipeObjs = (p.recipes || []).map(id => recipes.find(r => r.id === id)).filter(Boolean);
      const cost       = recipeObjs.reduce((s, r) => s + agentCalcRecipeCost(r, preparations, ingredients), 0);
      const selling    = p.sellingPrice || 0;
      const sellingNet = selling > 0 ? selling / 1.19 : 0;
      const margin     = sellingNet > 0 ? ((sellingNet - cost) / sellingNet * 100) : null;
      return {
        nombre: p.name, local: p.restaurantName || '—',
        recetas: recipeObjs.map(r => r.name),
        costo: Math.round(cost), precioVenta: selling,
        margen: margin !== null ? Math.round(margin) + '%' : 'sin precio'
      };
    });
  }

  return { error: 'Tool no encontrada' };
}

app.post('/api/agent', requireAuth, async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API key no configurada' });
  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: 'Mensaje requerido' });

  const system = `Eres un asistente experto en análisis de costos y márgenes para restaurantes del grupo Monaco (Chile).
Tenés acceso a datos reales de recetas, ingredientes, preparaciones y promos de los locales.
Los locales incluyen: Daily Grind, Fuente Zapallar, y otros del grupo.
Los precios están en pesos chilenos (CLP). El IVA en Chile es 19% — los precios de venta son brutos (con IVA).
El margen se calcula como: (precioVenta/1.19 - costo) / (precioVenta/1.19) × 100.
Cuando necesites datos, usá las herramientas disponibles. Respondé siempre en español, con números concretos y recomendaciones útiles.`;

  const messages = [...history, { role: 'user', content: message }];

  try {
    let response = await anthropic.messages.create({
      model: 'claude-opus-4-6', max_tokens: 2048,
      system, tools: AGENT_TOOLS, messages,
      thinking: { type: 'adaptive' }
    });

    while (response.stop_reason === 'tool_use') {
      const toolBlocks = response.content.filter(b => b.type === 'tool_use');
      messages.push({ role: 'assistant', content: response.content });
      const results = [];
      for (const tool of toolBlocks) {
        const result = await executeAgentTool(tool.name, tool.input);
        results.push({ type: 'tool_result', tool_use_id: tool.id, content: JSON.stringify(result) });
      }
      messages.push({ role: 'user', content: results });
      response = await anthropic.messages.create({
        model: 'claude-opus-4-6', max_tokens: 2048,
        system, tools: AGENT_TOOLS, messages,
        thinking: { type: 'adaptive' }
      });
    }

    const text = response.content.find(b => b.type === 'text')?.text || '';
    messages.push({ role: 'assistant', content: response.content });
    // Strip non-serializable thinking blocks from history
    const cleanHistory = messages.map(m => ({
      role: m.role,
      content: Array.isArray(m.content)
        ? m.content.filter(b => b.type !== 'thinking').map(b => b.type === 'text' ? { type: 'text', text: b.text } : b)
        : m.content
    }));
    res.json({ response: text, history: cleanHistory });
  } catch (e) {
    console.error('Agent error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = app;

if (require.main === module) {
  const PORT = 3737;
  app.listen(PORT, () => console.log(`\n  ✓ Fudo Connect: http://localhost:${PORT}\n`));
}
