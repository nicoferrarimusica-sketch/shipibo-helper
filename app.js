// Shipibo Helper — offline dictionary + grammar search, personal notes, on-device AI.
const VERSION = '1.7.1';
const WEBLLM = './vendor/web-llm-0.2.85.js';
const MODELS = [
  { id: 'Llama-3.2-1B-Instruct', label: 'Lite — Llama 3.2 1B (~0.9 GB, most iPhones with 8 GB RAM)' },
  { id: 'Qwen2.5-1.5B-Instruct', label: 'Better — Qwen 2.5 1.5B (~1.6 GB, newest iPhones)' },
];
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// ---------------------------------------------------------------- text utils
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[’'`´]/g, '');
const STOP = new Set(('a an the of to in on at for from by with and or but is are was were be been it its this that these those ' +
  'what which who whom how do does did say said mean means meaning word words shipibo konibo shipibo-konibo english spanish ' +
  'you your i me my we us our can could would should please tell about there here as into than then so if not no yes ' +
  'translate translation called call use used using when where why ' +
  'maestro maestros maestra icaro icaros sing sings sang sung singing song songs phrase line verse ceremony').split(' '));
function stem(w) { // light English stemming so "commands"/"commanding" match "command"
  if (w.length <= 4) return w;
  if (w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.endsWith('ing') && w.length > 6) return w.slice(0, -3);
  if (w.endsWith('ed') && w.length > 5) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}
function tokens(s) { return (fold(s).match(/[a-zñ0-9]+/g) || []).map(stem); }
// everyday words -> the terms the grammar uses
const SYN = {
  command: ['imperative', 'directive', 'order'], order: ['imperative', 'directive'], question: ['interrogative', 'ask'],
  ask: ['interrogative', 'question'], past: ['tense'], future: ['tense', 'tomorrow'], tense: ['past', 'future'],
  plural: ['bo', 'many'], negative: ['negation', 'not'], not: ['negative', 'negation'], negation: ['negative'],
  why: ['reason', 'because'], because: ['reason'], want: ['desiderative', 'keen'], wish: ['desiderative'],
  pronoun: ['personal'], possessive: ['possessor', 'pos'], verb: ['verbal'], noun: ['nominal'],
  sound: ['phonology', 'pronounce', 'pronunciation'], pronounce: ['phonology', 'stress', 'sound'], spell: ['spelling', 'transcription'],
  evidential: ['evidentiality', 'hearsay', 'reportative'], hearsay: ['reportative', 'evidential'], song: ['sing', 'icaro'], sing: ['song'],
};
function qtokens(s) { const t = tokens(s); const k = t.filter((w) => !STOP.has(w)); return k.length ? k : t; }
function expand(ts) { const out = [...ts]; for (const t of ts) for (const x of SYN[t] || []) if (!out.includes(stem(x))) out.push(stem(x)); return out; }

function md(s) { // light markdown from the data files -> html
  let h = esc(s);
  h = h.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>');
  h = h.replace(/⟨/g, '<span class="ex">').replace(/⟩/g, '</span>');
  return h;
}
function highlight(html, terms) {
  if (!terms.length) return html;
  return html.replace(/(>|^)([^<]+)/g, (m, a, txt) => a + txt.replace(/[A-Za-zÀ-ÿñÑ]+/g, (w) =>
    terms.includes(fold(w)) ? `<mark>${w}</mark>` : w));
}

// ---------------------------------------------------------------- data + search index
const DB = { dict: [], index: [], grammar: [], notes: [], morph: [], att: { stems: {}, affix: {}, words: {} }, labels: {},
  dl: { ety: {}, derived: {}, partmean: {} }, examples: [] };
// grammar labels (CMPL, REM, ERG…) -> plain words ("completed action", "remote past", "doer marker")
function plainLabel(g) {
  const one = (p) => {
    if (DB.labels[p]) return DB.labels[p];
    if (DB.labels[p.toUpperCase()] && /^[0-9]/.test(p)) return DB.labels[p.toUpperCase()];       // 3sg, 1p
    if (/^[A-Z0-9>/]+$/.test(p)) return p.toLowerCase();
    return null;
  };
  return String(g || '').split(/\s*(?:[:+]|\s\/\s)\s*/).map((p) => p.trim()).filter(Boolean).map((p) => {
    const d = one(p); if (d) return d;
    if (/^[A-Z0-9>/.]+$/.test(p) && p.includes('.')) return p.split('.').map((x) => one(x) || x.toLowerCase()).join(' ');  // APPROX.LOC
    return p.replace(/\.(I|T)$/, '').replace(/[._]/g, ' ');
  }).join(' + ');
}
const glossJoin = (pieces) => pieces.map(([t]) => String(t).replace(/\s+/g, '.')).join('-');
// a whole gloss line like "do.I-REM-CMPL" -> "do - REMOTE PAST - COMPLETED ACTION"
function plainGlossLine(line) {
  return glossJoin(String(line).split(/-(?![^(]*\))/).map((p, i) => {
    const lab = p === p.toUpperCase() && /[A-Z0-9]/.test(p);
    return [plainLabel(p), !(lab || i > 0)];
  }));
}
let DOCS = []; // unified docs for retrieval
let INV = new Map(); let DF = new Map(); let AVGLEN = 1;

function docFromDict(e) { return { k: 'dict', id: 'd' + e.i, ref: e, head: e.h, text: e.h + ' ' + e.t.replace(/\*+/g, '') }; }
function docFromIndex(x, i) { return { k: 'index', id: 'x' + i, ref: x, head: x.e, text: x.e + ' ' + x.t }; }
function docFromGram(g) { return { k: 'gram', id: 'g' + g.i, ref: g, head: g.h, text: g.h + '\n' + g.t }; }
function pieceText(n) { return (n.pieces || []).map((w) => [w.word, w.meaning, ...(w.parts || []).map((p) => p.form + ' ' + p.meaning)].join(' ')).join(' '); }
function docFromNote(n) { return { k: 'note', id: 'n' + n.id, ref: n, head: n.ship, text: [n.ship, n.mean, n.ctx, (n.tags || []).join(' '), pieceText(n)].join(' ') }; }

function buildIndex() {
  DOCS = [...DB.dict.map(docFromDict), ...DB.index.map(docFromIndex), ...DB.grammar.map(docFromGram), ...DB.notes.map(docFromNote)];
  INV = new Map(); DF = new Map(); let tot = 0;
  DOCS.forEach((d, di) => {
    const tf = new Map(); const toks = tokens(d.text); d.len = toks.length || 1; tot += d.len;
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [t, c] of tf) { if (!INV.has(t)) INV.set(t, []); INV.get(t).push([di, c]); DF.set(t, (DF.get(t) || 0) + 1); }
    d.fh = fold(d.head);
  });
  AVGLEN = tot / DOCS.length;
  buildMorph();
}

const KW = { dict: 1.0, index: 0.9, gram: 0.8, note: 1.5 };
function search(q, { kinds = null, limit = 30 } = {}) {
  const base = qtokens(q); if (!base.length) return [];
  const qt = expand(base);
  const N = DOCS.length; const score = new Map();
  for (const t of qt) {
    const posting = INV.get(t); if (!posting) continue;
    const idf = Math.log(1 + (N - DF.get(t) + 0.5) / (DF.get(t) + 0.5));
    for (const [di, c] of posting) {
      const d = DOCS[di]; if (kinds && !kinds.includes(d.k)) continue;
      const s = idf * (c * 2.2) / (c + 1.2 * (0.25 + 0.75 * d.len / AVGLEN));
      score.set(di, (score.get(di) || 0) + s);
    }
  }
  // headword boosts: exact / prefix matches on Shipibo headwords and English index heads
  const fq = fold(q).trim();
  const suffixQ = /(^|\s)[-–]\s?[a-zñ]/.test(fq); // "-ra" = asking about an ending
  for (const t of base) {
    if (t.length < 2) continue;
    DOCS.forEach((d, di) => {
      if (kinds && !kinds.includes(d.k)) return;
      if (d.k === 'gram') return;
      const h = d.fh;
      let b = 0;
      if (suffixQ && d.k === 'dict' && /^[-–]/.test(h) && h.replace(/[^a-zñ]/g, '') === t) b = 16;
      else if (h === t || h === fq) b = 12;
      else if (h.replace(/[^a-zñ ]/g, '') === t) b = 10;
      else if (d.k === 'dict' && t.length >= 3 && h.startsWith(t)) b = 4;
      else if (d.k === 'note' && h.includes(t)) b = 5;
      if (b) score.set(di, (score.get(di) || 0) + b);
    });
  }
  return [...score.entries()].map(([di, s]) => ({ d: DOCS[di], s: s * KW[DOCS[di].k] }))
    .sort((a, b) => b.s - a.s).slice(0, limit);
}

