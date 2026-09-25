// §HEADER — Order Preview Worker
// skills: ecommoda-worker-builder v3.9.2 · ecommoda-constants v4.0.0 · shopify-graphql-helper · ecommoda-order-lifecycle
const TOOL_NAME = 'order_preview';
const TOOL_VERSION = '1.0.0';
const AUTH_APPS = new Set([TOOL_NAME]);
function resolveAuthTool(appId) { return AUTH_APPS.has(appId) ? appId : TOOL_NAME; }

// §CORS — read-only tool
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};
function getCORS(_request) { return CORS_HEADERS; }
function json(data, status = 200, request = null) {
  const headers = { 'Content-Type': 'application/json' };
  Object.assign(headers, request ? getCORS(request) : { 'Access-Control-Allow-Origin': '*' });
  return new Response(JSON.stringify(data), { status, headers });
}

// §SHOPIFY — credentials remain on the Worker
const OAUTH_MAX_ATTEMPTS = 3;
async function getAccessToken(env) {
  let lastErr = null;
  for (let attempt = 1; attempt <= OAUTH_MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(`https://${env.SHOP_DOMAIN}/admin/oauth/access_token`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET,
                               grant_type: 'client_credentials' }),
      });
      if (!resp.ok) {
        const retriable = resp.status === 429 || resp.status >= 500;
        lastErr = new Error(`OAuth failed: ${resp.status}`);
        if (retriable && attempt < OAUTH_MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 700 * attempt)); continue; }
        throw lastErr;
      }
      const data = await resp.json();
      if (!data.access_token) throw new Error('OAuth: No access_token in response');
      return data.access_token;
    } catch (e) {
      lastErr = e;
      if (attempt < OAUTH_MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 400 * attempt)); continue; }
      throw lastErr;
    }
  }
  throw lastErr || new Error('OAuth: unknown failure');
}

let _lastThrottle = null, _lastQueryCost = null;

async function shopifyGQL(env, token, query, variables = {}, opName = 'shopify', costLog = null) {
  const MAX_ATTEMPTS = 3;
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let resp, text;
    try {
      resp = await fetch(`https://${env.SHOP_DOMAIN}/admin/api/2026-01/graphql.json`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body:    JSON.stringify({ query, variables }),
      });
      text = await resp.text();
    } catch (e) {
      lastErr = new Error(`${opName}: network failure — ${e.message}`);
      if (attempt < MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 400 * attempt)); continue; }
      throw lastErr;
    }

    if (!resp.ok) {                                    // ② never skip this
      const retriable = resp.status === 429 || resp.status >= 500;
      lastErr = new Error(`${opName}: Shopify HTTP ${resp.status} — ${text.slice(0, 180)}`);
      if (retriable && attempt < MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 700 * attempt)); continue; }
      throw lastErr;
    }

    let data;
    try { data = JSON.parse(text); }                   // ③
    catch { throw new Error(`${opName}: non-JSON response — ${text.slice(0, 180)}`); }

    if (Array.isArray(data.errors) && data.errors.length) {          // ④ ⭐
      const codes = data.errors.map(e => e?.extensions?.code).filter(Boolean);
      lastErr = new Error(
        `${opName}: ${data.errors.map(e => e.message).join(' | ')}` +
        (codes.length ? ` [${codes.join(',')}]` : '')
      );
      if (codes.includes('THROTTLED') && attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, 1200 * attempt)); continue;
      }
      throw lastErr;
    }

    if (!data.data) throw new Error(`${opName}: response has no data — ${text.slice(0, 180)}`);  // ⑤

    // ⑥ التكلفة — رقمان مختلفان، والاتنين مطلوبين (Step 1C)
    if (data.extensions?.cost) {
      const c = data.extensions.cost;
      if (c.throttleStatus) _lastThrottle = c.throttleStatus;          // الرصيد المتبقي بعد النداء
      _lastQueryCost = { op: opName, requested: c.requestedQueryCost ?? null,
                         actual: c.actualQueryCost ?? null };          // تكلفة النداء ده فعليًا
      if (costLog) costLog.push({ op: opName, requested: c.requestedQueryCost ?? null,
                                  actual: c.actualQueryCost ?? null });
    }
    return data;
  }
  throw lastErr || new Error(`${opName}: unknown failure`);
}


