#!/usr/bin/env node
/**
 * check-log-values.mjs — تحقق من قيم اللوج بتاعة أداة واحدة
 *
 * بيقرا log-values.json بتاع الأداة، وبيمشي على كودها، وبيقارن.
 * مالوش أي dependency — node بس.
 *
 * الطريقة: anchoring على نداء الكتابة (writeLog / safeWriteLog / writeLogsBatch / …)
 * مع brace-matching على الأقواس، واستخراج type: من جوّه بس.
 * مش بيعتمد على tool: كنص ثابت — لأن ريبو = أداة واحدة.
 *
 * الاستخدام:  node check-log-values.mjs [--dir .] [--registry log-values.json] [--json]
 * الخروج:     0 = تمام · 1 = فيه قيمة مش مسجّلة أو مفردة غلط
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

// ── المفردات المقفولة (§12) ────────────────────────────────────────────────
const RESULTS = ['success', 'rejected', 'already', 'warning', 'error'];
const STAGES  = ['lookup', 'write', 'preflight'];

// ── أسماء نداءات الكتابة اللي بنتعلّق بيها ─────────────────────────────────
// أي شكل تاني يتزوّد هنا (أو في logAnchors جوه log-values.json).
const DEFAULT_ANCHORS = [
  'writeLog', 'safeWriteLog', 'safeLog', 'writeLogsBatch',
  'logWhere', 'logCycleBlocks', 'insertLog', 'addLog', 'logSafe',
  // 🔴 writeLogBatch (من غير s) — سابقة Order-SKU-Barcode-Printer: أداة كاملة
  //    بـ739 صف في D1 فاتت الجرد بسبب حرف واحد في اسم الدالة.
  'writeLogBatch', 'logBatch', 'writeLogs', 'saveLog', 'recordLog',
];

// ── الإعدادات ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const opt  = (k, d) => { const i = args.indexOf(k); return i > -1 ? args[i + 1] : d; };
const ROOT     = opt('--dir', '.');
const REGPATH  = opt('--registry', join(ROOT, 'log-values.json'));
const AS_JSON  = args.includes('--json');
// 🔴 `tests` مستبعدة بقصد: فيها قيم tool/type مزيّفة (سابقة: `tool: 't'` في
//    worker-logs.test.cjs). فيكستشر اختبار بيتحسب استخدام حقيقي = قيمة وهمية
//    بتغطّي على قيمة ناقصة فعلاً.
const SKIP_DIR = new Set(['node_modules', '.git', '.wrangler', 'dist', 'build', 'coverage', 'tests', 'test', '__tests__']);
const EXTS     = new Set(['.js', '.mjs', '.cjs']);

const isScannable = (p) =>
  EXTS.has(extname(p)) && !/\.min\.js$/.test(p) && !p.includes('check-log-values');

// ── قراءة السجل ────────────────────────────────────────────────────────────
if (!existsSync(REGPATH)) {
  console.error(`✗ مفيش سجل: ${REGPATH}\n  اعمل log-values.json جنب كود الأداة الأول.`);
  process.exit(1);
}
const reg = JSON.parse(readFileSync(REGPATH, 'utf8'));
const TOOL = reg.tool;
const registered = new Set(Object.keys(reg.types || {}));
const ANCHORS = new Set([...DEFAULT_ANCHORS, ...(reg.logAnchors || [])]);

// ── المشي على الملفات ──────────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(join(dir, e.name), out); }
    else if (isScannable(e.name)) out.push(join(dir, e.name));
  }
  return out;
}

// ── ماسح يعرف يعدّي على النصوص والتعليقات ─────────────────────────────────
// بيرجّع فهرس القفلة المقابلة للفتحة اللي في `open`، أو -1.
const PAIR = { '(': ')', '{': '}', '[': ']' };
const REGEX_PREV = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '\n', '+', '-', '*', '%', '<', '>', '~', '^']);

function matchSpan(src, open) {
  const stack = [];
  let i = open;
  while (i < src.length) {
    const c = src[i];
    // تعليقات
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) return -1; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); if (e < 0) return -1; i = e + 2; continue; }
    // نصوص
    if (c === "'" || c === '"') { i = skipQuoted(src, i, c); continue; }
    if (c === '`') { i = skipTemplate(src, i); continue; }
    // regex literal
    if (c === '/') {
      let j = i - 1;
      while (j >= 0 && /\s/.test(src[j])) j--;
      if (j < 0 || REGEX_PREV.has(src[j])) { i = skipRegex(src, i); continue; }
    }
    if (PAIR[c]) { stack.push(PAIR[c]); i++; continue; }
    if (c === ')' || c === '}' || c === ']') {
      if (!stack.length) return -1;
      const want = stack.pop();
      if (want !== c) return -1;
      if (!stack.length) return i;
      i++; continue;
    }
    i++;
  }
  return -1;
}
function skipQuoted(src, i, q) {
  i++;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === q) return i + 1;
    if (src[i] === '\n') return i + 1;   // نص مكسور — بلاش نلف للأبد
    i++;
  }
  return i;
}
function skipTemplate(src, i) {
  i++;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === '`') return i + 1;
    if (src[i] === '$' && src[i + 1] === '{') {
      const end = matchSpan(src, i + 1);
      if (end < 0) return src.length;
      i = end + 1; continue;
    }
    i++;
  }
  return i;
}
function skipRegex(src, i) {
  i++;
  let inClass = false;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === '[') inClass = true;
    else if (src[i] === ']') inClass = false;
    else if (src[i] === '/' && !inClass) { i++; while (/[a-z]/i.test(src[i] || '')) i++; return i; }
    else if (src[i] === '\n') return i;
    i++;
  }
  return i;
}

// يرجّع نسخة بنفس الطول من الكود، محتوى النصوص والتعليقات فيها مسح مسافات.
// كده أي بحث بالـ regex مابيماتشش جوه نص (زي notes: `... type:${x}`) — بس الفهارس تفضل هي هي.
function maskLiterals(src) {
  const out = src.split('');
  const blank = (a, b) => { for (let k = a; k < b && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { let e = src.indexOf('\n', i); if (e < 0) e = src.length; blank(i, e); i = e; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2; blank(i, end); i = end; continue; }
    if (c === "'" || c === '"') { const e = skipQuoted(src, i, c); blank(i + 1, e - 1); i = e; continue; }
    if (c === '`') {
      // امسح نص القالب بس، وسيب اللي جوه ${...} كود
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { blank(j, j + 2); j += 2; continue; }
        if (src[j] === '`') { j++; break; }
        if (src[j] === '$' && src[j + 1] === '{') { const e = matchSpan(src, j + 1); if (e < 0) { j = src.length; break; } j = e + 1; continue; }
        blank(j, j + 1); j++;
      }
      i = j; continue;
    }
    if (c === '/') {
      let j = i - 1;
      while (j >= 0 && /\s/.test(src[j])) j--;
      if (j < 0 || REGEX_PREV.has(src[j])) { const e = skipRegex(src, i); blank(i + 1, e - 1); i = e; continue; }
    }
    i++;
  }
  return out.join('');
}

// ── الاستخراج ──────────────────────────────────────────────────────────────
const NB       = "(?<![A-Za-z0-9_$])";                       // يمنع contentType / otype
const RE_TYPEK = new RegExp(`${NB}type\\s*:`, 'g');
// 🔴 الأشكال الشرعية التانية لمفتاح `type` جوّه أوبجكت — لازم كلها تتشاف،
//    لأن اللي مايتشافش بيعدّي في صمت (سابقة: index.js:4326 · `type,` shorthand).
const RE_TYPE_SHORT = /(?<=(?<!\$)[{,]\s*)type\s*(?=[,}])/g;    // { tool, type, employee }
// ⚠️ الـ(?<!\$) مهم: `${type}` جوّه template literal شكله زي الـshorthand بالظبط
//    (محاط بـ{ و})، وبيدّي false positive. سابقة: Order-Printer index.js:2101.
const RE_TYPE_COMP  = /\[\s*(['"])type\1\s*\]\s*:/g;           // { ['type']: x }
const RE_SPREAD     = /\.\.\.\s*([A-Za-z_$][A-Za-z0-9_$]*)/g;  // { ...base, … }
const RE_LOCAL_TYPE = /(?:const|let|var)\s+type\s*=/g;         // const type = <expr>;
const RE_TOOL  = new RegExp(`${NB}tool\\s*:\\s*(['"\`])([^'"\`]*)\\1`, 'g');
const RE_ANCHOR = new RegExp(`${NB}([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\(`, 'g');
const RE_IDENT_ARG = /(?:^|[(,\s])([A-Za-z_$][A-Za-z0-9_$]*)\s*(?=[,)])/g;
const RE_CONST = /(?:const|let|var)\s+([A-Z_$][A-Z0-9_$]*|[A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(['"])((?:\\.|(?!\2)[^\\])*)\2\s*;/g;

const used = new Map();   // type -> Set(مواضع)
const dynamic = new Map();
const otherTools = new Set();
const noAnchorFiles = [];
let sawInsertIntoLogs = false;  // الكاشف المستقل عن أسماء الدوال
let sawAnySpan        = false;
const spreads = new Map();     // نداء فيه ...spread — ممكن يخبّي type
const blindSpans = [];         // نداء أنكور مفيهوش ولا مفتاح type بأي شكل
const add = (map, key, at) => (map.get(key) ?? map.set(key, new Set()).get(key)).add(at);

// يقرا قيمة الحقل من بعد `type:` لحد الفاصلة/القفلة على نفس المستوى (بيعدّي على النصوص والأسطر)
function readValue(src, i) {
  while (i < src.length && /\s/.test(src[i])) i++;
  const start = i;
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) { i = src.length; break; } continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === "'" || c === '"') { i = skipQuoted(src, i, c); continue; }
    if (c === '`') { i = skipTemplate(src, i); continue; }
    if (PAIR[c]) { depth++; i++; continue; }
    if (c === ')' || c === '}' || c === ']') { if (depth === 0) break; depth--; i++; continue; }
    if (depth === 0 && (c === ',' || c === ';')) break;   // `;` مهم للـ shorthand: const type = …;
    i++;
  }
  return src.slice(start, i).trim();
}

// يقسّم تعبير على `?` و `:` في المستوى الأعلى — عشان الترناري
function topSplitTernary(expr) {
  let depth = 0, qi = -1;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === "'" || c === '"') { i = skipQuoted(expr, i, c) - 1; continue; }
    if (c === '`') { i = skipTemplate(expr, i) - 1; continue; }
    if (PAIR[c]) { depth++; continue; }
    if (c === ')' || c === '}' || c === ']') { depth--; continue; }
    if (depth === 0 && c === '?' && expr[i + 1] !== '.' && expr[i + 1] !== '?') { qi = i; break; }
  }
  if (qi < 0) return null;
  let depth2 = 0;
  for (let i = qi + 1; i < expr.length; i++) {
    const c = expr[i];
    if (c === "'" || c === '"') { i = skipQuoted(expr, i, c) - 1; continue; }
    if (c === '`') { i = skipTemplate(expr, i) - 1; continue; }
    if (PAIR[c]) { depth2++; continue; }
    if (c === ')' || c === '}' || c === ']') { depth2--; continue; }
    if (depth2 === 0 && c === '?' && expr[i + 1] !== '.' && expr[i + 1] !== '?') return null; // ترناري متداخل — سيبه ديناميكي
    if (depth2 === 0 && c === ':') return [expr.slice(qi + 1, i).trim(), expr.slice(i + 1).trim()];
  }
  return null;
}

// بيرجّع نص ثابت لو التعبير ينحل، أو null
function asLiteral(expr, consts) {
  const q = expr[0];
  if ((q === "'" || q === '"') && expr.lastIndexOf(q) === expr.length - 1 && expr.length >= 2)
    return expr.slice(1, -1);
  if (q === '`' && expr.endsWith('`') && !expr.includes('${') && expr.length >= 2)
    return expr.slice(1, -1);
  if (/^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)?$/.test(expr) && consts.has(expr)) return consts.get(expr);
  return null;
}

// بيحلّ التعبير لقيمة/قيم ثابتة — أو بيرجّع null لو فيه جزء ديناميكي
function resolve(expr, consts, depth = 0) {
  if (depth > 4) return null;
  const lit = asLiteral(expr, consts);
  if (lit !== null) return [lit];
  const t = topSplitTernary(expr);
  if (t) {
    const a = resolve(t[0], consts, depth + 1);
    const b = resolve(t[1], consts, depth + 1);
    if (a && b) return [...a, ...b];
  }
  return null;
}


// ثوابت الأوبجكت: const LOG_TYPES = { FAILED: 'failed', … }  →  LOG_TYPES.FAILED
const RE_OBJCONST = /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:Object\.freeze\s*\(\s*)?\{/g;
function collectObjConsts(src, mask, into){
  for (const m of mask.matchAll(RE_OBJCONST)) {
    const open = m.index + m[0].length - 1;
    const end = matchSpan(src, open);
    if (end < 0) continue;
    const body = src.slice(open + 1, end);
    const bmask = maskLiterals(body);
    let depth = 0;
    for (let i = 0; i < bmask.length; i++) {
      const c = bmask[i];
      if (PAIR[c]) { depth++; continue; }
      if (c === ')' || c === '}' || c === ']') { depth--; continue; }
      if (depth !== 0) continue;
      const k = /^([A-Za-z_$][A-Za-z0-9_$]*|'[^']*'|"[^"]*")\s*:/.exec(bmask.slice(i));
      if (!k) continue;
      let j = i + k[0].length;
      while (j < body.length && /\s/.test(body[j])) j++;
      const q = body[j];
      if (q === "'" || q === '"') {
        const e = skipQuoted(body, j, q);
        const key = k[1].replace(/^['"]|['"]$/g, '');
        const full = m[1] + '.' + key;
        if (!into.has(full)) into.set(full, body.slice(j + 1, e - 1));
      }
      i = j;
    }
  }
}

const files = walk(ROOT);

// ثوابت على مستوى المشروع — عشان LOG_TYPE_X = 'x' اللي بتتستخدم في type:
const CONSTS = new Map();
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(RE_CONST)) if (!CONSTS.has(m[1])) CONSTS.set(m[1], m[3]);
  collectObjConsts(src, maskLiterals(src), CONSTS);
}

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const mask = maskLiterals(src);          // للبحث · القراءة بتفضل من src
  const rel = relative(ROOT, file) || file;
  const lineAt = (i) => src.slice(0, i).split('\n').length;

  // القيمة بتتقرا من src (المحتوى متمسوح في mask)، بس الموضع بيتأكد من mask —
  // عشان `tool: '…'` جوّه تعليق أو نص مايتحسبش قيمة حقيقية.
  // 🔴 الكاشف اللي مايعتمدش على اسم دالة: الكتابة في D1 نفسها.
  //    أي اسم دالة جديد مش في الأنكورز هيتمسك من هنا بدل ما يعدّي في صمت.
  if (/INSERT\s+INTO\s+logs/i.test(src)) sawInsertIntoLogs = true;

  for (const m of src.matchAll(RE_TOOL))
    if (m[2] !== TOOL && mask.startsWith('tool', m.index)) otherTools.add(m[2]);

  // ١) كل نداء لأنكور: خُد مدى الأقواس بتاعه
  const spans = [];
  const identArgs = new Set();
  for (const m of mask.matchAll(RE_ANCHOR)) {
    if (!ANCHORS.has(m[1])) continue;
    const open = m.index + m[0].length - 1;
    const end = matchSpan(src, open);
    if (end < 0) continue;
    const before = src.slice(Math.max(0, m.index - 20), m.index);
    if (/\b(function|class)\s*$/.test(before)) continue;   // تعريف الدالة نفسها مش نداء
    spans.push([open, end]);
    for (const a of mask.slice(open, end + 1).matchAll(RE_IDENT_ARG)) identArgs.add(a[1]);
  }

  // ١ب) أنكور مسجّل في logAnchors وهو **تعريف دالة** (نمط الـbuilder: دالة
  //      بتبني الصفوف وترجّعها، وحد تاني بيكتبها). المدى هنا جسم الدالة.
  //      سابقة: Order-SKU-Barcode-Printer → buildPrintLogRows.
  for (const name of (reg.logAnchors || [])) {
    const re = new RegExp(`(?:function\\s+${name}\\s*\\(|(?:const|let|var)\\s+${name}\\s*=)`, 'g');
    for (const d of mask.matchAll(re)) {
      let probe = d.index + d[0].length, guard = 0;
      while (probe < src.length && guard++ < 400 && src[probe] !== '{') probe++;
      if (src[probe] === '{') { const end = matchSpan(src, probe); if (end > 0) spans.push([probe, end]); }
    }
  }

  // ٢) المتغيّرات اللي اتمرّرت للأنكور: ضُم مدى التعريف بتاعها كمان (logRows / mfChangeRows …)
  for (const name of identArgs) {
    const re = new RegExp(`(?:const|let|var)\\s+${name}\\s*=`, 'g');
    for (const d of mask.matchAll(re)) {
      let probe = d.index + d[0].length, guard = 0;
      while (probe < src.length && guard++ < 400 && !PAIR[src[probe]] && src[probe] !== ';') probe++;
      if (PAIR[src[probe]]) { const end = matchSpan(src, probe); if (end > 0) spans.push([probe, end]); }
    }
  }

  if (spans.length) sawAnySpan = true;
  if (!spans.length) { if (/\btype\s*:/.test(mask)) noAnchorFiles.push(rel); continue; }

  // ٣) استخرج مفتاح type من جوّه المديات — بكل أشكاله الشرعية.
  //    القاعدة: مايعدّيش مفتاح في صمت. يا يتحلّ لقيمة، يا يتسجّل كـ dynamic،
  //    يا النداء كله يتعلّم إنه أعمى. الشكل اللي مش متوقَّع = تقرير، مش سكوت.
  const seen = new Set();
  for (const [s, e] of spans) {
    const chunk = mask.slice(s, e + 1);
    let found = 0;

    // بيقرا القيمة ويصنّفها — نقطة واحدة عشان التلات أشكال يتعاملوا بنفس المنطق
    const take = (abs, raw) => {
      if (seen.has(abs) || !raw) return;
      seen.add(abs);
      found++;
      const at   = `${rel}:${lineAt(abs)}`;
      const vals = resolve(raw, CONSTS);
      if (vals) for (const v of vals) add(used, v, at);
      else add(dynamic, raw.replace(/\s+/g, ' ').slice(0, 120), at);
    };

    // (أ) الشكل الصريح: type: <expr>
    for (const k of chunk.matchAll(RE_TYPEK)) {
      const abs = s + k.index + k[0].length;
      take(abs, readValue(src, abs));
    }

    // (ب) مفتاح محسوب: ['type']: <expr>
    for (const k of chunk.matchAll(RE_TYPE_COMP)) {
      const abs = s + k.index + k[0].length;
      take(abs, readValue(src, abs));
    }

    // (ج) shorthand: { …, type, … } — القيمة جاية من متغيّر محلي اسمه type.
    //     بندوّر على تعريفه جوّه نفس المدى؛ لو ملقناهوش، القيمة مجهولة بس
    //     **مرئية** — وده الفرق عن النهارده اللي كانت بتختفي خالص.
    for (const k of chunk.matchAll(RE_TYPE_SHORT)) {
      const abs = s + k.index;
      if (seen.has(abs)) continue;
      // بندوّر على آخر `const type = …` قبل موضع الاستخدام — جوّه النداء الأول،
      // وبعدين في الكود اللي قبله (التعريف كتير بيبقى فوق النداء مش جوّاه).
      let def = -1;
      for (const d of mask.slice(0, abs).matchAll(RE_LOCAL_TYPE)) def = d.index + d[0].length;
      take(abs, def < 0 ? '«type» shorthand — مالقيتش تعريف للمتغيّر' : readValue(src, def));
    }

    // (د) spread — ممكن يجيب type من أوبجكت تاني. مش بنحاول نحلّه، بس بنقوله.
    for (const sp of chunk.matchAll(RE_SPREAD))
      add(spreads, sp[1], `${rel}:${lineAt(s + sp.index)}`);

    // (هـ) مدى شكله صف لوج (فيه مفتاح tool) بس مفيهوش type بأي شكل =
    //      الاستخراج فشل، مش الكود. بنشرط وجود `tool` عشان منعدّش نداءات
    //      مش بتبني صف أصلاً (زي writeLogsBatch(db, rows) اللي الصف جوّه المتغيّر).
    // ⚠️ الـspread بيلغي الحكم: القيمة ممكن تكون جايّة منه، فالاستخراج
    //    مش فاشل — إحنا بس مش شايفينها من هنا. ده نمط الـwrapper الشائع:
    //    `async function safeLog(env, entry) { writeLog(db, { tool, ...entry }) }`
    //    والـtype بيتحط صريح في نداءات safeLog نفسها.
    //    سابقة: Bosta-Order-Lookup index.js:925.
    const hasSpread = RE_SPREAD.test(chunk); RE_SPREAD.lastIndex = 0;
    if (!found && !hasSpread && new RegExp(`${NB}tool\\s*[:,}]`).test(chunk))
      blindSpans.push(`${rel}:${lineAt(s)}`);
  }
}

// ── المقارنة ───────────────────────────────────────────────────────────────
const unregistered = [...used.keys()].filter((t) => !registered.has(t));
const orphans      = [...registered].filter((t) => !used.has(t));

// result/stage ممكن يكونوا: قيمة واحدة · null (الأداة لسه ماكتبتهاش) · أو مصفوفة
// لو الـ type بيوصف أكتر من نتيجة حسب الفرع (زي status_event).
const badVocab = [];
const checkVocab = (type, key, val, allowed) => {
  for (const v of (Array.isArray(val) ? val : [val])) {
    if (v === null || v === undefined) continue;
    if (!allowed.includes(v)) badVocab.push(`${type}: ${key}='${v}' — المسموح: ${allowed.join(' · ')}`);
  }
};
for (const [type, meta] of Object.entries(reg.types || {})) {
  checkVocab(type, 'result', meta?.result, RESULTS);
  checkVocab(type, 'stage',  meta?.stage,  STAGES);
}

// قيمة ديناميكية لازم تكون **معترَف بيها** في dynamicTypes — الاعتراف بيحوّلها
// من «حاجة التحقق مش شايفها» لـ«حاجة اتراجعت واتقرر إنها بتتحل وقت التشغيل».
// من غير الاعتراف ده، التحذير بيبقى ضوضاء بيتعوّد عليها الواحد ويعدّيها.
const acknowledged = new Set(reg.dynamicTypes || []);
const unackDynamic = [...dynamic.keys()].filter((expr) => !acknowledged.has(expr));

// الريبو بيكتب في logs بس مفيش ولا نداء اتعرف عليه = اسم دالة مش في الأنكورز.
// الريبو بيكتب في logs والاستخراج طلّع **صفر** قيمة = الاستخراج فشل، مهما
// كان السبب (اسم دالة غير معروف · نمط builder · أي شكل جديد). الكاشف ده
// مايعتمدش على أي اسم، وده بالظبط اللي بيمنع تكرار فوات أداة كاملة.
const orphanInsert = sawInsertIntoLogs && used.size === 0 && dynamic.size === 0;

const fail = unregistered.length > 0 || badVocab.length > 0
          || unackDynamic.length > 0 || blindSpans.length > 0 || orphanInsert;

// ── التقرير ────────────────────────────────────────────────────────────────
if (AS_JSON) {
  console.log(JSON.stringify({
    tool: TOOL, unregistered, orphans,
    dynamic: [...dynamic].map(([expr, ats]) => ({ expr, at: [...ats] })),
    otherTools: [...otherTools], noAnchorFiles, badVocab, ok: !fail,
  }, null, 2));
  process.exit(fail ? 1 : 0);
}

console.log(`\n■ ${TOOL}  —  ${registered.size} قيمة مسجّلة · ${used.size} مستخدمة في الكود\n`);

if (unregistered.length) {
  console.log('🔴 قيم مستخدمة ومش مسجّلة — سجّلها في log-values.json:');
  for (const t of unregistered) console.log(`   '${t}'  ←  ${[...used.get(t)].join(' · ')}`);
  console.log('');
}
if (badVocab.length) {
  console.log('🔴 مفردة غلط في السجل:');
  for (const b of badVocab) console.log(`   ${b}`);
  console.log('');
}
if (unackDynamic.length) {
  console.log('🔴 قيم ديناميكية مش معترَف بيها — راجع كل قيمة ممكنة تطلع منها،');
  console.log('   سجّلها في types، وضيف التعبير في dynamicTypes:');
  for (const expr of unackDynamic) console.log(`   ${[...dynamic.get(expr)].join(' · ')}  →  ${expr}`);
  console.log('');
}
if (orphanInsert) {
  console.log('🔴 الريبو بيكتب في جدول logs والاستخراج طلّع صفر قيمة.');
  console.log('   يعني اسم دالة الكتابة أو الباني مش في الأنكورز — زوّده في');
  console.log('   logAnchors جوّه log-values.json. الاسم ممكن يكون دالة كتابة');
  console.log('   (writeLogBatch) أو دالة بتبني الصفوف (buildPrintLogRows).');
  console.log('   سابقة: Order-SKU-Barcode-Printer — 739 صف في D1 فاتت الجرد.\n');
}
if (blindSpans.length) {
  console.log('🔴 نداء كتابة لوج مفيهوش أي مفتاح type — الاستخراج فشل، مش الكود:');
  console.log(`   ${blindSpans.join(' · ')}\n`);
}
const ackDynamic = [...dynamic.keys()].filter((e) => acknowledged.has(e));
if (ackDynamic.length) {
  console.log('⚠️  قيم ديناميكية معترَف بيها (الحارس وقت التشغيل هو اللي بيغطّيها):');
  for (const expr of ackDynamic) console.log(`   ${[...dynamic.get(expr)].join(' · ')}  →  ${expr}`);
  console.log('');
}
if (spreads.size) {
  console.log('ℹ️  spread جوّه نداء كتابة — ممكن يجيب type من أوبجكت تاني، راجعه:');
  for (const [name, ats] of spreads) console.log(`   ...${name}  ←  ${[...ats].join(' · ')}`);
  console.log('');
}
if (orphans.length) {
  console.log('ℹ️  مسجّلة ومش مستخدمة في الكود (يتيمة؟ أو بتتكتب من أداة تانية):');
  console.log(`   ${orphans.map((t) => `'${t}'`).join(' · ')}\n`);
}
if (otherTools.size) {
  console.log(`ℹ️  قيم tool تانية ظهرت في الكود: ${[...otherTools].map((t) => `'${t}'`).join(' · ')}\n`);
}
if (noAnchorFiles.length) {
  console.log(`ℹ️  ملفات فيها type: من غير أي نداء لوج معروف — زوّد الاسم في logAnchors لو لازم:\n   ${noAnchorFiles.join(' · ')}\n`);
}
console.log(fail ? '✗ فيه حاجة محتاجة تتصلّح\n' : '✓ تمام\n');
process.exit(fail ? 1 : 0);


