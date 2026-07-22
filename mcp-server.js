require('dotenv').config();
const express        = require('express');
const admin          = require('firebase-admin');
const { randomUUID } = require('crypto');
const { McpServer }  = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');
const { z } = require('zod');

// ── Firebase ──────────────────────────────────────────────────────────────────
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

// ── Config ────────────────────────────────────────────────────────────────────
const MCP_ACCESS_TOKEN = (process.env.MCP_ACCESS_TOKEN || '').trim();
const PORT = Number(process.env.MCP_PORT) || 3738;

// ── Calc de costos (misma lógica que server.js) ───────────────────────────────
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

// ── Herramientas MCP ──────────────────────────────────────────────────────────
function createMcpServer() {
  const server = new McpServer({ name: 'fudo-connect', version: '1.0.0' });

  server.tool(
    'get_restaurantes',
    'Lista los locales del grupo con su id y nombre.',
    {},
    async () => {
      const snap = await db.collection('restaurants').get();
      const result = snap.docs.map(d => ({ id: d.id, nombre: d.data().name }));
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'get_menu_categorias',
    'Devuelve todas las categorías de la carta (extraídas de las recetas).',
    {},
    async () => {
      const snap = await db.collection('recipes').get();
      const cats = [...new Set(
        snap.docs.map(d => d.data().category || '').filter(Boolean)
      )].sort((a, b) => a.localeCompare(b, 'es'));
      return { content: [{ type: 'text', text: JSON.stringify(cats, null, 2) }] };
    }
  );

  server.tool(
    'get_productos',
    'Devuelve productos de la carta con nombre, categoría y precio de venta. Filtrable por local y categoría.',
    {
      restaurantName: z.string().optional().describe('Nombre del local (opcional). Ej: "Daily Grind"'),
      category:       z.string().optional().describe('Categoría de carta (opcional). Ej: "Bebidas"'),
    },
    async ({ restaurantName, category }) => {
      const snap = await db.collection('recipes').get();
      let items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (restaurantName) {
        const q = restaurantName.toLowerCase();
        items = items.filter(r => (r.restaurantName || '').toLowerCase().includes(q));
      }
      if (category) {
        const q = category.toLowerCase();
        items = items.filter(r => (r.category || '').toLowerCase().includes(q));
      }
      const result = items.map(r => ({
        nombre:      r.name,
        local:       r.restaurantName || '—',
        categoria:   r.category || '—',
        precioVenta: r.sellingPrice || 0,
      })).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'get_recetas',
    'Devuelve recetas con nombre, categoría, costo calculado, precio de venta y margen (%). Filtrable por local.',
    {
      restaurantName: z.string().optional().describe('Nombre del local (opcional)'),
    },
    async ({ restaurantName }) => {
      const [rSnap, pSnap, iSnap] = await Promise.all([
        db.collection('recipes').get(),
        db.collection('preparations').get(),
        db.collection('products').get(),
      ]);
      const preparations = pSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const ingredients  = iSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      let recipes = rSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (restaurantName) {
        const q = restaurantName.toLowerCase();
        recipes = recipes.filter(r => (r.restaurantName || '').toLowerCase().includes(q));
      }
      const result = recipes.map(r => {
        const cost       = agentCalcRecipeCost(r, preparations, ingredients);
        const selling    = r.sellingPrice || 0;
        const sellingNet = selling > 0 ? selling / 1.19 : 0;
        const margin     = sellingNet > 0 ? Math.round((sellingNet - cost) / sellingNet * 100) : null;
        return {
          nombre:      r.name,
          local:       r.restaurantName || '—',
          categoria:   r.category || '—',
          costo:       Math.round(cost),
          precioVenta: selling,
          margen:      margin !== null ? margin + '%' : 'sin precio',
          porciones:   r.porciones || 1,
        };
      }).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'get_promos',
    'Devuelve promociones activas con nombre, recetas incluidas, precio de venta y margen (%). Filtrable por local.',
    {
      restaurantName: z.string().optional().describe('Nombre del local (opcional)'),
    },
    async ({ restaurantName }) => {
      const [promoSnap, recipeSnap, prepSnap, ingSnap] = await Promise.all([
        db.collection('promos').get(),
        db.collection('recipes').get(),
        db.collection('preparations').get(),
        db.collection('products').get(),
      ]);
      const recipes      = recipeSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const preparations = prepSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const ingredients  = ingSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      let promos = promoSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (restaurantName) {
        const q = restaurantName.toLowerCase();
        promos = promos.filter(p => (p.restaurantName || '').toLowerCase().includes(q));
      }
      const result = promos.map(p => {
        const recipeObjs = (p.recipes || []).map(id => recipes.find(r => r.id === id)).filter(Boolean);
        const cost       = recipeObjs.reduce((s, r) => s + agentCalcRecipeCost(r, preparations, ingredients), 0);
        const selling    = p.sellingPrice || 0;
        const sellingNet = selling > 0 ? selling / 1.19 : 0;
        const margin     = sellingNet > 0 ? Math.round((sellingNet - cost) / sellingNet * 100) : null;
        return {
          nombre:      p.name,
          local:       p.restaurantName || '—',
          recetas:     recipeObjs.map(r => r.name),
          costo:       Math.round(cost),
          precioVenta: selling,
          margen:      margin !== null ? margin + '%' : 'sin precio',
        };
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  return server;
}

// ── Express + rutas MCP ───────────────────────────────────────────────────────
const app = express();
app.use(express.json());

function checkAuth(req, res) {
  if (!MCP_ACCESS_TOKEN) return true;
  const header = (req.headers.authorization || '').trim();
  const token  = header.startsWith('Bearer ') ? header.slice(7).trim() : header;
  if (token !== MCP_ACCESS_TOKEN) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

const sessions = {};

app.post('/mcp', async (req, res) => {
  if (!checkAuth(req, res)) return;

  const sessionId = req.headers['mcp-session-id'];
  let transport;

  if (sessionId && sessions[sessionId]) {
    transport = sessions[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => { sessions[sid] = transport; },
    });
    transport.onclose = () => {
      if (transport.sessionId) delete sessions[transport.sessionId];
    };
    const server = createMcpServer();
    await server.connect(transport);
  } else {
    return res.status(400).json({ error: 'Falta mcp-session-id o no es un initialize request' });
  }

  await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', async (req, res) => {
  if (!checkAuth(req, res)) return;
  const transport = sessions[req.headers['mcp-session-id']];
  if (!transport) return res.status(404).json({ error: 'Sesión no encontrada' });
  await transport.handleRequest(req, res);
});

app.delete('/mcp', async (req, res) => {
  if (!checkAuth(req, res)) return;
  const transport = sessions[req.headers['mcp-session-id']];
  if (!transport) return res.status(404).json({ error: 'Sesión no encontrada' });
  await transport.handleRequest(req, res);
});

app.listen(PORT, () => {
  console.log(`✅  MCP server escuchando en http://localhost:${PORT}/mcp`);
  if (!MCP_ACCESS_TOKEN) {
    console.warn('⚠️   MCP_ACCESS_TOKEN no configurado — el servidor está abierto sin autenticación');
  }
});