// ═══════════════════════════════════════════════════════════════
// SHARED: Auth & Logging Functions — EcomModa D1 Pattern v1.3.0
// Copy this block VERBATIM into every Worker — no modifications
// Place BEFORE the export default { } block
// ═══════════════════════════════════════════════════════════════

/**
 * Verify employee and return display_name if correct.
 * Updates last_login automatically.
 * Returns: string (display_name) or null if wrong PIN.
 * Throws: Error if account is suspended.
 */
async function verifyEmployee(db, username, pin) {
  const row = await db.prepare(
    'SELECT display_name, is_active FROM employees WHERE username = ? AND pin = ?'
  ).bind(username, pin).first();

  if (!row) return null;

  if (!row.is_active) {
    throw new Error('الحساب موقوف — تواصل مع المسؤول');
  }

  db.prepare('UPDATE employees SET last_login = ? WHERE username = ?')
    .bind(new Date().toISOString(), username)
    .run()
    .catch(() => {});

  return row.display_name;
}

/**
 * Check if employee exists and has a PIN registered.
 * Used in Login screen to decide: normal login vs first-time PIN setup.
 */
async function checkEmployee(db, username) {
  const row = await db.prepare(
    'SELECT is_active, pin FROM employees WHERE username = ?'
  ).bind(username).first();

  if (!row) return { exists: false, hasPin: false, isActive: false };
  return {
    exists:   true,
    hasPin:   !!row.pin,
    isActive: !!row.is_active,
  };
}

/**
 * Register PIN for the first time.
 * Throws if: user not found / suspended / already has PIN.
 */
async function registerPin(db, username, pin) {
  const row = await db.prepare(
    'SELECT pin, is_active FROM employees WHERE username = ?'
  ).bind(username).first();

  if (!row)           throw new Error('اسم المستخدم غير موجود');
  if (!row.is_active) throw new Error('الحساب موقوف — تواصل مع المسؤول');
  if (row.pin)        throw new Error('هذا المستخدم مسجّل بالفعل — تواصل مع المسؤول لإعادة الضبط');

  await db.prepare('UPDATE employees SET pin = ? WHERE username = ?')
    .bind(pin, username)
    .run();

  return true;
}

/**
 * Write a log entry to D1.
 * Only tool and type are required. All other fields optional (null if not provided).
 */