// ---------------------------------------------------------------- word breakdown (morphology)
// Shipibo stacks endings onto a root (iki-bira, i-ni-ke). Split unknown words into a
// dictionary root + endings listed in the dictionary or named in the grammar.
let STEMS = new Map(); let AFFIX = new Map(); let TAUGHT_WORDS = new Map();
function addTo(m, k, v) { if (!k) return; if (!m.has(k)) m.set(k, []); if (!m.get(k).includes(v)) m.get(k).push(v); }
function buildMorph() {
  STEMS = new Map(); AFFIX = new Map();
  for (const e of DB.dict) {
    const raw = fold(e.h).replace(/[*]/g, '').trim();
    if (/\s/.test(raw)) continue;
    if (/^[-–]/.test(raw)) { addTo(AFFIX, raw.replace(/^[-–]+/, ''), { k: 'dict', e }); continue; }
    if (/[-–]$/.test(raw)) continue;                       // prefixes (bo-, ke-) are not roots
    if (/name of the letter/.test(e.t)) continue;          // "ba", "ke": names of letters, not roots
    const w = raw.replace(/[^a-zñ]/g, '');
    if (w.length >= 2) addTo(STEMS, w, { k: 'dict', e });
    if (/^\*?v\./.test(e.t) && w.endsWith('ti') && w.length >= 3) addTo(STEMS, w.slice(0, -2), { k: 'dict', e, verb: true });
  }
  for (const m of DB.morph) for (const k of m.keys) {
    if (m.side === 'suffix') addTo(AFFIX, k, { k: 'morph', m });
    else if (m.side === 'word' && k.length >= 2) addTo(STEMS, k, { k: 'morph', m, verb: /verb|auxiliar/.test(m.category + m.attaches) });
  }
  for (const [f, gl] of Object.entries(DB.att.stems || {})) {
    const [top, n] = Object.entries(gl).sort((a, b) => b[1] - a[1])[0];
    addTo(STEMS, f, { k: 'att', form: f, meaning: top, n });
  }
  for (const [f, gl] of Object.entries(DB.att.affix || {})) {
    const n = Object.values(gl).reduce((a, b) => a + b, 0);
    addTo(AFFIX, f, { k: 'att', form: f, gl, n });
  }
  for (const [f, list] of Object.entries(DB.dl.derived || {})) for (const d of list) addTo(STEMS, f, { k: 'derived', form: f, ...d });
  for (const [f, gl] of Object.entries(DB.dl.partmean || {})) {
    const g = Object.entries(gl).sort((a, b) => b[1] - a[1])[0][0];
    if (STEMS.has(f) || AFFIX.has(f)) continue;               // only fill gaps; don't override better sources
    addTo(STEMS, f, { k: 'etyp', form: f, meaning: g.replace(/^(suf\.|pref\.)\s*(of\s*)?/, ''), n: 1 });
  }
  // words you described in your own dictionary entries
  for (const n of DB.notes) if (n.entry && n.entry.root) {
    const e = n.entry; const f = fold(e.root).replace(/[^a-zñ]/g, '');
    if (e.type === 'ending') addTo(AFFIX, f, { k: 'taught', form: e.root, meaning: e.meaning, n });
    else addTo(STEMS, f, { k: 'taught', form: e.root, meaning: e.meaning, n, verb: e.type === 'verb', whole: false, entry: e });
  }
  PREFIX = new Map();
  for (const m of DB.morph) if (m.side === 'prefix') for (const k of m.keys) addTo(PREFIX, k, { k: 'morph', m });
  for (const e of DB.dict) { const raw = fold(e.h).replace(/[*]/g, '').trim(); if (/^[a-zñ]{1,3}[-–]$/.test(raw)) addTo(PREFIX, raw.replace(/[-–]$/, ''), { k: 'dict', e }); }
  const ati = DB.dict.find((e) => fold(e.h) === 'ati' && /^\*?v\./.test(e.t));
  if (ati) { addTo(STEMS, 'a', { k: 'dict', e: ati, verb: true }); addTo(STEMS, 'ak', { k: 'dict', e: ati, verb: true }); }
  const iti = DB.dict.find((e) => fold(e.h) === 'iti' && /^\*?v\./.test(e.t));
  if (iti) for (const f of ['iki', 'riki', 'ika', 'ike']) addTo(STEMS, f, { k: 'dict', e: iti, verb: true });
  for (const g of DB.grammar) for (const m of g.h.matchAll(/[-–]\(?([A-Za-zñÑ]+)\)?(?:\(([a-z]+)\))?/g)) {
    const f = fold(m[1]); if (f.length >= 2) addTo(AFFIX, f, { k: 'gram', g });
  }
  TAUGHT_WORDS = new Map();
  const byTime = [...DB.notes].sort((a, b) => (a.updated || a.created || 0) - (b.updated || b.created || 0));
  for (const n of byTime) {
    for (const w of n.pieces || []) if ((w.parts || []).length && w.parts.some((p) => p.meaning)) TAUGHT_WORDS.set(fold(w.word).replace(/[^a-zñ]/g, ''), { ...w, note: n });
    for (const w of tokens(n.ship)) addTo(STEMS, w, { k: 'note', n });
    for (const w of n.pieces || []) {
      const fw = fold(w.word).replace(/[^a-zñ]/g, '');
      if (fw && w.meaning) addTo(STEMS, fw, { k: 'taught', form: w.word, meaning: w.meaning, n, whole: true });
      (w.parts || []).forEach((pt, i) => {
        const f = fold(pt.form).replace(/[^a-zñ]/g, ''); if (!f || !pt.meaning) return;
        const isRoot = pt.kind ? pt.kind === 'root' : i === 0; const ff = (x) => fold(x).replace(/[^a-zñ]/g, '');
        // where it was taught: a corrected ending ("picked") is used again in the same surroundings
        addTo(isRoot ? STEMS : AFFIX, f, { k: 'taught', form: pt.form, meaning: pt.meaning, n, verb: !!pt.verb,
          word: ff(w.word), prev: i ? ff(w.parts[i - 1].form) : '', root: ff(w.parts[0].form), ctxOnly: !!pt.picked && !isRoot });
      });
    }
  }
}
// tunable weights (fitted on the grammar's own segmented examples, see app/tests)
const W = { end: 1, one: 0.15, shortRoot: 0, exact: 0.3, vend: 0.5, nend: 0.3, pre: 0.8, lex: 0.4, noRoot: 1, attEnd: 0.25, attRoot: 0.35, unattEnd: 0.8, seen: 3, taughtEnd: 1.2, taughtRoot: 2.5, unknownRoot: 2.2, preNonVerb: 1.5 };
const attN = (L) => { const a = (L || []).find((x) => x.k === 'att'); return a ? a.n : 0; };
let PREFIX = new Map();
// Every plausible split of a word, cheapest first. Roots come from the dictionary, the grammar's
// examples, the grammar's word list and your teaching; a root the app doesn't know is still offered
// ("unknown root") when the rest of the word splits into known endings.
function analyzeAll(word, limit = 10) {
  const w = fold(word).replace(/[^a-zñ]/g, ''); if (w.length < 2) return [];
  const memo = new Map();
  const endCost = (head) => { const L = AFFIX.get(head); const taught = L.some((x) => x.k === 'taught'); const an = attN(L);
    return W.end + (head.length === 1 ? W.one : 0) - (taught ? W.taughtEnd : 0) - W.attEnd * Math.log1p(an) / 3 + (an ? 0 : W.unattEnd); };
  function sufsAll(rest) {                   // all ways to split a string fully into endings (cheapest 12)
    if (rest === '') return [{ pieces: [], cost: 0 }];
    if (memo.has(rest)) return memo.get(rest);
    const res = [];
    for (let i = Math.min(rest.length, 8); i >= 1; i--) {
      const head = rest.slice(0, i); if (!AFFIX.has(head)) continue;
      const c = endCost(head);
      for (const t of sufsAll(rest.slice(i))) res.push({ pieces: [head, ...t.pieces], cost: t.cost + c });
    }
    res.sort((a, b) => a.cost - b.cost); const top = res.slice(0, 12); memo.set(rest, top); return top;
  }
  const onlyVerb = (p) => { const L = AFFIX.get(p) || []; const D = L.filter((x) => x.k === 'dict');
    if (D.length) return D.every((x) => /verbal suf/.test(x.e.t));
    const M = L.filter((x) => x.k === 'morph'); return M.length > 0 && M.every((x) => /^verb/.test(x.m.attaches)); };
  const onlyNoun = (p) => { const L = (AFFIX.get(p) || []).filter((x) => x.k === 'morph'); return L.length > 0 && L.every((x) => /^noun/.test(x.m.attaches)); };
  const cands = [];
  function rootCands(str, pre) {
    const preCost = pre ? W.pre : 0;
    if (STEMS.has(str)) {
      const st = STEMS.get(str);
      const taughtWhole = st.some((x) => x.k === 'taught' && x.whole);
      cands.push({ pre, root: str, endings: [], cost: preCost + (taughtWhole ? -2 : W.exact) + (pre && !st.some((x) => x.verb) ? W.preNonVerb : 0) });
    }
    for (let i = str.length - 1; i >= 1; i--) {
      const root = str.slice(0, i); const st = STEMS.get(root);
      const rests = sufsAll(str.slice(i)); if (!rests.length) continue;
      if (!st) {                                                   // a root the app doesn't know yet
        if (i >= 2 && !pre) for (const r of rests.slice(0, 3)) cands.push({ root, endings: r.pieces, cost: r.cost + W.unknownRoot + (i <= 2 ? 0.6 : 0), unknown: true });
        continue;
      }
      if (i === 1 && !st.some((x) => x.verb)) continue;           // 1-letter roots only for verbs (a- 'do', i- 'be')
      const isVerb = st.some((x) => x.verb);
      const taughtRoot = st.some((x) => x.k === 'taught');
      const isNounOnly = st.every((x) => x.k === 'dict' && /^\*?n\./.test(x.e.t));
      const lexical = st.some((x) => x.k === 'dict' && !x.verb);
      const rootCost = (i <= 2 ? W.shortRoot : 0) - W.attRoot * Math.log1p(attN(st)) / 2 - (taughtRoot ? W.taughtRoot : 0)
        + (pre && !isVerb ? W.preNonVerb : 0);            // body-part prefixes go on verbs (grammar §6.2.6 / 8.2.6)
      for (const r of rests.slice(0, 6)) {
        const verbEnd = r.pieces.some(onlyVerb); const nounEnd = r.pieces.some(onlyNoun);
        cands.push({ pre, root, endings: r.pieces, cost: preCost + r.cost + rootCost
          + (verbEnd && !isVerb && !taughtRoot ? W.vend : 0) + (nounEnd && isVerb && !isNounOnly ? W.nend : 0)
          + (lexical && !isVerb && r.pieces.length === 0 ? W.lex : 0) });
      }
    }
  }
  const tw = TAUGHT_WORDS.get(w);
  if (tw) cands.push({ root: tw.parts[0].form && fold(tw.parts[0].form).replace(/[^a-zñ]/g, ''), endings: tw.parts.slice(1).map((p) => fold(p.form).replace(/[^a-zñ]/g, '')), cost: -W.seen - 2, taughtSplit: tw });
  const ety = (DB.dl.ety || {})[w];
  if (ety && ety.split) { const ps = ety.split.split('-');
    cands.push({ root: ps[0], endings: ps.slice(1), cost: -W.seen + 0.5, etyRec: ety }); }
  const seenW = (DB.att.words || {})[w];
  if (seenW) { const ps = seenW.split.split('-');
    cands.push({ root: ps[0], endings: ps.slice(1), cost: -W.seen, author: seenW }); }
  rootCands(w, null);
  for (let i = 1; i <= 3 && i < w.length - 1; i++) { const p = w.slice(0, i); if (PREFIX.has(p)) rootCands(w.slice(i), p); }
  for (const only of sufsAll(w).slice(0, 2)) if (only.pieces.length > 1) cands.push({ root: null, endings: only.pieces, cost: only.cost + W.noRoot });
  if (!cands.length) cands.push({ root: w, endings: [], cost: 9, unknown: true });
  cands.sort((a, b) => a.cost - b.cost || (b.root || '').length - (a.root || '').length);
  const seen = new Set(); const out = [];
  for (const c of cands) {
    const r = c.pre ? { root: c.pre + '-' + c.root, prefix: c.pre, stem: c.root, endings: c.endings, cost: c.cost } : { ...c };
    const key = (r.prefix ? r.prefix + '+' : '') + (r.root || '') + '|' + r.endings.join('-');
    if (seen.has(key)) { const prev = out.find((x) => (x.prefix ? x.prefix + '+' : '') + (x.root || '') + '|' + x.endings.join('-') === key); if (prev && c.author) prev.author = c.author; if (prev && c.taughtSplit) prev.taughtSplit = c.taughtSplit; if (prev && c.etyRec) prev.etyRec = c.etyRec; continue; }
    seen.add(key); r.word = w; out.push(r);
    if (out.length === limit) break;
  }
  return out;
}
function analyze(word) { return analyzeAll(word, 2); }
function partsOf(a) { // [[form, isRoot]] ; isRoot === 'pre' for a prefix
  if (a.prefix) return [[a.prefix, 'pre'], [a.stem, true], ...a.endings.map((e) => [e, false])];
  return [...(a.root ? [[a.root, true]] : []), ...a.endings.map((e) => [e, false])];
}
function rootKind(root) { // 'verb' | 'noun' | '' — used to choose the fitting reading of each ending
  const L = STEMS.get(root) || [];
  if (L.some((x) => x.k === 'taught' && x.verb) || L.some((x) => x.verb)) return 'verb';
  if (L.some((x) => (x.k === 'dict' && /^\*?(n|adj|pron)\./.test(x.e.t)) || (x.k === 'morph' && /noun|pronoun/.test(x.m.attaches + x.m.category)))) return 'noun';
  return '';
}
function pieceInfo(form, isRoot, ctx = '') {
  const seen = new Set();
  const list = ((isRoot === 'pre' ? PREFIX : isRoot ? STEMS : AFFIX).get(form) || []).filter((x) => { const key = x.k + (x.k === 'derived' ? 'd' + x.from + x.form : x.k === 'etyp' ? 'p' + x.form : x.k === 'att' ? 'a' + x.form : x.e ? 'e' + x.e.i : x.g ? 'g' + x.g.i : x.m ? 'm' + x.m.display + x.m.gloss : x.k === 'taught' ? 't' + fold(x.form) + '|' + x.meaning : 'n' + x.n.id);
    if (seen.has(key)) return false; seen.add(key); return true; });
  const fits = (x) => x.k === 'morph' && ctx && (ctx === 'verb' ? /^verb/.test(x.m.attaches) : /^noun/.test(x.m.attaches)) ? 1.5 : 0;
  const rank = (x) => (x.k === 'taught' ? 5 : x.k === 'derived' ? 0.95 : x.k === 'etyp' ? 0.8 : x.k === 'morph' ? (x.m.gloss ? 3 : 2) : x.k === 'dict' ? 1 : x.k === 'att' ? (isRoot ? (x.n >= 3 && !/^[A-Z]/.test(x.meaning) ? 4.8 : /^[A-Z]/.test(x.meaning) ? -0.5 : 0.5) : -1) : 0) + fits(x);   // a root glossed 3+ times in the examples beats a look-alike dictionary word
  list.sort((a, b) => rank(b) - rank(a) || ((b.n && b.n.updated) || 0) - ((a.n && a.n.updated) || 0));
  return list.slice(0, 3).map((x) => x.k === 'derived' ? { label: `${x.from} without ${x.drop} (${x.dropg})`, text: ' : ' + x.mean, ref: x, derived: x }
    : x.k === 'etyp' ? { label: x.form + ' (from the dictionary\'s word histories)', text: ' : ' + x.meaning, ref: x, etyp: x }
    : x.k === 'att' ? (x.gl ? { label: '-' + x.form + ' in the grammar examples', text: ' : ' + Object.entries(x.gl).map(([g, n]) => `${plainLabel(g)} (${n}×)`).join(', '), ref: x, att: x }
      : { label: x.form + ' in the grammar examples', text: ' : ' + plainLabel(x.meaning), ref: x, att: x }) : x.k === 'taught' ? { label: x.form + ' (taught by you)', text: ' : ' + x.meaning, ref: x, taught: true } : x.k === 'dict' ? { label: x.e.h, text: x.e.t, ref: x } :
    x.k === 'gram' ? { label: '§' + x.g.s + ' ' + x.g.h, text: '', ref: x } :
    x.k === 'morph' ? { label: `${x.m.gloss ? plainLabel(x.m.gloss) : x.m.display}${x.m.sections[0] ? ' (grammar §' + x.m.sections[0] + ')' : ''}`, text: ' : ' + x.m.meaning, ref: x, morph: x.m } : { label: x.n.ship, text: x.n.mean, ref: x });
}
function shortGloss(t) { // first definition(s) from an entry: the " : "-separated senses, without notes
  let x = String(t || '').replace(/⟨[^⟩]*⟩/g, '').replace(/\*+/g, '').replace(/\[[^\]]*\]/g, '');
  x = x.split(/\s(?:syn\.|See |cf\.|–Used|—Used|-Used)/)[0];
  const p = x.split(' : ').map((y) => y.replace(/^\s*\d+\s*/, '').trim()).filter(Boolean);
  const senses = p.length > 1 ? p.slice(1, 4) : p;
  return senses.join('; ').replace(/\s\d+$/, '').replace(/\s+/g, ' ').trim().slice(0, 110);
}
function breakdownFor(q) {
  const words = (q.match(/[A-Za-zÀ-ÿñÑ'’-]+/g) || []).filter((w) => w.length >= 3 && !STOP.has(fold(w)));
  const out = []; const done = new Set(); const order = [];
  for (const w of words) {
    const fw = fold(w).replace(/[^a-zñ]/g, '');
    if (done.has(fw)) { if (out.some((x) => fold(x.word).replace(/[^a-zñ]/g, '') === fw)) order.push(w); continue; } done.add(fw);
    if (DB.index.some((x) => fold(x.e) === fw)) continue;     // looks English
    if (/^[-–]/.test(w)) continue;                             // asking about an ending itself
    const stw = stem(fw); if (DB.index.some((x) => stem(fold(x.e)) === stw)) continue;   // English word
    const an = analyzeAll(w, 10); if (!an.length) continue;
    order.push(w);
    out.push({ word: w, analyses: an });
  }
  // only worth showing when some word really splits into root + endings
  out.order = order;
  return out.some((x) => x.analyses.some((a) => a.endings.length || !a.unknown)) ? out : [];
}
// What you taught for a piece. Roots: the newest teaching. Endings you corrected in the word breakdown
// count where they were taught (same word, then same ending before it, then same root); endings you
// confirmed or defined in your dictionary count everywhere.
const newestFirst = (a, b) => ((b.n && b.n.updated) || 0) - ((a.n && a.n.updated) || 0);
function taughtMeaning(f, isRoot, c = {}) {
  const L = ((isRoot === 'pre' ? PREFIX : isRoot ? STEMS : AFFIX).get(f) || []).filter((x) => x.k === 'taught' && x.meaning).sort(newestFirst);
  if (!L.length) return null;
  if (isRoot) return L[0].meaning;
  const hit = (c.word && L.find((x) => x.word === c.word)) || (c.prev != null && L.find((x) => x.ctxOnly && x.prev === c.prev && x.root === c.root))
    || (c.prev && L.find((x) => x.ctxOnly && x.prev === c.prev)) || L.find((x) => !x.ctxOnly) || (c.root && L.find((x) => x.ctxOnly && x.root === c.root));
  return hit ? hit.meaning : null;
}
function glossOf(f, isRoot, ctx = '', c = {}) {
  const tm = taughtMeaning(f, isRoot, c);
  if (tm) return isRoot ? tm.replace(/^to\s+/i, '') : tm;   // what the user taught wins
  if (!isRoot) { // most frequent reading in the grammar's examples, unless context picks a grammar reading
    const a = (AFFIX.get(f) || []).find((x) => x.k === 'att');
    if (a) { const L = Object.entries(a.gl).sort((x, y) => y[1] - x[1]);
      const fit = ctx && (pieceInfo(f, false, ctx).find((x) => x.morph && x.morph.gloss && a.gl[x.morph.gloss]));
      return plainLabel(fit ? fit.morph.gloss : L[0][0]); }
  }
  const inf = pieceInfo(f, isRoot, ctx)[0]; if (!inf) return '?';
  if (inf.att && isRoot) return plainLabel(inf.att.meaning);
  if (inf.derived) return inf.derived.mean.split(/[(;,]/)[0].trim().slice(0, 40);
  if (inf.etyp) return inf.etyp.meaning.split(/[(;,]/)[0].trim().slice(0, 30);
  if (inf.taught) return inf.text.replace(/^ : /, '').split(/[;,]/)[0].trim();
  if (inf.morph && inf.morph.gloss) return plainLabel(inf.morph.gloss);
  if (inf.morph) return inf.morph.meaning.split(/[\/;,(]/)[0].trim().slice(0, 30);
  const g = shortGloss(inf.text).split(/[;,]/)[0].replace(/^to /, '').replace(/\s+\d+$/, '').trim();
  return (g || inf.label).slice(0, 30);
}
function shortPart(p) { // a part of a word history -> a short gloss ("suf. of completed action" -> CMPL when known)
  const f = fold(p.f).replace(/[^a-zñ]/g, '');
  if (p.f.trim().startsWith('-')) { const L = AFFIX.get(f); if (L && L.some((x) => x.k === 'att' || x.k === 'morph')) return labelOf(f, false); }
  return (p.g || f).replace(/^(suf\.|pref\.|modifying|verbal|noun)\s*(suf\.\s*)?(of\s*)?/i, '').split(/[,;]/)[0].trim().replace(/\s+/g, '.') || f;
}
function labelOf(f, isRoot, ctx = '', c = {}) {
  if (isRoot) return glossOf(f, isRoot, ctx, c);
  const tm = taughtMeaning(f, false, c); if (tm) return tm;
  const a = (AFFIX.get(f) || []).find((x) => x.k === 'att');
  if (a) { const L = Object.entries(a.gl).sort((x, y) => y[1] - x[1]);
    const fit = ctx && pieceInfo(f, false, ctx).find((x) => x.morph && x.morph.gloss && a.gl[x.morph.gloss]);
    return (fit ? fit.morph.gloss : L[0][0]).replace(/\*/g, ''); }
  const inf = pieceInfo(f, false, ctx)[0];
  if (inf && inf.morph && inf.morph.gloss) return inf.morph.gloss;
  return glossOf(f, false, ctx, c);
}
function readingOf(a) { // plain words: "well (I know it for sure)"
  const il = interlinear(a);
  return il.bottom.split(/-(?![^(]*\))/).map((g, i) => { const isLab = g === g.toUpperCase() && /[A-Z0-9]/.test(g);
    const t = isLab ? plainLabel(g) : g.replace(/\./g, ' ');
    return i === 0 && !isLab ? t : `(${t})`; }).join(' ');
}
function interlinear(a) {   // a.over = {piece index: meaning} picked by the user in the breakdown
  const il = interlinear0(a); if (!a.over) return il;
  const tops = il.top.split('-'); const bots = il.bottom.split(/-(?![^(]*\))/);
  if (tops.length !== bots.length) return il;
  for (const [i, v] of Object.entries(a.over)) if (v && bots[i] != null) bots[i] = String(v).trim().replace(/\s+/g, '.');
  return { ...il, bottom: bots.join('-') };
}
function interlinear0(a) {
  const parts = partsOf(a);
  if (a.taughtSplit) return { top: a.taughtSplit.parts.map((p) => p.form).join('-'),
    bottom: glossJoin(a.taughtSplit.parts.map((p, i) => [p.meaning || '?', i === 0])), note: 'as you taught it' + (a.taughtSplit.meaning ? ` — “${a.taughtSplit.meaning}”` : '') };
  if (a.etyRec && !a.author) return { top: a.etyRec.split, bottom: a.etyRec.parts.map((p) => shortPart(p)).join('-'),
    note: `the dictionary's word history of ${a.etyRec.h}: “${a.etyRec.mean}”` };
  if (a.author) return { top: a.author.split, bottom: a.author.gloss, note: 'as analysed in the grammar, p. ' + a.author.page };
  const ctx = a.root ? rootKind(a.stem || a.root) : '';
  const root = a.stem || a.root || '';
  return { top: parts.map(([f]) => f).join('-'), bottom: glossJoin(parts.map(([f, r], i) => [r === true && a.unknown ? (taughtMeaning(f, true) || '?')
    : labelOf(f, r, ctx, { word: a.word, prev: i ? parts[i - 1][0] : '', root }), r === true])) };
}
function relatedWords(root) {
  if (!root) return [];
  const r = fold(root).replace(/[^a-zñ]/g, ''); const out = [];
  for (const e of DB.dict) { if (/name of the letter/.test(e.t)) continue; const h = fold(e.h).replace(/[^a-zñ]/g, '');
    if (h === r || h === r + 'ti' || h === r + 'n' || h === r + 'a' || (h.startsWith(r) && h.length <= r.length + 3)) out.push(e);
    if (out.length >= 4) break; }
  return out.map((e) => `${e.h} (${shortGloss(e.t).split(';')[0] || '…'})`);
}
function relatedLine(a) {
  const root = partsOf(a).find(([, r]) => r === true); if (!root || a.taughtSplit) return '';
  const rel = relatedWords(root[0]); return rel.length ? 'related dictionary words: ' + rel.join(', ') : '';
}
function guessReason(a) { // a few plain words on where this analysis comes from
  if (a.taughtSplit) return 'as you taught it';
  if (a.author) return `the grammar's own analysis (p. ${a.author.page})`;
  if (a.etyRec) return `the dictionary's word history of ${a.etyRec.h}`;
  { const d = (STEMS.get(partsOf(a).find(([, r]) => r === true)?.[0]) || []).find((x) => x.k === 'derived');
    if (d) return `root “${d.form}” = ${d.from} “${d.mean}” without ${d.drop} (${d.dropg})`; }
  const parts = partsOf(a); const root = parts.find(([, r]) => r === true);
  const src = (L) => { const k = new Set(L.map((x) => x.k)); return k.has('taught') ? 'your notes' : k.has('dict') ? 'the dictionary' : k.has('att') ? 'the grammar examples' : k.has('morph') ? 'the grammar' : k.has('note') ? 'your notes' : 'a guess'; };
  if (!root) return 'endings only — no root found';
  if (a.unknown) return `root “${root[0]}” is not in the dictionary`;
  const rs = src(STEMS.get(root[0]) || []);
  if (parts.length === 1) return `a whole word from ${rs}`;
  const ends = parts.filter(([, r]) => r === false).map(([f]) => AFFIX.get(f) || []);
  const es = ends.some((L) => L.some((x) => x.k === 'taught')) ? 'your notes' : 'the grammar';
  return `guess: root from ${rs}, endings from ${es}`;
}
let CHOICES = { words: [], order: [] };   // the analyses shown, so the user's pick can be saved
// every meaning a piece could have here, best first (the current guess, your teaching, the grammar, the dictionary)
function pieceChoices(f, r, ctxK, cur) {
  const out = []; const add = (v, why) => { v = String(v || '').replace(/\*/g, '').trim(); if (!v || v === '?' || out.some((o) => o.v === v)) return; out.push({ v, why }); };
  add(cur, 'current guess');
  const L = (r === 'pre' ? PREFIX : r ? STEMS : AFFIX).get(f) || [];
  for (const x of L.filter((y) => y.k === 'taught').sort(newestFirst)) add(r === true ? x.meaning.replace(/^to\s+/i, '') : x.meaning, 'taught by you');
  if (r === false) {
    const a = L.find((x) => x.k === 'att');
    if (a) for (const [g, n] of Object.entries(a.gl).sort((x, y) => y[1] - x[1])) if (/[A-Za-z]/.test(g)) add(g.replace(/[\]\[]/g, ''), `${n}× in the grammar examples`);
    for (const x of L.filter((y) => y.k === 'morph')) add(x.m.gloss || x.m.meaning.split(/[\/;,(]/)[0].slice(0, 40), x.m.meaning.slice(0, 60));
    for (const x of L.filter((y) => y.k === 'dict')) for (const g of shortGloss(x.e.t).split(';').slice(0, 2)) if (!/\bsuf\.|^-/.test(g)) add(g, 'dictionary');
  } else {
    for (const inf of pieceInfo(f, r, ctxK)) {
      const t = inf.derived ? inf.derived.mean.split(/[(;]/)[0] : inf.etyp ? inf.etyp.meaning : inf.att ? plainLabel(inf.att.meaning)
        : inf.morph ? (inf.morph.gloss ? plainLabel(inf.morph.gloss) : inf.morph.meaning.split(/[\/;,(]/)[0]) : inf.taught ? '' : shortGloss(inf.text);
      for (const g of String(t).split(';').slice(0, 3)) add(g.replace(/^to\s+/i, '').slice(0, 50), inf.label);
    }
  }
  return out;
}
function pieceEditorHtml(a, wi, k) {
  const parts = partsOf(a); const bots = interlinear(a).bottom.split(/-(?![^(]*\))/);
  const ctxK = a.root ? rootKind(a.stem || a.root) : '';
  const isLab = (v) => v === v.toUpperCase() && /[A-Z]/.test(v);
  const optText = (o) => (isLab(o.v) ? `${o.v} — ${plainLabel(o.v)}` : o.v) + (o.why && o.why !== 'current guess' ? `  (${o.why})` : '');
  return `<div class="pieceEd" data-wi="${wi}" data-k="${k}"><div class="tiny" style="margin:6px 0 2px">Check each piece — change any meaning that's wrong:</div>` +
    parts.map(([f, r], i) => {
      const cur = (bots[i] || '').replace(/\./g, ' ');
      const ch = pieceChoices(f, r, ctxK, cur === '?' ? '' : cur);
      const others = r === false ? Object.keys(DB.labels).filter((g) => !ch.some((o) => o.v === g)).sort((x, y) => /^\d/.test(x) - /^\d/.test(y) || x.localeCompare(y)) : [];
      return `<div class="prow"><span class="pf">${r === 'pre' ? esc(f) + '-' : r ? esc(f) : '-' + esc(f)}</span>
        <select class="pc" data-pi="${i}">${cur === '?' ? '<option value="">? (unknown — pick or type)</option>' : ''}${ch.map((o) => `<option value="${esc(o.v)}">${esc(optText(o))}</option>`).join('')}
        ${others.length ? `<optgroup label="Other ending meanings">${others.map((g) => `<option value="${esc(g)}">${esc(g)} — ${esc(DB.labels[g])}</option>`).join('')}</optgroup>` : ''}
        <option value="__own">✎ Type my own meaning…</option></select>
        <input class="pc-own" data-pi="${i}" hidden placeholder="meaning of ${r === true ? '“' + esc(f) + '”' : '-' + esc(f)} here"></div>`;
    }).join('') + '</div>';
}
function bdOptionRefresh(wi, k) {
  const a = CHOICES.words[wi].analyses[k]; const el = document.querySelector(`.opt[data-wi="${wi}"][data-k="${k}"]`); if (!el) return;
  el.querySelector('.ilb').textContent = interlinear(a).bottom; el.querySelector('.ird').textContent = '≈ ' + readingOf(a);
  bdPhraseUpdate();
}
function bdPieceChange(t) {
  const ed = t.closest('.pieceEd'); const wi = +ed.dataset.wi; const k = +ed.dataset.k; const pi = +t.dataset.pi;
  const a = CHOICES.words[wi].analyses[k]; a.over = a.over || {};
  if (t.matches('select.pc')) {
    const own = ed.querySelector(`.pc-own[data-pi="${pi}"]`); own.hidden = t.value !== '__own';
    if (t.value === '__own') { own.focus(); return; }
    if (t.selectedIndex === 0 && !a.over[pi]) return;
    a.over[pi] = t.value;
  } else a.over[pi] = t.value.trim();
  if (!a.over[pi]) delete a.over[pi];
  const r = document.querySelector(`input[name="bdw${wi}"][value="${k}"]`); if (r) r.checked = true;
  bdOptionRefresh(wi, k);
}
function breakdownHtml(bd) {
  if (!bd.length) return '';
  CHOICES = { words: bd.map((x) => ({ word: x.word, analyses: x.analyses })), order: bd.order && bd.order.length ? bd.order : bd.map((x) => x.word) };
  const blocks = bd.map(({ word, analyses }, wi) => {
    const opts = analyses.map((a, k) => {
      const il = interlinear(a); const parts = partsOf(a);
      return `<label class="opt" data-wi="${wi}" data-k="${k}"><input type="radio" name="bdw${wi}" value="${k}">
        <span><b class="hw" style="font-size:15px">${esc(il.top)}</b> <span class="lab ilb">${esc(il.bottom)}</span>
        <span class="tiny ird" style="display:block">≈ ${esc(readingOf(a))}</span>
        <span class="tiny" style="display:block;color:var(--muted)">${esc(guessReason(a))}</span>
        ${relatedLine(a) ? `<span class="tiny" style="display:block;color:var(--muted)">${esc(relatedLine(a))}</span>` : ''}
        ${a.root ? `<button class="btn ghost small explainBtn" data-root="${esc(a.stem || a.root)}" data-wi="${wi}" data-k="${k}" style="margin-top:4px">＋ Explain “${esc(a.stem || a.root)}” in my dictionary</button>` : ''}
        ${pieceEditorHtml(a, wi, k)}</span></label>`;
    }).join('');
    return `<div class="wb" data-wi="${wi}"><div class="src" style="margin-top:10px">${esc(word)} — ${analyses.length} possible split${analyses.length === 1 ? '' : 's'}</div>${opts}
      <label class="opt"><input type="radio" name="bdw${wi}" value="none"><span class="tiny">None of these — I'll type the right one</span></label></div>`;
  }).join('');
  // details for the best guess of every piece (folded)
  const rows = bd.map(({ word, analyses }) => { const a = analyses[0]; const parts = partsOf(a);
    const ctxK = a.root ? rootKind(a.stem || a.root) : '';
    return `<div style="margin-top:8px"><span class="hw">${esc(word)}</span> ` + parts.map(([f, r]) => { const infos = pieceInfo(f, r, ctxK);
      const txt = infos.map((info) => info.taught ? `<span class="taught">taught</span> ${esc(info.text.replace(/^ : /, ''))}` : `${esc(info.label)}${info.text ? ': ' + esc(shortGloss(info.text)) : ''}`).join(' <span class="tiny">/</span> ');
      return `<div class="tiny" style="margin-left:10px">• <b>${r === 'pre' ? esc(f) + '-' : r ? esc(f) : '-' + esc(f)}</b>${txt ? ' — ' + txt : ' — not found'}</div>`; }).join('') + '</div>'; }).join('');
  return `<div class="card" id="bdCard"><div class="src">Word breakdown</div>
    <div id="bdPhrase"></div>
    <div class="tiny" style="margin:6px 0 2px">Tap the right split for each word. Under it, fix the meaning of any piece (e.g. make -ax mean “in / at” instead of “after”). Then save — it learns from your choices.</div>
    ${blocks}
    <button class="btn small" id="bdSave" style="margin-top:10px">✓ Save my choices (it learns from them)</button>
    <details style="margin-top:8px"><summary>Details for every piece of the best guess</summary>${rows}</details></div>`;
}
function bdPhraseUpdate() {
  if (!$('#bdPhrase') || !CHOICES.order || !CHOICES.words.length) return;
  const pick = (wi) => { const el = document.querySelector(`input[name="bdw${wi}"]:checked`); const k = el && el.value !== 'none' ? +el.value : 0; return CHOICES.words[wi].analyses[k]; };
  const byWord = (w) => CHOICES.words.findIndex((x) => fold(x.word) === fold(w));
  const items = CHOICES.order.map((w) => { const wi = Math.max(0, byWord(w)); return { w, a: pick(wi) }; });
  const el = $('#bdPhrase'); if (!el) return;
  el.innerHTML = `<div style="font-size:15px;margin:4px 0"><b>${esc(items.map((x) => x.w).join(' '))}</b></div>
    <div class="lab" style="font-size:15px">${esc(items.map((x) => interlinear(x.a).top).join('  '))}</div>
    <div class="lab" style="font-size:15px">${esc(items.map((x) => interlinear(x.a).bottom).join('  '))}</div>
    <div class="tiny" style="margin-top:2px">≈ ${esc(items.map((x) => readingOf(x.a)).join(' · '))}</div>`;
}
async function bdSave(question) {
  const pieces = []; const none = [];
  CHOICES.words.forEach((w, wi) => {
    const el = document.querySelector(`input[name="bdw${wi}"]:checked`); if (!el) return;
    if (el.value === 'none') { none.push(w.word); return; }
    const k = +el.value; const a = w.analyses[k]; const il = interlinear(a); const labs = il.bottom.split(/-(?![^(]*\))/);
    const over = a.over || {};
    const parts = partsOf(a).map(([f, r], i) => ({ form: f, kind: r === 'pre' ? 'prefix' : r ? 'root' : 'suffix',
      meaning: r === true ? (labs[i] && labs[i] !== '?' ? labs[i].replace(/\./g, ' ') : '') : (labs[i] || '').replace(/\*/g, ''),
      verb: r === true && rootKind(a.stem || a.root) === 'verb', ...(over[i] ? { picked: true } : {}) }));
    pieces.push({ word: w.word, meaning: '', parts });
  });
  if (!pieces.length && !none.length) { alert('Tap the right split for at least one word first.'); return; }
  if (pieces.length) {
    const now = Date.now();
    await idb.put({ id: 'n' + now.toString(36) + Math.random().toString(36).slice(2, 6), created: now, updated: now,
      ship: pieces.map((p) => p.word).join(' '), mean: '', ctx: `Chosen from the app's suggested splits after asking “${question}”`, tags: ['chosen split'], pieces });
    DB.notes = await idb.all(); buildIndex(); renderNotes();
  }
  if (none.length) { openTeach(none.join(' '), question); return; }
  await ask(true);
}

function breakdownContext(bd) {
  return bd.map(({ word, analyses }) => {
    const a = analyses[0]; const parts = partsOf(a);
    const il = interlinear(a);
    const others = analyses.slice(1, 4).map((x) => `${interlinear(x).top} (${interlinear(x).bottom})`).join('; ');
    return `[Word breakdown${a.author ? ' — from the grammar' : ' — automatic guess'}] ${word} = ${il.top} = ${il.bottom}${others ? ' — other possible splits: ' + others : ''}: ` + parts.map(([f, r]) => { const i = pieceInfo(f, r)[0];
      const all = pieceInfo(f, r, a.root ? rootKind(a.stem || a.root) : '').map((x) => x.taught ? 'taught by the user: ' + x.text.replace(/^ : /, '') : shortGloss(x.text) || x.label).filter(Boolean).join(' / ');
      return `${r === 'pre' ? f + '-' : r ? f : '-' + f} (${all || '?'})`; }).join(' + ');
  }).join('\n');
}

// question understanding: "how do you say X", "what does X mean"
function intent(q) {
  const s = q.trim().replace(/[?¿!.]+$/, '');
  let m = s.match(/^(?:how (?:do|would|can) (?:you|i|we) say|how to say|what(?:'s| is) the (?:shipibo )?word for|translate|say)\s+["“']?(.+?)["”']?(?:\s+in shipibo(?:-konibo)?)?$/i);
  if (m) return { type: 'en2sh', term: m[1] };
  m = s.match(/^["“']?(.+?)["”']?\s+in shipibo(?:-konibo)?$/i);
  if (m) return { type: 'en2sh', term: m[1] };
  m = s.match(/^what (?:does|do|is)\s+["“']?(.+?)["”']?\s+mean(?:\s+in english)?$/i) || s.match(/^(?:meaning of|define)\s+["“']?(.+?)["”']?$/i);
  if (m) return { type: 'sh2en', term: m[1] };
  return { type: 'any', term: s };
}
function retrieve(q) {
  const it = intent(q);
  let hits;
  if (it.type === 'en2sh') hits = [...search(it.term, { kinds: ['index', 'note'], limit: 8 }), ...search(it.term, { kinds: ['dict'], limit: 4 })];
  else if (it.type === 'sh2en') hits = [...search(it.term, { kinds: ['dict', 'note'], limit: 8 }), ...search(it.term, { kinds: ['gram'], limit: 3 })];
  else {
    // general question: give every source a fair share, then order by score
    hits = [...search(q, { kinds: ['gram'], limit: 5 }), ...search(q, { kinds: ['dict'], limit: 4 }),
      ...search(q, { kinds: ['index'], limit: 3 }), ...search(q, { kinds: ['note'], limit: 3 })].sort((a, b) => b.s - a.s);
  }
  const bd = breakdownFor(it.term);
  for (const { analyses } of bd) { const a = analyses[0];
    for (const [f, r] of partsOf(a))
      for (const x of ((r === 'pre' ? PREFIX : r ? STEMS : AFFIX).get(f) || []).slice(0, 2)) {
        const d = x.k === 'dict' ? DOCS.find((D) => D.k === 'dict' && D.ref === x.e) : x.k === 'gram' ? DOCS.find((D) => D.k === 'gram' && D.ref === x.g) : DOCS.find((D) => D.k === 'note' && D.ref === x.n);
        if (d) hits.push({ d, s: 0.5 });
      } }
  const seen = new Set(); const out = [];
  for (const h of hits) { if (!seen.has(h.d.id)) { seen.add(h.d.id); out.push(h); } }
  return { intent: it, hits: out, breakdown: bd };
}

// ---------------------------------------------------------------- rendering results
function dictEntryHtml(e, terms = []) {
  const subs = e.p === undefined ? DB.dict.filter((x) => x.p === e.i) : [];
  const parent = e.p !== undefined ? DB.dict[e.p] : null;
  let h = `<div class="entry"><span class="hw">${esc(e.h)}</span> ${highlight(md(e.t), terms)}</div>`;
  if (parent) h = `<div class="tiny">under <b>${esc(parent.h)}</b></div>` + h;
  if (subs.length) h += `<details><summary>${subs.length} related entr${subs.length > 1 ? 'ies' : 'y'}</summary>` +
    subs.map((s) => `<div class="entry sub"><span class="hw">${esc(s.h)}</span> ${md(s.t)}</div>`).join('') + '</details>';
  return h;
}
function resultCard(r, terms) {
  const d = r.d;
  if (d.k === 'dict') return `<div class="card"><div class="src">Dictionary</div>${dictEntryHtml(d.ref, terms)}</div>`;
  if (d.k === 'index') return `<div class="card"><div class="src">English → Shipibo</div><div class="entry">${d.ref.s ? `<b>${esc(d.ref.e)}</b> · ` : ''}${highlight(esc(d.ref.t), terms)}</div></div>`;
  if (d.k === 'gram') {
    const g = d.ref; const txt = g.t.split('\n').map((p) => `<p>${highlight(esc(p), terms)}</p>`).join('');
    const lab = g.src === 'sketch' ? `Dictionary grammar sketch · p. ${esc(g.pp)}` : g.g >= 1000 ? `Shipibo texts (grammar Appendix B) · orig. p. ${esc(g.pp)}` : `Grammar · §${esc(g.s)} · orig. p. ${esc(g.pp)}`;
    return `<div class="card"><div class="src">${lab}</div><h3>${esc(g.h)}</h3>
      <details><summary>Read passage</summary><div class="grammar-text">${txt}</div></details></div>`;
  }
  if (d.k === 'note') return `<div class="card"><div class="src">Your notes</div>${noteHtml(d.ref, false)}</div>`;
  return '';
}

// ---------------------------------------------------------------- AI (WebLLM)
let engine = null; let engineModel = null; let webllm = null; let busy = false;
async function gpuInfo() {
  if (!('gpu' in navigator)) return { ok: false, why: 'This browser has no WebGPU. On iPhone you need iOS 26 or newer (Settings → General → About).' };
  try {
    const ad = await navigator.gpu.requestAdapter();
    if (!ad) return { ok: false, why: 'WebGPU is present but no GPU adapter was available.' };
    return { ok: true, f16: ad.features.has('shader-f16') };
  } catch (e) { return { ok: false, why: 'WebGPU error: ' + e.message }; }
}
async function modelId(base) {
  if (base === 'custom') return (LS.get('customModel', null) || {}).id || 'none';
  const g = await gpuInfo(); return `${base}-${g.f16 ? 'q4f16_1' : 'q4f32_1'}-MLC`;
}
async function loadLib() { if (!webllm) webllm = await import(WEBLLM); return webllm; }
// A model you trained with the training kit: same architecture + quantization as a built-in
// model, so it reuses that model's prebuilt iPhone engine (model_lib).
async function appConfig() {
  const lib = await loadLib(); const list = [...lib.prebuiltAppConfig.model_list];
  const c = LS.get('customModel', null);
  if (c && c.id && c.url) {
    const baseRec = list.find((m) => m.model_id === c.base);
    if (baseRec) list.push({ ...baseRec, model_id: c.id, model: c.url });
  }
  return { ...lib.prebuiltAppConfig, model_list: list };
}
function setPill(txt, cls = '') { const p = $('#aiPill'); p.textContent = txt; p.className = 'pill ' + cls; }

async function startAI(fromButton = false) {
  if (engine) return engine;
  const g = await gpuInfo(); if (!g.ok) { setPill('AI: unavailable', 'warn'); if (fromButton) alert(g.why); return null; }
  const base = LS.get('model', MODELS[0].id); const id = await modelId(base);
  const lib = await loadLib();
  const cfg = await appConfig();
  const cached = await lib.hasModelInCache(id, cfg).catch(() => false);
  if (!cached && !navigator.onLine) { setPill('AI: not downloaded', 'warn'); if (fromButton) alert('The model is not downloaded yet, and you are offline.'); return null; }
  $('#dlProg').hidden = false; setPill('AI: loading…');
  try {
    engine = await lib.CreateMLCEngine(id, {
      appConfig: cfg,
      initProgressCallback: (r) => { $('#dlProg').value = r.progress || 0; $('#dlText').textContent = r.text || ''; },
    });
    engineModel = id; setPill('AI: on', 'ok'); $('#dlText').textContent = `Ready: ${id}`; LS.set('modelReady', id);
    refreshChecks();
    return engine;
  } catch (e) {
    engine = null; setPill('AI: error', 'warn'); $('#dlText').textContent = 'Could not start the AI: ' + e.message;
    return null;
  } finally { $('#dlProg').hidden = true; }
}

function contextFor(hits, budget = 5500) {
  const parts = []; let used = 0; const shown = [];
  for (const { d } of hits) {
    let t;
    if (d.k === 'dict') t = `[Dictionary] ${d.ref.h}: ${d.ref.t.replace(/\*+/g, '')}`;
    else if (d.k === 'index') t = `[English→Shipibo] ${d.ref.e}: ${d.ref.t}`;
    else if (d.k === 'gram') t = `[${d.ref.src === 'sketch' ? 'Dictionary grammar sketch' : 'Grammar'} ${d.ref.s} ${d.ref.h}] ${d.ref.t}`;
    else if (d.ref.entry) t = `[User's own dictionary entry] ${d.ref.entry.root} (${d.ref.entry.type}): ${d.ref.entry.meaning}. ${d.ref.entry.explain}` + (d.ref.entry.ex && d.ref.entry.ex.s ? ` Example: ${d.ref.entry.ex.s} = ${d.ref.entry.ex.e}` : '');
    else t = `[User's own notes] Shipibo: ${d.ref.ship} | Meaning: ${d.ref.mean} | Context: ${d.ref.ctx}` +
      ((d.ref.pieces || []).length ? ' | Word by word: ' + d.ref.pieces.map((w) => `${w.word} = ${(w.parts || []).map((p) => p.form + (p.meaning ? ' (' + p.meaning + ')' : '')).join(' + ')}${w.meaning ? ' → ' + w.meaning : ''}`).join('; ') : '');
    t = t.slice(0, 1600);
    if (used + t.length > budget) continue;
    parts.push(t); used += t.length; shown.push(d);
    if (parts.length >= 8) break;
  }
  return { text: parts.join('\n\n'), shown };
}
const SYSTEM = `You are a careful assistant for the Shipibo-Konibo language (Peru).
Answer ONLY from the reference material given with each question: entries from a Shipibo–English dictionary, a plain-language grammar of Shipibo-Konibo, and the user's own notes from their teachers.
Rules:
- Copy Shipibo words exactly as they are written in the material. Never invent Shipibo words or meanings.
- If the material does not contain the answer, say so plainly and suggest what to look up.
- Prefer the user's own notes when they are relevant, and say when you are using them.
- Keep answers short and clear (a few sentences), in simple English.
- When the question contains Shipibo words and a word breakdown is given, START with one line "Quick read:" giving the split and gloss of the whole phrase (like "jakoni-ra kano-ke = well-EV connect-CMPL"), then one short line per word explaining its parts in plain words, then a brief explanation of what it probably means. Mention other possible splits when they are plausible. Say clearly when it is a guess.
- Use the related dictionary entries and example sentences to work out what an unfamiliar word means in context. If a word contains a dictionary word (for example with a prefix dropped, like keiba from bekeiba without be- 'with'), say so and use that meaning; combine the parts to explain the whole phrase.
- When asked to list things (all verbal suffixes, all words for X…), list ALL of the matching items from the material, not just a few.`;

async function aiAnswer(q, hits, bdText = '') {
  const ctx = contextFor(hits, 5500 - bdText.length);
  const box = $('#answer'); box.textContent = ''; box.classList.add('thinking'); box.textContent = 'Thinking…';
  $('#answerNote').textContent = `Based on ${ctx.shown.length} source${ctx.shown.length === 1 ? '' : 's'} shown below. Always check them.`;
  const msgs = [{ role: 'system', content: SYSTEM },
    { role: 'user', content: `Reference material:\n${[bdText, ctx.text].filter(Boolean).join('\n\n') || '(nothing found)'}\n\nQuestion: ${q}` }];
  let out = '';
  const stream = await engine.chat.completions.create({ messages: msgs, stream: true, temperature: 0.2, max_tokens: 400 });
  box.classList.remove('thinking');
  for await (const ch of stream) { out += ch.choices[0]?.delta?.content || ''; box.textContent = out; }
  if (!out.trim()) box.textContent = '(no answer)';
}

let lastAsk = { q: '', words: '' };
function openTeach(words, question) {
  document.querySelector('nav button[data-v="teach"]').click();
  resetForm();
  $('#nShip').value = words || question || '';
  if (question) $('#nCtx').value = `Corrected after asking: “${question}”`;
  if (words) renderPieces(proposePieces(words));
  window.scrollTo(0, 0);
  const first = document.querySelector('#nPieces .p-mean') || $('#nMean'); if (first) first.focus();
}
// ---------------------------------------------------------------- what the dictionary shows about a word
const EN_STOP = new Set(('the a an of to in on at for from by with and or but is are was were be been it its this that these those he she they ' +
  'we you i me my his her their our your him them us not no so as into up out over there here then than when where who what which will would can ' +
  'could did does do has have had am very just about one some all said say says going went go come came get got').split(' '));
let EN_DF = new Map();
function userExamples() {   // your taught phrases and the examples in your dictionary entries also count as examples
  const out = [];
  for (const n of DB.notes) {
    if (n.ship && n.mean) out.push({ s: n.ship, e: n.mean, w: [...new Set(tokens(n.ship))], mine: true });
    if (n.entry && n.entry.ex && n.entry.ex.s) out.push({ s: n.entry.ex.s, e: n.entry.ex.e || '', w: [...new Set(tokens(n.entry.ex.s))], mine: true });
  }
  return out;
}
function wordContext(word, a) {
  const w = fold(word).replace(/[^a-zñ]/g, '');
  const rootP = a ? partsOf(a).find(([, r]) => r === true) : null; const root = rootP ? fold(rootP[0]).replace(/[^a-zñ]/g, '') : '';
  const rel = []; const seenI = new Set();
  const add = (e, why) => { if (!e || seenI.has(e.i)) return; seenI.add(e.i); rel.push({ e, why }); };
  for (const e of DB.dict) { if (/name of the letter/.test(e.t)) continue; const h = fold(e.h).replace(/[^a-zñ]/g, '');   // dictionary words inside this word
    if (h.length >= 4 && h !== w && w.includes(h)) add(e, `contains ${e.h}`); }
  for (const [f, list] of Object.entries(DB.dl.derived || {})) if (f.length >= 4 && w.includes(f))   // …also with a prefix dropped
    for (const d of list) add(DB.dict[d.i], `contains “${f}” = ${d.from} without ${d.drop} (${d.dropg})`);
  for (let k = Math.min(6, w.length - 2); k >= 3 && rel.length < 8; k--) {                           // entries that mention its ending
    const re = new RegExp('[-–]' + w.slice(-k) + '(?![a-zñ])');
    for (const e of DB.dict) if (re.test(fold(e.t.replace(/\*/g, '')))) add(e, `mentions the ending -${w.slice(-k)}`);
  }
  if (root.length >= 4) for (const e of DB.dict) { const h = fold(e.h).replace(/[^a-zñ]/g, '');      // longer words built on the root
    if (h !== w && h.startsWith(root)) add(e, `built on ${root}`); if (rel.length >= 10) break; }
  const ex = [];
  for (const x of [...userExamples(), ...DB.examples]) {
    if (x.w.some((t) => t === w || (w.length >= 5 && t.includes(w)) || (w.length < 5 && t.startsWith(w) && t.length <= w.length + 4)
      || (root.length >= 4 && t.startsWith(root)) || (w.length >= 6 && t.includes(w.slice(0, 5))))) ex.push(x);
    if (ex.length >= 40) break;
  }
  const cnt = new Map();
  for (const x of ex) for (const t of new Set(tokens(x.e))) if (!EN_STOP.has(t) && !STOP.has(t) && t.length > 2) cnt.set(t, (cnt.get(t) || 0) + 1);
  const co = [...cnt.entries()].filter(([, c]) => c >= 2 || ex.length <= 3).map(([t, c]) => [t, c / Math.log2(2 + (EN_DF.get(t) || 0))])
    .sort((x, y) => y[1] - x[1]).slice(0, 8).map(([t]) => t);
  return { word, rel: rel.slice(0, 8), ex: ex.slice(0, 6), exN: ex.length, co };
}
function contextCard(ctxs) {
  const blocks = ctxs.filter((c) => c.rel.length || c.ex.length).map((c) => `<div style="margin-top:10px"><span class="hw">${esc(c.word)}</span>
    ${c.rel.map((r) => `<div class="entry" style="margin:5px 0 5px 8px"><span class="tiny">${esc(r.why)}:</span><br><span class="hw" style="font-size:15px">${esc(r.e.h)}</span> ${md(r.e.t.slice(0, 260))}${r.e.t.length > 260 ? '…' : ''}</div>`).join('')}
    ${c.ex.length ? `<div class="tiny" style="margin:6px 0 2px 8px">Used in ${c.exN} example sentence${c.exN === 1 ? '' : 's'}${c.co.length ? ` — their translations often have: <b>${esc(c.co.join(', '))}</b>` : ''}</div>` +
      c.ex.map((x) => `<div class="entry" style="margin:3px 0 3px 8px"><span class="ex"><b>${esc(x.s)}</b> ${esc(x.e)}${x.mine ? ' <span class="taught">yours</span>' : ''}</span></div>`).join('') : ''}</div>`).join('');
  return blocks ? `<div class="card"><div class="src">What the dictionary shows about these words</div>${blocks}</div>` : '';
}
function contextText(ctxs) {
  return ctxs.map((c) => [
    ...c.rel.map((r) => `[Related dictionary entry for ${c.word} — it ${r.why}] ${r.e.h}: ${r.e.t.replace(/\*+/g, '').slice(0, 300)}`),
    ...c.ex.slice(0, 3).map((x) => `[Example sentence related to ${c.word}] ${x.s} = ${x.e}`),
    c.co.length ? `[Words that often appear in translations of sentences with ${c.word}] ${c.co.join(', ')}` : '',
  ].filter(Boolean).join('\n')).filter(Boolean).join('\n');
}
// ---------------------------------------------------------------- list requests ("list all verbal suffixes")
const LIST_KINDS = [
  { re: /verb(al)?\s+(suffix|ending|marker)/, name: 'verbal suffixes', m: (m) => m.side === 'suffix' && /^verb/.test(m.attaches), d: /^\*?verbal suf/ },
  { re: /(noun|nominal)\s+(suffix|ending|marker)/, name: 'noun suffixes', m: (m) => m.side === 'suffix' && /^noun/.test(m.attaches), d: /^\*?noun suf/ },
  { re: /case\s*(marker|ending|suffix)?s?|\bcases\b/, name: 'case markers', m: (m) => /case/.test(m.category), d: /case/ },
  { re: /evidential|hearsay|reportative/, name: 'evidentials', m: (m) => /evidential/.test(m.category), d: /evidential|mood suf/ },
  { re: /tense|past|future/, name: 'tense markers', m: (m) => /tense/.test(m.category), d: /tense|preterite|past/ },
  { re: /aspect/, name: 'aspect markers', m: (m) => /aspect/.test(m.category), d: /aspect/ },
  { re: /\bmood|imperative|command/, name: 'mood markers', m: (m) => /mood/.test(m.category), d: /mood suf|imperative/ },
  { re: /switch.?reference|same.?subject|different.?subject/, name: 'switch-reference markers', m: (m) => /switch/.test(m.category), d: null },
  { re: /body.?part\s+prefix/, name: 'body-part prefixes', m: (m) => m.side === 'prefix' && /body/i.test(m.meaning + m.category + m.gloss), d: /^\*?modifying pref/ },
  { re: /prefix/, name: 'prefixes', m: (m) => m.side === 'prefix', d: /pref\./ },
  { re: /pronoun/, name: 'pronouns', m: (m) => /person|pronoun/.test(m.category + m.attaches), d: /^\*?pron/ },
  { re: /postposition/, name: 'postpositions', m: (m) => /postposition/.test(m.category), d: /^\*?postp/ },
  { re: /conjunction/, name: 'conjunctions', m: (m) => /conjunction/.test(m.category), d: /^\*?conj/ },
  { re: /demonstrative/, name: 'demonstratives', m: (m) => /demonstrative/.test(m.category), d: /^\*?dem/ },
  { re: /causative|applicative|valen/, name: 'valence-changing suffixes', m: (m) => /valence/.test(m.category), d: null },
  { re: /nominali[sz]/, name: 'nominalizers', m: (m) => /nominalizer/.test(m.category) || /NMLZ/.test(m.gloss), d: null },
  { re: /clitic/, name: 'clitics', m: (m) => /clause|first|any-word/.test(m.attaches), d: null },
  { re: /plural|number/, name: 'number markers', m: (m) => /number/.test(m.category), d: /plural/ },
  { re: /adverb/, name: 'adverbial suffixes', m: (m) => /adverbial/.test(m.category), d: /^\*?adverbial suf/ },
  { re: /(suffix|ending)/, name: 'suffixes and endings', m: (m) => m.side === 'suffix', d: /suf\./ },
];
function listRequest(q) {
  const t = q.toLowerCase().trim();
  if (!/^(please\s+)?(list|show|give|tell|what are|which are|name|can you (list|give|show))\b/.test(t) && !/\b(list|all the|every)\b/.test(t)) return null;
  const words = t.match(/\bwords?\s+(?:for|about|related to|meaning|that mean)\s+["“']?(.+?)["”']?\??$/);
  if (words) { const hits = search(words[1], { kinds: ['index', 'dict'], limit: 200 }); return { kind: 'words', term: words[1], hits }; }
  const k = LIST_KINDS.find((x) => x.re.test(t)); if (!k) return null;
  const seen = new Map();
  for (const m of DB.morph) if (k.m(m)) { const key = m.display + '|' + m.gloss; const prev = seen.get(key);
    if (!prev) seen.set(key, { form: m.display, gloss: m.gloss, meaning: m.meaning, sec: m.sections[0] || '', attaches: m.attaches }); }
  const items = [...seen.values()].sort((a, b) => fold(a.form.replace(/^[-=]/, '')).localeCompare(fold(b.form.replace(/^[-=]/, ''))));
  const have = new Set(items.map((x) => fold(x.form).replace(/[^a-zñ]/g, '')));
  const extra = k.d ? DB.dict.filter((e) => k.d.test(e.t) && /^[-–]|[-–]$/.test(e.h.trim()) && !have.has(fold(e.h).replace(/[^a-zñ]/g, ''))) : [];
  return { kind: 'morph', name: k.name, items, extra };
}
function listHtml(L) {
  if (L.kind === 'words') return `<div class="card"><div class="src">${L.hits.length} entries for “${esc(L.term)}”</div>` + L.hits.map((h) => resultCard(h, qtokens(L.term))).join('') + '</div>';
  const rows = L.items.map((x) => `<tr><td><b class="hw" style="font-size:15px">${esc(x.form)}</b></td><td class="lab">${esc(x.gloss || '')}</td>
    <td>${esc(x.gloss ? plainLabel(x.gloss) : '')}<div class="tiny">${esc(x.meaning.slice(0, 160))}</div></td><td class="tiny">${x.sec ? '§' + esc(x.sec) : ''}</td></tr>`).join('');
  const extra = L.extra.length ? `<div class="src" style="margin-top:12px">Also listed in the dictionary (${L.extra.length})</div>` +
    L.extra.map((e) => `<div class="entry" style="margin:6px 0"><span class="hw">${esc(e.h)}</span> ${md(e.t.slice(0, 220))}</div>`).join('') : '';
  return `<div class="card"><div class="src">All ${esc(L.name)} — ${L.items.length} from the grammar${L.extra.length ? `, ${L.extra.length} more from the dictionary` : ''}</div>
    <table class="list"><tr><th>Form</th><th>Label</th><th>Meaning</th><th>Where</th></tr>${rows}</table>${extra}</div>`;
}
// ---------------------------------------------------------------- ASK view
async function ask(force = false) {
  const q = $('#q').value.trim(); if (!q || (busy && !force)) return;
  busy = true; $('#askBtn').disabled = true;
  try { await askInner(q); }
  catch (e) { $('#answerCard').hidden = false; $('#answer').textContent = 'Something went wrong: ' + e.message; }
  finally { busy = false; $('#askBtn').disabled = false; }
}
async function askInner(q) {
  const L = listRequest(q);
  if (L) {   // a request for a complete list: answer it directly from the grammar + dictionary
    $('#answerCard').hidden = false; $('#answerLabel').textContent = 'Answer';
    $('#answer').classList.remove('thinking');
    $('#answer').textContent = L.kind === 'words' ? `Here are all ${L.hits.length} entries I found for “${L.term}”.` : `Here are all ${L.items.length + L.extra.length} ${L.name} I know, from the grammar and the dictionary.`;
    $('#answerNote').textContent = 'Taken directly from the grammar and the dictionary (complete list).';
    $('#askResults').innerHTML = listHtml(L); return;
  }
  const { intent: it, hits, breakdown } = retrieve(q);
  lastAsk = { q, words: breakdown.map((x) => x.word).join(' ') || (it.type === 'sh2en' ? it.term : '') };
  const terms = qtokens(it.term);
  const ctxs = breakdown.map((x) => wordContext(x.word, x.analyses[0]));
  $('#askResults').innerHTML = breakdownHtml(breakdown) + contextCard(ctxs) + (hits.length ? `<div class="src" style="margin-top:12px">Sources (${hits.length})</div>` +
    hits.map((h) => resultCard(h, terms)).join('') : `<div class="empty">Nothing found in the dictionary, grammar or your notes.</div>`);
  bdPhraseUpdate();
  const card = $('#answerCard');
  try {
    const eng = engine || (LS.get('autoAI', false) ? await startAI() : null);
    if (eng && (hits.length || ctxs.length)) { card.hidden = false; await aiAnswer(q, hits, [breakdownContext(breakdown), contextText(ctxs)].filter(Boolean).join('\n').slice(0, 3200)); }
    else if (hits.length) {
      card.hidden = false; $('#answer').classList.remove('thinking');
      const top = hits[0].d;
      $('#answer').innerHTML = top.k === 'dict' ? dictEntryHtml(top.ref, terms) : top.k === 'index' ? esc(`${top.ref.e}: ${top.ref.t}`) : top.k === 'note' ? noteHtml(top.ref, false) : esc(top.ref.h);
      $('#answerLabel').textContent = 'Best match';
      $('#answerNote').textContent = engine ? '' : 'Turn on the AI in Setup to get written answers.';
    } else card.hidden = true;
  } catch (e) { $('#answer').textContent = 'AI error: ' + e.message; }
  finally { $('#answerLabel').textContent = engine ? 'Answer (AI)' : 'Best match'; }
}

// ---------------------------------------------------------------- DICTIONARY view
function dictSearch() {
  const q = $('#dq').value.trim(); const el = $('#dictResults');
  if (!q) { el.innerHTML = '<div class="empty">Type a Shipibo or English word.</div>'; return; }
  const hits = search(q, { kinds: ['dict', 'index', 'note'], limit: 40 });
  el.innerHTML = hits.length ? hits.map((h) => resultCard(h, qtokens(q))).join('') : '<div class="empty">No matches.</div>';
}

// ---------------------------------------------------------------- GRAMMAR view
function gramToc() {
  const seen = new Set(); const rows = [];
  for (const g of DB.grammar) { if (seen.has(g.s)) continue; seen.add(g.s);
    const depth = (g.s.match(/\./g) || []).length; if (depth > 1) continue;
    rows.push(`<a href="#" data-s="${esc(g.s)}" style="padding-left:${depth * 14}px"><span class="n">${esc(g.s)}</span>${esc(g.h)}</a>`); }
  const sk = []; const seen2 = new Set();
  for (const g of DB.grammar) if (g.src === 'sketch' && /^GS \d+$/.test(g.s) && !seen2.has(g.s)) { seen2.add(g.s);
    sk.push(`<a href="#" data-s="${esc(g.s)}"><span class="n">${esc(g.s.replace('GS ', ''))}</span>${esc(g.h.replace(/^Grammar Sketch \d+\s*/, ''))}</a>`); }
  $('#gramToc').innerHTML = '<div class="src" style="margin:8px 0 2px">The grammar (plain-language edition)</div>' + rows.filter((r) => !/data-s="GS/.test(r)).join('') +
    '<div class="src" style="margin:16px 0 2px">The dictionary\'s grammar sketch</div>' + sk.join('');
}
function gramRead(s) {
  const parts = DB.grammar.filter((g) => g.s === s || g.s.startsWith(s + '.'));
  const html = parts.map((g, i) => (i === 0 || g.s !== parts[i - 1].s ? `<h3 style="margin-top:18px">§${esc(g.s)} ${esc(g.h)} <span class="tiny">orig. p. ${esc(g.pp)}</span></h3>` : '') +
    g.t.split('\n').map((p) => `<p>${esc(p)}</p>`).join('')).join('');
  $('#gramRead').innerHTML = `<button class="btn ghost small" id="gramBack">← Contents</button><div class="grammar-text">${html}</div>`;
  $('#gramRead').hidden = false; $('#gramToc').hidden = true; window.scrollTo(0, 0);
  $('#gramBack').onclick = () => { $('#gramRead').hidden = true; $('#gramToc').hidden = false; };
}
function gramSearch() {
  const q = $('#gq').value.trim();
  if (!q) { $('#gramResults').innerHTML = ''; $('#gramToc').hidden = !$('#gramRead').hidden; return; }
  $('#gramToc').hidden = true; $('#gramRead').hidden = true;
  const hits = search(q, { kinds: ['gram'], limit: 25 });
  $('#gramResults').innerHTML = hits.map((h) => resultCard(h, qtokens(q))).join('') || '<div class="empty">No matches.</div>';
}

// ---------------------------------------------------------------- NOTES (IndexedDB)
const idb = {
  db: null,
  open() { return new Promise((res, rej) => { const r = indexedDB.open('shipibo-helper', 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('notes', { keyPath: 'id' }); d.createObjectStore('audio'); };
    r.onsuccess = () => { this.db = r.result; res(); }; r.onerror = () => rej(r.error); }); },
  tx(store, mode, fn) { return new Promise((res, rej) => { const t = this.db.transaction(store, mode); const s = t.objectStore(store);
    const out = fn(s); t.oncomplete = () => res(out && out.result !== undefined ? out.result : out); t.onerror = () => rej(t.error); }); },
  all() { return this.tx('notes', 'readonly', (s) => s.getAll()); },
  put(n) { return this.tx('notes', 'readwrite', (s) => s.put(n)); },
  del(id) { return this.tx('notes', 'readwrite', (s) => s.delete(id)); },
  putAudio(id, blob) { return this.tx('audio', 'readwrite', (s) => s.put(blob, id)); },
  getAudio(id) { return this.tx('audio', 'readonly', (s) => s.get(id)); },
  delAudio(id) { return this.tx('audio', 'readwrite', (s) => s.delete(id)); },
};
let editing = null; let recBlob = null; let recorder = null;
function proposePieces(text, existing = []) {
  const words = (text.match(/[A-Za-zÀ-ÿñÑ'’]+/g) || []); const seen = new Set(); const out = [];
  for (const w of words) {
    const fw = fold(w); if (seen.has(fw)) continue; seen.add(fw);
    const prev = existing.find((x) => fold(x.word) === fw); if (prev) { out.push(prev); continue; }
    const a = analyze(w)[0];
    const pp = a ? partsOf(a) : [[fw, true]];
    const ctx = a && a.root ? rootKind(a.stem || a.root) : '';
    const parts = pp.map(([f, isRoot], i) => ({ form: f, kind: isRoot === 'pre' ? 'prefix' : isRoot ? 'root' : 'suffix',
      meaning: a ? glossOf(f, isRoot, ctx, { word: fold(w).replace(/[^a-zñ]/g, ''), prev: i ? pp[i - 1][0] : '', root: a.stem || a.root || '' }) : '', guess: true }));
    out.push({ word: w, meaning: '', parts, guessed: true });
  }
  return out;
}
function renderPieces(list) {
  if (!list.length) { $('#nPieces').innerHTML = ''; return; }
  $('#nPieces').innerHTML = `<div class="pieces"><div class="tiny">Check each word. Change the split (use - between pieces) and fix the meanings. Pieces you save are learned and used to read new phrases.</div>` +
    list.map((w, wi) => `<div class="pw" data-wi="${wi}">
      <div class="row"><span class="hw" style="flex:0 0 auto">${esc(w.word)}</span>
        <input class="w-split" value="${esc(w.parts.map((p, i) => (i && p.kind !== 'root' ? '' : '') + p.form).join('-'))}" title="split into pieces with -"></div>
      <input class="w-mean" style="margin-top:6px" placeholder="what this word means here" value="${esc(w.meaning || '')}">
      <div class="pgrid">${w.parts.map((p, pi) => `<div class="pf">${p.kind === 'root' ? '' : '-'}${esc(p.form)}</div>
        <input class="p-mean${p.guess ? ' guess' : ''}" data-pi="${pi}" placeholder="meaning of this piece" value="${esc(p.meaning || '')}">`).join('')}</div>
      <label class="tiny row" style="margin-top:6px"><input type="checkbox" class="w-ok" style="width:auto" ${w.guessed ? '' : 'checked'}> This word is right (save it as taught)</label></div>`).join('') + '</div>';
  $('#nPieces').querySelectorAll('input.p-mean, input.w-mean').forEach((inp) => inp.addEventListener('input', () => {
    inp.classList.remove('guess'); const ok = inp.closest('.pw').querySelector('.w-ok'); ok.checked = true; }));
  $('#nPieces').querySelectorAll('.w-split').forEach((inp) => inp.onchange = () => setTimeout(() => {
    const wi = +inp.closest('.pw').dataset.wi; const cur = readPieces(true); cur[wi].guessed = false;
    const forms = inp.value.split('-').map((x) => x.trim()).filter(Boolean);
    const old = cur[wi].parts; cur[wi].parts = forms.map((f, i) => { const o = old.find((p) => fold(p.form) === fold(f));
      return { form: f, kind: i === 0 ? 'root' : 'suffix', meaning: o ? o.meaning : '' }; });
    renderPieces(cur);
  }, 0));
}
function readPieces(all = false) { // all=false: only words marked "right" are returned for saving
  return [...document.querySelectorAll('#nPieces .pw')].filter((el) => all || el.querySelector('.w-ok').checked).map((el) => {
    const forms = el.querySelector('.w-split').value.split('-').map((x) => x.trim()).filter(Boolean);
    const means = [...el.querySelectorAll('.p-mean')].map((i) => i.value.trim());
    return { word: el.querySelector('.hw').textContent, meaning: el.querySelector('.w-mean').value.trim(), guessed: !el.querySelector('.w-ok').checked,
      parts: forms.map((f, i) => ({ form: f, kind: i === 0 ? 'root' : 'suffix', meaning: means[i] || '' })) };
  });
}
function noteHtml(n, withActions = true) {
  return `<div class="entry"><span class="hw">${esc(n.ship)}</span></div>
    ${(n.pieces || []).length ? `<div class="tiny" style="margin:4px 0">${n.pieces.map((w) => `<b>${esc(w.word)}</b> = ${(w.parts || []).map((p, i) => `${i ? '-' : ''}${esc(p.form)}${p.meaning ? ` <i>(${esc(p.meaning)})</i>` : ''}`).join(' ')}${w.meaning ? ` → “${esc(w.meaning)}”` : ''}`).join('<br>')}</div>` : ''}
    ${n.mean ? `<div><b>Meaning:</b> ${esc(n.mean)}</div>` : ''}
    ${n.builtin ? '<span class="taught">taught together before install</span>' : ''}
    ${n.entry ? `<div class="tiny"><span class="taught">my dictionary · ${esc(n.entry.type)}</span>${n.entry.related && n.entry.related.length ? ' related: ' + n.entry.related.map(esc).join(', ') : ''}${n.entry.ex && n.entry.ex.s ? `<br><span class="ex"><b>${esc(n.entry.ex.s)}</b> ${esc(n.entry.ex.e)}</span>` : ''}</div>` : ''}
    ${n.ctx ? `<div class="muted">${esc(n.ctx)}</div>` : ''}
    ${(n.tags || []).length ? `<div class="tiny">${n.tags.map(esc).join(' · ')}</div>` : ''}
    <div class="tiny">${new Date(n.updated || n.created).toLocaleString()}</div>
    ${n.audio ? `<button class="btn ghost small" data-play="${n.id}" style="margin-top:6px">▶ Play recording</button><audio data-a="${n.id}" controls hidden></audio>` : ''}
    ${withActions ? `<div class="row" style="margin-top:8px"><button class="btn ghost small" data-edit="${n.id}">Edit</button><button class="btn danger small" data-del="${n.id}">Delete</button></div>` : ''}`;
}
function renderNotes() {
  const q = fold($('#nq').value.trim());
  const list = DB.notes.filter((n) => !q || fold([n.ship, n.mean, n.ctx, (n.tags || []).join(' ')].join(' ')).includes(q))
    .sort((a, b) => (b.updated || b.created) - (a.updated || a.created));
  $('#notesList').innerHTML = list.length ? `<div class="tiny" style="margin:10px 2px">${DB.notes.length} note${DB.notes.length === 1 ? '' : 's'} saved on this phone</div>` +
    list.map((n) => `<div class="card">${noteHtml(n)}</div>`).join('') : `<div class="empty">${DB.notes.length ? 'No matches.' : 'Nothing taught yet. Add your first phrase above.'}</div>`;
}
function resetForm() { editing = null; recBlob = null; ['#nShip', '#nMean', '#nCtx', '#nTags'].forEach((s) => ($(s).value = '')); $('#nPieces').innerHTML = '';
  $('#nAudio').hidden = true; $('#nAudio').removeAttribute('src'); $('#recState').textContent = '';
  $('#noteFormTitle').textContent = 'Teach it something new'; $('#cancelNote').hidden = true; }
async function saveNote() {
  const ship = $('#nShip').value.trim(); const mean = $('#nMean').value.trim();
  if (!ship && !mean) { alert('Write the Shipibo phrase or its meaning first.'); return; }
  const now = Date.now();
  const n = editing ? { ...editing } : { id: 'n' + now.toString(36) + Math.random().toString(36).slice(2, 6), created: now };
  const pieces = readPieces().filter((w) => w.meaning || w.parts.some((p) => p.meaning));
  Object.assign(n, { ship, mean, ctx: $('#nCtx').value.trim(), tags: $('#nTags').value.split(',').map((t) => t.trim()).filter(Boolean), updated: now });
  if (pieces.length || editing) n.pieces = pieces;
  if (recBlob) { await idb.putAudio(n.id, recBlob); n.audio = true; }
  await idb.put(n);
  DB.notes = await idb.all(); buildIndex(); renderNotes(); resetForm(); LS.set('notesSince', (LS.get('notesSince', 0) || 0) + 1);
}
async function toggleRec() {
  if (recorder && recorder.state === 'recording') { recorder.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = []; recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => { stream.getTracks().forEach((t) => t.stop());
      recBlob = new Blob(chunks, { type: recorder.mimeType || 'audio/mp4' });
      $('#nAudio').src = URL.createObjectURL(recBlob); $('#nAudio').hidden = false;
      $('#recBtn').textContent = '● Record again'; $('#recState').textContent = `Recorded ${Math.round(recBlob.size / 1024)} KB`; };
    recorder.start(); $('#recBtn').textContent = '■ Stop'; $('#recState').innerHTML = '<span class="rec"><span class="live"></span>Recording…</span>';
  } catch (e) { alert('Could not use the microphone: ' + e.message); }
}
async function onNotesClick(e) {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.play) { const a = document.querySelector(`audio[data-a="${b.dataset.play}"]`); const blob = await idb.getAudio(b.dataset.play);
    if (blob) { a.src = URL.createObjectURL(blob); a.hidden = false; a.play(); b.hidden = true; } }
  if (b.dataset.edit) { const n = DB.notes.find((x) => x.id === b.dataset.edit); editing = n;
    $('#nShip').value = n.ship; $('#nMean').value = n.mean; $('#nCtx').value = n.ctx; $('#nTags').value = (n.tags || []).join(', ');
    renderPieces(n.pieces || []);
    $('#noteFormTitle').textContent = 'Edit note'; $('#cancelNote').hidden = false; window.scrollTo(0, 0); }
  if (b.dataset.del && confirm('Delete this note?')) { await idb.del(b.dataset.del); await idb.delAudio(b.dataset.del).catch(() => {});
    DB.notes = await idb.all(); buildIndex(); renderNotes(); }
}

// ---------------------------------------------------------------- my dictionary entries
function guessType(meaning, explain) {
  const m = (meaning || '').trim().toLowerCase(); const x = (explain || '').toLowerCase();
  if (/^-/.test(meaning || '') || /\b(ending|suffix)\b/.test(x)) return 'ending';
  if (/^to\s+\w/.test(m) || /\bverb\b/.test(x)) return 'verb';
  if (/^(a|an|the)\s+\w/.test(m) || /\bnoun\b|\bthing\b|\bplace\b|\bperson\b/.test(x)) return 'noun';
  if (/\b(adjective|describ)/.test(x)) return 'describing';
  return '';
}
function openEntry(root, meaning, question) {
  document.querySelector('nav button[data-v="teach"]').click();
  $('#entryCard').open = true;
  $('#eRoot').value = root || ''; $('#eMean').value = meaning || ''; $('#eExplain').value = question ? `Heard in: “${question}”\n` : '';
  $('#eType').value = guessType(meaning, '') || ''; $('#eExS').value = ''; $('#eExE').value = '';
  $('#entryCard').scrollIntoView(); ($('#eMean').value ? $('#eExplain') : $('#eMean')).focus();
}
async function saveEntry() {
  const root = $('#eRoot').value.trim(); const meaning = $('#eMean').value.trim();
  if (!root || !meaning) { alert('Write the word and what it means.'); return; }
  const explain = $('#eExplain').value.trim();
  const type = $('#eType').value || guessType(meaning, explain) || 'other';
  // Shipibo words mentioned in the explanation that the dictionary knows -> linked as related words
  const related = [...new Set((explain.match(/[A-Za-zÀ-ÿñÑ]+/g) || []).map((w) => fold(w)).filter((w) => w.length >= 3 && !STOP.has(w) && !EN_STOP.has(w)
    && DB.dict.some((e) => fold(e.h).replace(/[^a-zñ]/g, '') === w)))].slice(0, 8);
  const now = Date.now();
  const entry = { root, meaning, type, explain, related, ex: { s: $('#eExS').value.trim(), e: $('#eExE').value.trim() } };
  await idb.put({ id: 'n' + now.toString(36) + Math.random().toString(36).slice(2, 6), created: now, updated: now,
    ship: root, mean: meaning, ctx: explain, tags: ['my dictionary', type], entry,
    pieces: [{ word: root, meaning, parts: [{ form: fold(root).replace(/[^a-zñ]/g, ''), kind: type === 'ending' ? 'suffix' : 'root', meaning, verb: type === 'verb' }] }] });
  DB.notes = await idb.all(); buildIndex(); renderNotes();
  ['#eRoot', '#eMean', '#eExplain', '#eExS', '#eExE'].forEach((x) => ($(x).value = '')); $('#eType').value = '';
  alert(`Added “${root}” to your dictionary (${type}). It is used from now on to read new words.`);
}
// ---------------------------------------------------------------- backup
const b64 = (blob) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
async function exportBackup() {
  const notes = await idb.all(); const audio = {};
  for (const n of notes) if (n.audio) { const bl = await idb.getAudio(n.id); if (bl) audio[n.id] = await b64(bl); }
  const data = { app: 'shipibo-helper', version: VERSION, exported: new Date().toISOString(), notes, audio };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const name = `shipibo-notes-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: name }); } catch {} }
  else { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); }
  LS.set('lastBackup', Date.now()); LS.set('notesSince', 0); backupInfo();
}
async function importBackup(file) {
  const data = JSON.parse(await file.text()); if (data.app !== 'shipibo-helper') { alert('Not a Shipibo Helper backup file.'); return; }
  let n = 0;
  for (const note of data.notes || []) { await idb.put(note); n++;
    if (data.audio && data.audio[note.id]) { const blob = await (await fetch(data.audio[note.id])).blob(); await idb.putAudio(note.id, blob); } }
  DB.notes = await idb.all(); buildIndex(); renderNotes(); backupInfo(); alert(`Restored ${n} notes.`);
}
function backupInfo() {
  const t = LS.get('lastBackup', 0); const since = LS.get('notesSince', 0);
  $('#backupInfo').textContent = (t ? `Last backup: ${new Date(t).toLocaleString()}.` : 'No backup yet.') + (since ? ` ${since} change(s) since then.` : '');
}

// ---------------------------------------------------------------- offline checklist
async function refreshChecks() {
  const items = [];
  const sw = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  items.push([sw ? 'ok' : 'bad', 'App saved for offline use', sw ? 'The app itself works without internet.' : 'Reload the app once while online.']);
  let shell = false; try { const c = await caches.open(CACHE_NAME()); shell = !!(await c.match('data/grammar.json')) && !!(await c.match(WEBLLM)); } catch {}
  items.push([shell ? 'ok' : 'bad', 'Dictionary, grammar and AI engine stored', shell ? 'All reference data is on the phone.' : 'Still downloading — keep the app open for a minute while online.']);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  items.push([standalone ? 'ok' : 'warn', 'Opened from the Home Screen', standalone ? 'Good — Home Screen apps keep their storage.' : 'In Safari tap Share → "Add to Home Screen", then open it from there.']);
  let persisted = false; try { persisted = await navigator.storage.persisted(); } catch {}
  items.push([persisted ? 'ok' : 'warn', 'Storage protected from clean-up', persisted ? 'The phone will not delete this app’s data.' : 'Not guaranteed; keep regular backups of your notes.']);
  const g = await gpuInfo();
  items.push([g.ok ? 'ok' : 'bad', 'This phone can run the AI', g.ok ? (g.f16 ? 'WebGPU available.' : 'WebGPU available (slower 32-bit mode).') : g.why]);
  let model = false; try { if (g.ok) { const lib = await loadLib(); model = await lib.hasModelInCache(await modelId(LS.get('model', MODELS[0].id)), await appConfig()); } } catch {}
  items.push([model ? 'ok' : 'bad', 'AI model downloaded', model ? 'Stored on the phone.' : 'Tap "Download & start AI" below while on Wi-Fi.']);
  items.push([engine ? 'ok' : 'warn', 'AI tested on this phone', engine ? 'The AI started successfully.' : 'Start it once and ask a question to be sure it works.']);
  let est = ''; try { const e = await navigator.storage.estimate(); est = `Using ${(e.usage / 1e9).toFixed(2)} GB of storage.`; } catch {}
  $('#checks').innerHTML = items.map(([c, t, d]) => `<div class="check"><div class="dot ${c}">${c === 'ok' ? '✓' : c === 'bad' ? '!' : '•'}</div><div><b>${t}</b><div class="tiny">${esc(d)}</div></div></div>`).join('') +
    `<div class="tiny" style="margin-top:6px">${est}</div>`;
  const allOk = items.every(([c]) => c === 'ok');
  if (!engine) setPill(model ? 'AI: ready to start' : 'AI: off', model ? 'ok' : '');
  return allOk;
}
const CACHE_NAME = () => 'shipibo-helper-' + VERSION;

// ---------------------------------------------------------------- boot
async function boot() {
  $('#ver').textContent = `Version ${VERSION}`; $('#hver').textContent = 'v' + VERSION;
  // navigation
  document.querySelectorAll('nav button').forEach((b) => b.onclick = () => {
    document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('section.view').forEach((s) => s.classList.toggle('on', s.id === 'v-' + b.dataset.v));
    if (b.dataset.v === 'setup') refreshChecks(); window.scrollTo(0, 0);
  });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try { await navigator.storage.persist(); } catch {}
  await idb.open();
  const [dict, index, grammar, notes] = await Promise.all([
    fetch('data/dict.json').then((r) => r.json()), fetch('data/index.json').then((r) => r.json()),
    fetch('data/grammar.json').then((r) => r.json()), idb.all()]);
  Object.assign(DB, { dict, index, grammar, notes });
  try { DB.morph = await fetch('data/morphemes.json').then((r) => r.json()); } catch { DB.morph = []; }
  try { DB.labels = await fetch('data/labels.json').then((r) => r.json()); } catch { DB.labels = {}; }
  try { DB.dl = await fetch('data/dictlearn.json').then((r) => r.json()); } catch {}
  try { DB.examples = await fetch('data/examples.json').then((r) => r.json()); } catch { DB.examples = []; }
  try { const att = new URLSearchParams(location.search).get('att') || 'attested.json';
    DB.att = await fetch('data/' + att).then((r) => r.json()); } catch {}
  // teachings we prepared together before install: upserted by id, version-tracked
  try {
    const t = await fetch('data/taught.json').then((r) => r.json());
    if (t.version !== LS.get('taughtVersion', null)) {
      for (const n of t.notes || []) { const mine = notes.find((x) => x.id === n.id); if (!mine || mine.builtin) await idb.put({ ...n, builtin: true }); }
      LS.set('taughtVersion', t.version); DB.notes = await idb.all();
    }
  } catch {}
  buildIndex();
  EN_DF = new Map(); for (const x of DB.examples) for (const t of new Set(tokens(x.e))) EN_DF.set(t, (EN_DF.get(t) || 0) + 1);
  // ask
  const ex = ['How do you say "river"?', 'What does jáskati mean?', 'What does -ra mean?', 'How do I give a command?', 'How do you say "thank you"?'];
  $('#examples').innerHTML = ex.map((x) => `<button class="chip">${esc(x)}</button>`).join('');
  $('#examples').onclick = (e) => { const b = e.target.closest('.chip'); if (b) { $('#q').value = b.textContent; ask(); } };
  $('#askBtn').onclick = ask;
  $('#fixAnswer').onclick = () => openTeach(lastAsk.words, lastAsk.q);
  $('#askResults').addEventListener('click', (e) => { const b = e.target.closest('.fixBd'); if (b) openTeach(b.dataset.words, lastAsk.q);
    if (e.target.closest('#bdSave')) bdSave(lastAsk.q);
    const ex = e.target.closest('.explainBtn'); if (ex) { e.preventDefault();
      const a = CHOICES.words[+ex.dataset.wi].analyses[+ex.dataset.k]; const ri = partsOf(a).findIndex(([, r]) => r === true);
      openEntry(ex.dataset.root, (a.over && a.over[ri]) || '', lastAsk.q); } });
  $('#askResults').addEventListener('change', (e) => {
    if (e.target.matches('#bdCard .pc, #bdCard .pc-own')) { bdPieceChange(e.target); return; }
    if (e.target.matches('#bdCard input[type=radio]')) bdPhraseUpdate(); }); $('#q').onkeydown = (e) => { if (e.key === 'Enter') ask(); };
  // dict / grammar
  let t1; $('#dq').oninput = () => { clearTimeout(t1); t1 = setTimeout(dictSearch, 180); }; dictSearch();
  let t2; $('#gq').oninput = () => { clearTimeout(t2); t2 = setTimeout(gramSearch, 220); };
  gramToc(); $('#gramToc').onclick = (e) => { const a = e.target.closest('a'); if (a) { e.preventDefault(); gramRead(a.dataset.s); } };
  // notes
  $('#bdBtn').onclick = () => { const t = $('#nShip').value.trim(); if (!t) { alert('Write the Shipibo first.'); return; } renderPieces(proposePieces(t, readPieces(true).filter((w) => !w.guessed))); };
  $('#saveNote').onclick = saveNote;
  $('#eSave').onclick = saveEntry;
  $('#eMean').oninput = () => { if (!$('#eType').dataset.touched) $('#eType').value = guessType($('#eMean').value, $('#eExplain').value); };
  $('#eType').onchange = () => { $('#eType').dataset.touched = '1'; }; $('#cancelNote').onclick = resetForm; $('#recBtn').onclick = toggleRec;
  $('#notesList').onclick = onNotesClick; $('#nq').oninput = renderNotes; renderNotes();
  // setup
  const cm = LS.get('customModel', null);
  $('#modelSel').innerHTML = MODELS.map((m) => `<option value="${m.id}">${esc(m.label)}</option>`).join('') +
    `<option value="custom">My trained model${cm ? ' — ' + esc(cm.id) : ' (set up below)'}</option>`;
  if (cm) { $('#cmUrl').value = cm.url; $('#cmBase').value = cm.base; }
  $('#cmSave').onclick = () => {
    const url = $('#cmUrl').value.trim().replace(/\/+$/, ''); const base = $('#cmBase').value;
    if (!/^https:\/\/huggingface\.co\/[^/]+\/[^/]+$/.test(url)) { alert('Paste the model page address, like https://huggingface.co/your-name/shipibo-model'); return; }
    const id = url.split('/').pop();
    LS.set('customModel', { id, url, base }); LS.set('model', 'custom'); location.reload();
  };
  $('#modelSel').value = LS.get('model', MODELS[0].id);
  $('#modelSel').onchange = async () => { LS.set('model', $('#modelSel').value); if (engine) { await engine.unload?.(); engine = null; } refreshChecks(); };
  $('#dlModel').onclick = async () => { $('#dlModel').disabled = true; await startAI(true); $('#dlModel').disabled = false; };
  $('#delModel').onclick = async () => { if (!confirm('Delete the downloaded AI model from this phone?')) return;
    const lib = await loadLib(); const id = await modelId(LS.get('model', MODELS[0].id));
    if (engine) { await engine.unload?.(); engine = null; } await lib.deleteModelAllInfoInCache(id, await appConfig()); setPill('AI: off'); refreshChecks(); };
  $('#autoAI').checked = LS.get('autoAI', false); $('#autoAI').onchange = () => LS.set('autoAI', $('#autoAI').checked);
  $('#recheck').onclick = refreshChecks;
  $('#exportBtn').onclick = exportBackup; $('#importFile').onchange = (e) => e.target.files[0] && importBackup(e.target.files[0]);
  backupInfo();
  const g = await gpuInfo(); $('#gpuInfo').textContent = g.ok ? 'This phone supports on-device AI.' : g.why;
  refreshChecks();
  if (LS.get('autoAI', false)) startAI();
}
boot().catch((e) => { document.querySelector('main').insertAdjacentHTML('afterbegin', `<div class="card" style="color:var(--bad)">Startup error: ${esc(e.message)}</div>`); });