async function writeLog(db, entry) {
  await db.prepare(`
    INSERT INTO logs
      (timestamp, tool, type, employee, order_id, order_name,
       sku, product_title, delta, value_before, value_after, notes, extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    entry.timestamp    ?? new Date().toISOString(),
    entry.tool,
    entry.type,
    entry.employee     ?? null,
    entry.orderId      ?? null,
    entry.orderName    ?? null,
    entry.sku          ?? null,
    entry.productTitle ?? null,
    entry.delta        ?? null,
    entry.valueBefore  ?? null,
    entry.valueAfter   ?? null,
    entry.notes        ?? null,
    entry.extra ? JSON.stringify(entry.extra) : null
  ).run();
}

const LOG_EXPORT_MAX = 2000;   // سقف التصدير — بيرجع للواجهة كـ `cap`

/**
 * بنّاء شرط الفلترة الموحّد للسجل — التلات دوال تحته بتستخدمه، فمفيش SQL
 * مكرر يتعتّق في واحدة منهم ويسيب التانية.
 *
 * كل الباراميترات **اختيارية**، والسلوك من غيرها **مطابق للنسخة القديمة
 * بالحرف** — الإضافة متوافقة رجوعيًا ١٠٠٪:
 *   employees[] / types[]  → قوايم. multi-select إلزامي في أي شاشة فيها جدول
 *                            (`ecommoda-html-builder` → data-table-standard.md
 *                            بند ٢١)، والسجل بقى جدول (بند ٢٦).
 *   employee / type        → قيمة واحدة — متسابة للتوافق مع واجهات قديمة.
 *   dateFrom / dateTo      → بيتقارنوا بـ substr(timestamp,1,10) — يعني **UTC**،
 *                            والعرض بتوقيت القاهرة (UTC+3). فرق التلات ساعات
 *                            ممكن يحط عملية بعد ٩ مساءً بتوقيت القاهرة في يوم
 *                            UTC اللي بعده. مقبول لفلتر بالأيام — **بس مكتوب**،
 *                            عشان مايتكتشفش كباج بعدين.
 * login/logout مستثنيين في SQL دايمًا — مش client-side.
 */
function buildLogFilterSQL(select, {
  tool      = null,
  employee  = null, employees = null,
  type      = null, types     = null,
  search    = null,
  dateFrom  = null, dateTo    = null,
} = {}) {
  let sql = `${select} FROM logs WHERE type NOT IN ('login','logout')`;
  const b = [];

  const emps = Array.isArray(employees) && employees.length ? employees : (employee ? [employee] : []);
  const typs = Array.isArray(types)     && types.length     ? types     : (type     ? [type]     : []);

  if (tool) { sql += ' AND tool = ?'; b.push(tool); }
  if (emps.length) {
    sql += ` AND employee IN (${emps.map(() => '?').join(',')})`; b.push(...emps);
  }
  if (typs.length) {
    sql += ` AND type IN (${typs.map(() => '?').join(',')})`; b.push(...typs);
  }
  if (search) {
    sql += ' AND (order_name LIKE ? OR notes LIKE ?)';
    b.push(`%${search}%`, `%${search}%`);
  }
  if (dateFrom) { sql += ' AND substr(timestamp, 1, 10) >= ?'; b.push(dateFrom); }
  if (dateTo)   { sql += ' AND substr(timestamp, 1, 10) <= ?'; b.push(dateTo); }

  return { sql, b };
}

/**
 * Fetch logs from D1 with server-side filtering + pagination.
 * Used for paginated display in the log tab (100 rows per page).
 * Max limit per page: 100 (enforced server-side).
 *
 * ⚠️ Do NOT use this for XLSX export — use getLogsExport() instead.
 */
async function getLogs(db, { limit = 100, offset = 0, sortBy, sortDir, ...filters } = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT *', filters);
  const q = sql + orderByClause(sortBy, sortDir) + ' LIMIT ? OFFSET ?';
  return (await db.prepare(q)
    .bind(...b, Math.min(limit, 100), Math.max(offset, 0)).all()).results;
}

// ⚠️ قائمة **مقفولة** — القيمة جاية من العميل وبتتلزق في نص SQL مباشرةً
//    (ORDER BY مابيقبلش bind). أي قيمة بره القايمة بترجع للافتراضي بدون خطأ.
// ⚠️ المفاتيح لازم تطابق `data-sort-key` في الواجهة **حرفيًا** — مفتاح مش في
//    القايمة بيرجع للافتراضي في صمت، فالعمود يبان إنه اترتّب وهو مااترتّبش.
const LOG_SORT_COLUMNS = {
  date: 'timestamp', time: 'timestamp', employee: 'employee', orderName: 'order_name',
  machine: `json_extract(extra, '$.machine')`, result: `json_extract(extra, '$.result')`,
};

function orderByClause(sortBy, sortDir) {
  const col = LOG_SORT_COLUMNS[String(sortBy || '')] || 'timestamp';
  const dir = String(sortDir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  // 🔴 كاسر تعادل إلزامي: من غيره صفوف نفس القيمة بترتيب عشوائي بين الصفحات،
  //    والصف الواحد ممكن يظهر في صفحتين **أو مايظهرش خالص**.
  return col === 'timestamp' ? ` ORDER BY timestamp ${dir}`
                             : ` ORDER BY ${col} ${dir}, timestamp DESC`;
}

/**
 * Count total matching log rows.
 * Call in parallel with getLogs() (pagination UI) — and with getLogsExport()
 * (عشان الواجهة تعرف إن التصدير اتقص).
 */
async function getLogsCount(db, filters = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT COUNT(*) as total', filters);
  const row = await db.prepare(sql).bind(...b).first();
  return row?.total ?? 0;
}

/**
 * Fetch all matching logs for XLSX export — up to LOG_EXPORT_MAX rows.
 * Never use getLogs() for export — it's limited to 100 rows per page.
 *
 * ⚠️ الدالة دي **بتقص في السكوت** بطبيعتها. المسؤولية اللي جنبها إلزامية:
 * الـ endpoint لازم يرجّع `cap` و`total` و`truncated` كمان — شوف تحت.
 */
async function getLogsExport(db, filters = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT *', filters);
  // ⚠️ التصدير والعدّ **بيتجاهلوا الترتيب عن قصد** — العدّ مالوش ترتيب،
  //    والتصدير بياخد ترتيب السيرفر الافتراضي. تمرير sortBy/sortDir ليهم بيفتح
  //    باب اختلاف مصدر الباراميترات بين النداءات = تصدير مش مطابق للشاشة.
  const q = sql + ' ORDER BY timestamp DESC LIMIT ?';
  return (await db.prepare(q).bind(...b, LOG_EXPORT_MAX).all()).results;
}

/**
 * بيقرا فلاتر السجل من الـ query string — CSV للقوايم
 * (employees=ahmed,sara · types=cancel,cancel_failed).
 * الاسم المفرد لسه مقبول للتوافق الرجعي.
 */
function logParamsFrom(url, tool) {
  const csv = (k) => (url.searchParams.get(k) || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const employees = csv('employees'), types = csv('types');
  return {
    tool,
    employees: employees.length ? employees : null,
    employee:  url.searchParams.get('employee') || null,
    types:     types.length ? types : null,
    type:      url.searchParams.get('type')     || null,
    search:    url.searchParams.get('search')   || null,
    dateFrom:  url.searchParams.get('dateFrom') || null,
    dateTo:    url.searchParams.get('dateTo')   || null,
  };
}

// ═══════════════════════════════════════════════════════════════
// END SHARED BLOCK
// ═══════════════════════════════════════════════════════════════


// §SECTION::orderLookup — search by name and verify the exact returned key
const SEARCH_ORDER = `query SearchOrder($query: String!) {
  orders(first: 20, query: $query) {
    nodes { id name }
    pageInfo { hasNextPage }
  }
}`;

const ORDER_DETAILS = `query OrderDetails($id: ID!) {
  order(id: $id) {
    id legacyResourceId name createdAt updatedAt cancelledAt
    displayFinancialStatus displayFulfillmentStatus currencyCode
    email phone note tags
    totalPriceSet { shopMoney { amount currencyCode } }
    currentTotalPriceSet { shopMoney { amount currencyCode } }
    subtotalPriceSet { shopMoney { amount currencyCode } }
    totalShippingPriceSet { shopMoney { amount currencyCode } }
    totalTaxSet { shopMoney { amount currencyCode } }
    totalDiscountsSet { shopMoney { amount currencyCode } }
    totalOutstandingSet { shopMoney { amount currencyCode } }
    customer { displayName email phone }
    shippingAddress { name address1 address2 city province country zip phone }
    billingAddress { name address1 address2 city province country zip phone }
    lineItems(first: 100) {
      nodes {
        id title variantTitle sku quantity currentQuantity
        originalUnitPriceSet { shopMoney { amount currencyCode } }
      }
      pageInfo { hasNextPage endCursor }
    }
    fulfillments(first: 10) {
      id status createdAt trackingInfo { number url company }
    }
    manualStatus: metafield(namespace: "custom", key: "manual_status") { value }
    returnStatus: metafield(namespace: "custom", key: "status_2_r_e") { value }
    zone: metafield(namespace: "custom", key: "zone") { value }
    courier: metafield(namespace: "custom", key: "courier") { value }
  }
}`;

const ORDER_ITEMS_PAGE = `query OrderItemsPage($id: ID!, $after: String!) {
  order(id: $id) {
    lineItems(first: 100, after: $after) {
      nodes {
        id title variantTitle sku quantity currentQuantity
        originalUnitPriceSet { shopMoney { amount currencyCode } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

async function lookupOrder(env, input) {
  const raw = String(input ?? '').trim();
  // Keep the employee's exact number; never silently sanitize to another order.
  if (!/^#?[0-9]+$/.test(raw)) {
    return { status: 400, body: { ok: false, error: 'أدخل رقم الطلب بالأرقام فقط، مع # اختياريًا' } };
  }
  const name = '#' + raw.replace(/^#/, '');
  const token = await getAccessToken(env);
  const search = await shopifyGQL(env, token, SEARCH_ORDER, { query: `name:${name}` }, 'search_order');
  const matches = search.data.orders.nodes.filter(node => node.name === name);
  if (matches.length > 1) {
    return { status: 409, body: { ok: false, error: 'البحث أعاد أكثر من طلب مطابق؛ راجع Shopify' } };
  }
  if (!matches.length) {
    if (search.data.orders.pageInfo.hasNextPage) {
      return { status: 409, body: { ok: false, error: 'نتائج البحث كثيرة ولم يمكن تأكيد عدم وجود الطلب' } };
    }
    return { status: 404, body: { ok: false, error: 'الطلب غير موجود ضمن الطلبات المتاحة للتطبيق. تأكد من الرقم وصلاحية read_all_orders للطلبات القديمة.' } };
  }
  const detail = await shopifyGQL(env, token, ORDER_DETAILS, { id: matches[0].id }, 'order_details');
  const order = detail.data.order;
  if (!order || order.name !== name) {
    return { status: 409, body: { ok: false, error: 'تعذر تأكيد تطابق رقم الطلب' } };
  }
  const items = [...order.lineItems.nodes];
  let page = order.lineItems.pageInfo;
  while (page.hasNextPage) {
    if (!page.endCursor || items.length >= 1000) {
      return { status: 422, body: { ok: false, error: 'عدد المنتجات تجاوز حد العرض الآمن؛ افتح الطلب في Shopify' } };
    }
    const next = await shopifyGQL(env, token, ORDER_ITEMS_PAGE, { id: order.id, after: page.endCursor }, 'order_items');
    if (!next.data.order?.lineItems) throw new Error('Order line item page missing');
    items.push(...next.data.order.lineItems.nodes);
    page = next.data.order.lineItems.pageInfo;
  }
  order.lineItems = items;
  order.orderNumber = order.name;
  order.orderId = String(order.legacyResourceId || order.id.split('/').pop());
  return { status: 200, body: { ok: true, order } };
}

// §SECTION::requestHandler
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: getCORS(request) });
    const authHeader = request.headers.get('Authorization');
    if (!env.WORKER_SECRET || authHeader !== `Bearer ${env.WORKER_SECRET}`)
      return json({ ok: false, error: 'Unauthorized' }, 401, request);
    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    try {
// ═══════════════════════════════════════════════════════════════
// AUTH ENDPOINTS — paste inside the try{} block of fetch handler
// ═══════════════════════════════════════════════════════════════

// ── check_employee — GET (no sensitive data — GET is ok) ──────
if (action === 'check_employee') {
  const username = url.searchParams.get('username');
  if (!username) return json({ ok: false, error: 'username مطلوب' }, 400, request);
  const result = await checkEmployee(env.DB, username);
  return json({ ok: true, ...result }, 200, request);
}

// ── register_pin — POST (PIN in body — GET is FORBIDDEN) ──────
if (action === 'register_pin') {
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
  const { username, pin } = await request.json().catch(() => ({}));
  if (!username || !pin) return json({ ok: false, error: 'username و pin مطلوبان' }, 400, request);
  await registerPin(env.DB, username, pin);
  return json({ ok: true }, 200, request);
}

// ── verify_employee — POST (PIN in body — GET is FORBIDDEN) ───
if (action === 'verify_employee') {
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
  // appId اختياري — بس لو الـ Worker بيخدم أكتر من واجهة (هب). راجع
  // ecommoda-worker-builder § باراميتر appId قبل ما تضيفه: القايمة البيضاء
  // AUTH_APPS **مقفولة**، والقيمة اللي مش فيها بترجع للاسم الافتراضي بلا خطأ.
  const { username, pin, appId } = await request.json().catch(() => ({}));
  if (!username || !pin) return json({ ok: false, error: 'username و pin مطلوبان' }, 400, request);

  const displayName = await verifyEmployee(env.DB, username, pin);
  if (!displayName) return json({ ok: false, error: 'PIN خطأ أو المستخدم غير موجود' }, 401, request);

  // ⚠️ الدخول نفسه نجح فعلاً هنا (verifyEmployee فوق رجّعت displayName صحيح).
  // فشل D1 بعد كده لازم يترجع كـ logged:false — مش يسقّط الرد كله على 500
  // لدخول حصل فعلاً (Step 5A ⑦ في ecommoda-worker-builder).
  let logged = true;
  try {
    await writeLog(env.DB, {
      tool:     resolveAuthTool(appId),   // = TOOL_NAME لو مفيش appId أو مش في AUTH_APPS
      type:     'login',
      employee: username,
      notes:    `دخول: ${displayName}`,
    });
  } catch (e) {
    logged = false;
  }
  return json({ ok: true, displayName, logged }, 200, request);
}

// ── log_logout — GET ok (no sensitive data) ───────────────────
if (action === 'log_logout') {
  const username = url.searchParams.get('username');
  const appId    = url.searchParams.get('appId');   // اختياري — نفس قاعدة verify_employee
  let logged = true;
  if (username) {
    try {
      await writeLog(env.DB, {
        tool:     resolveAuthTool(appId),
        type:     'logout',
        employee: username,
        notes:    `خروج: ${username.replace(/_/g, ' ')}`,
      });
    } catch (e) {
      logged = false;
    }
  }
  return json({ ok: true, logged }, 200, request);
}

// ── get_logs — GET with optional filters ──────────────────────
if (action === 'get_logs') {
  const entries = await getLogs(env.DB, {
    tool:     url.searchParams.get('tool')     || TOOL_NAME,
    employee: url.searchParams.get('employee') || null,
    type:     url.searchParams.get('type')     || null,
    search:   url.searchParams.get('search')   || null,
    limit:    parseInt(url.searchParams.get('limit')  || '200'),
    offset:   parseInt(url.searchParams.get('offset') || '0'),
  });
  return json({ ok: true, entries }, 200, request);
}

// ── get_employees — GET (for HTML dropdown) ───────────────────
if (action === 'get_employees') {
  const { results } = await env.DB.prepare(
    'SELECT username, display_name FROM employees WHERE is_active = 1 ORDER BY display_name'
  ).all();
  return json({ ok: true, employees: results }, 200, request);
}

// ═══════════════════════════════════════════════════════════════
// END AUTH ENDPOINTS BLOCK
// ═══════════════════════════════════════════════════════════════
      if (action === 'get_config')
        return json({ ok: true, version: TOOL_VERSION, tool: TOOL_NAME }, 200, request);
      if (action === 'diag') {
        const token = await getAccessToken(env);
        const scopes = await shopifyGQL(env, token,
          'query OrderPreviewScopes { currentAppInstallation { accessScopes { handle } } }', {}, 'diag_scopes');
        const names = scopes.data.currentAppInstallation?.accessScopes?.map(s => s.handle) || [];
        return json({ ok: true, read_orders: names.includes('read_orders'),
          read_all_orders: names.includes('read_all_orders') }, 200, request);
      }
      if (action === 'lookup_order') {
        if (request.method !== 'POST') return json({ ok: false, error: 'POST required' }, 405, request);
        const body = await request.json().catch(() => ({}));
        const result = await lookupOrder(env, body.orderNumber);
        return json(result.body, result.status, request);
      }
      return json({ ok: false, error: 'Unknown action' }, 404, request);
    } catch (error) {
      return json({ ok: false, error: error.message || 'Internal error' }, 500, request);
    }
  },
};

