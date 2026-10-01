// pkl-core.js — đọc Packing List SCAVI, cập nhật trọng lượng vào Packlist Hugo Boss.
// Dùng chung cho trình duyệt và Node (truyền pdfjs + PDFLib vào).

const num = (s) => parseFloat(String(s).replace(/,/g, ''));
const toCents = (v) => Math.round(v * 100);
const fmt = (cents) => {
  const v = (cents / 100).toFixed(2);
  return v.replace(/\.?0+$/, '');
};

async function getPages(pdfjs, bytes) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(0), isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const tc = await p.getTextContent();
    const items = tc.items
      .filter((it) => it.str && it.str.trim())
      .map((it) => ({ str: it.str.trim(), x: it.transform[4], y: it.transform[5], w: it.width, h: it.height || 10 }));
    items.ops = await textOps(pdfjs, p);
    pages.push(items);
  }
  return pages;
}

// Vị trí bắt đầu của từng lệnh vẽ chữ (Tj/TJ/'/") theo đúng thứ tự trong content stream
const mul = (m, n) => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];
async function textOps(pdfjs, page) {
  const O = pdfjs.OPS;
  const ol = await page.getOperatorList();
  const I = [1, 0, 0, 1, 0, 0];
  let ctm = I, stack = [], tm = I, tlm = I, leading = 0, depth = 0;
  const out = [];
  const glyphText = (a) => (Array.isArray(a) ? a : []).map((g) => (typeof g === 'object' && g ? g.unicode || '' : '')).join('');
  for (let i = 0; i < ol.fnArray.length; i++) {
    const f = ol.fnArray[i], a = ol.argsArray[i] || [];
    if (f === O.paintFormXObjectBegin) depth++;
    else if (f === O.paintFormXObjectEnd) depth--;
    if (depth) continue;
    if (f === O.save) stack.push(ctm);
    else if (f === O.restore) ctm = stack.pop() || I;
    else if (f === O.transform) ctm = mul(a, ctm);
    else if (f === O.beginText) { tm = tlm = I; }
    else if (f === O.setTextMatrix) { tm = tlm = a.length === 6 ? a : a[0]; }
    else if (f === O.setLeading) leading = a[0];
    else if (f === O.moveText || f === O.setLeadingMoveText) {
      if (f === O.setLeadingMoveText) leading = -a[1];
      tm = tlm = mul([1, 0, 0, 1, a[0], a[1]], tlm);
    } else if (f === O.nextLine) { tm = tlm = mul([1, 0, 0, 1, 0, -leading], tlm); }
    else if (f === O.showText || f === O.showSpacedText || f === O.nextLineShowText || f === O.nextLineSetSpacingShowText) {
      if (f === O.nextLineShowText || f === O.nextLineSetSpacingShowText) tm = tlm = mul([1, 0, 0, 1, 0, -leading], tlm);
      const d = mul(tm, ctm);
      const g = f === O.nextLineSetSpacingShowText ? a[2] : a[0];
      out.push({ x: d[4], y: d[5], text: glyphText(g) });
    }
  }
  return out;
}

// gom item theo dòng (cùng y)
function rows(items, tol = 1.5) {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const out = [];
  for (const it of sorted) {
    const r = out.find((r) => Math.abs(r.y - it.y) <= tol);
    if (r) r.items.push(it);
    else out.push({ y: it.y, items: [it] });
  }
  out.forEach((r) => r.items.sort((a, b) => a.x - b.x));
  return out;
}

/* ===================== SCAVI ===================== */
export async function parseScavi(pdfjs, bytes) {
  const pages = await getPages(pdfjs, bytes);
  const cartons = []; // {poItem, style, color, contents:{size:qty}, gw, nw, ctn, pl}
  const sections = [];
  let poItem = null, poNumber = null, pl = null, totalNet = null, totalGross = null;
  let last = null; // dòng carton trước (để ghép thùng)
  let color = null, style = null;

  for (const items of pages) {
    // xác định cột theo tiêu đề nếu có, mặc định theo mẫu SCAVI
    const col = { from: 38, to: 60, colorEnd: 236, sizeEnd: 262, qtyEnd: 340, boxEnd: 372, realEnd: 428, nwEnd: 470, gwEnd: 503 };
    for (const r of rows(items)) {
      const t = r.items.map((i) => i.str).join(' ');
      // header của từng PL
      const pln = t.match(/PL No:\s*(\S+)/); if (pln) { pl = pln[1]; }
      const ord = t.match(/Order No:\s*(\d+)-(\d+)/);
      if (ord) { poNumber = ord[1]; poItem = parseInt(ord[2], 10); sections.push({ pl, poNumber, poItem }); last = null; }
      const ci = t.match(/Total CI Net Weight\s*([\d,.]+)/); if (ci) totalNet = num(ci[1]);
      const cg = t.match(/Total CI Gross Weight\s*([\d,.]+)/); if (cg) totalGross = num(cg[1]);
      const sn = t.match(/Total Net Weight\s*([\d,.]+)/); if (sn && !/CI/.test(t) && sections.length) sections[sections.length - 1].net = num(sn[1]);
      const sg = t.match(/Total Gross Weight\s*([\d,.]+)/); if (sg && !/CI/.test(t) && sections.length) sections[sections.length - 1].gross = num(sg[1]);

      // dòng dữ liệu
      const f = r.items.find((i) => i.x + i.w <= col.from && /^\d+$/.test(i.str));
      const to = r.items.find((i) => i.x >= col.from - 2 && i.x + i.w <= col.to && /^\d+$/.test(i.str));
      if (!f || !to) continue;
      const pick = (lo, hi) => r.items.find((i) => i.x + i.w > lo && i.x + i.w <= hi);
      const colTxt = r.items.filter((i) => i.x >= col.to && i.x + i.w <= col.colorEnd).map((i) => i.str).join(' ');
      const size = r.items.find((i) => i.x >= col.colorEnd - 4 && i.x + i.w <= col.sizeEnd + 2);
      const qty = pick(col.sizeEnd + 30, col.qtyEnd);
      const box = pick(col.qtyEnd, col.boxEnd);
      const nw = pick(col.realEnd, col.nwEnd);
      const gw = pick(col.nwEnd, col.gwEnd);
      if (!size || !qty) continue;
      const cm = colTxt.match(/^(\d{3})\b/);
      const sm = colTxt.match(/\b(\d{7,10})\b/);
      if (cm) color = cm[1];
      if (sm) style = sm[1];
      const from = +f.str, toN = +to.str;
      const q = num(qty.str);
      // dòng ghép thùng: cùng CTN From/To với dòng trước và không có Color mới
      if (last && last.from === from && last.to === toN && !cm) {
        for (const c of last.cartons) c.contents[size.str] = (c.contents[size.str] || 0) + q;
        continue;
      }
      const group = { from, to: toN, cartons: [] };
      for (let n = from; n <= toN; n++) {
        const c = {
          pl, poNumber, poItem, style, color, ctn: n,
          contents: { [size.str]: q },
          gw: gw ? num(gw.str) : null, nw: nw ? num(nw.str) : null,
        };
        group.cartons.push(c); cartons.push(c);
      }
      last = group;
    }
  }
  return { cartons, sections, totalNet, totalGross };
}

/* ===================== HUGO ===================== */
export async function parseHugo(pdfjs, bytes) {
  const pages = await getPages(pdfjs, bytes);
  const cartons = []; // {page, poItem, style, sscc, weightItems:[...], contents, color}
  const subtotals = []; // {page, items:[num, KG], isGrand}
  const headers = []; // {page, kind:'net'|'gross', items}
  let poItem = null, style = null, cur = null;
  pages.forEach((items, pi) => {
    const rs = rows(items, 2);
    // header Net/Gross Weight
    for (const r of rs) {
      const t = r.items.map((i) => i.str).join(' ');
      const m = t.match(/^(?:.*\s)?(Net|Gross) Weight\s+([\d.,]+)\s+KG/);
      if (m && !/Total/.test(t.split(m[1])[0].slice(-6))) {
        const label = r.items.findIndex((i) => i.str === 'Weight');
        const valItems = r.items.slice(label + 1, label + 3);
        headers.push({ page: pi, kind: m[1].toLowerCase(), value: num(m[2]), items: valItems });
      }
    }
    for (const r of rs) {
      const ss = r.items.find((i) => /^\d{18,20}$/.test(i.str));
      const tr = r.items.find((i) => i.x < 130 && i.x > 100 && /^\d{1,3}$/.test(i.str));
      const st = r.items.find((i) => i.x > 140 && i.x < 200 && /^\d{7,10}$/.test(i.str));
      if (ss) {
        if (tr) poItem = parseInt(tr.str, 10);
        if (st) style = st.str;
        // trọng lượng nằm cùng hàng (lệch tối đa ~1pt)
        const wItems = r.items.filter((i) => i.x > 430 && i.x < 500 && /^([\d.]+(\s*KG)?|KG)$/.test(i.str));
        cur = { page: pi, y: ss.y, poItem, style, sscc: ss.str, weight: wItems.length ? num(wItems[0].str.replace('KG', '')) : null, weightItems: wItems, contents: {}, color: null };
        cartons.push(cur);
        continue;
      }
      // dòng nội dung: color / size / qty
      const c = r.items.find((i) => /^\d{3}$/.test(i.str) && i.x > 340 && i.x < 380);
      const sz = r.items.find((i) => i.x > 375 && i.x < 412);
      const q = r.items.find((i) => /^\d+$/.test(i.str) && i.x > 405 && i.x + i.w < 450);
      if (c && sz && q && cur) {
        cur.color = c.str;
        cur.contents[sz.str] = (cur.contents[sz.str] || 0) + num(q.str);
      }
    }
    // tổng phụ / tổng cộng: số ở cột Weight, "KG" nằm dòng dưới
    const kgs = items.filter((i) => i.str === 'KG' && i.x > 440 && i.x < 500);
    for (const kg of kgs) {
      const sameLineNum = items.find((i) => Math.abs(i.y - kg.y) < 2 && /^[\d.]+$/.test(i.str) && i.x > 430 && i.x < kg.x);
      if (sameLineNum) continue;
      const above = items.find((i) => /^[\d.]+$/.test(i.str) && i.x > 430 && i.x < 500 && i.y - kg.y > 5 && i.y - kg.y < 18);
      if (!above) continue;
      const isGrand = items.some((i) => /^Cartons:/.test(i.str) && Math.abs(i.y - (kg.y + above.y) / 2) < 8);
      const afterCarton = cartons.filter((c) => c.page < pi || (c.page === pi && c.y > above.y)).length;
      subtotals.push({ page: pi, value: num(above.str), items: [above, kg], isGrand, afterCarton });
    }
  });
  return { cartons, subtotals, headers, pageCount: pages.length, ops: pages.map((p) => p.ops) };
}

const keyOf = (c) => `${c.poItem}|${c.style}|${c.color}|` + Object.keys(c.contents).sort().map((k) => `${k}:${c.contents[k]}`).join(',');

/* ===================== MATCH ===================== */
export function matchCartons(hugo, scavi) {
  const pool = new Map();
  for (const c of scavi.cartons) {
    const k = keyOf(c);
    if (!pool.has(k)) pool.set(k, []);
    pool.get(k).push(c);
  }
  const result = [], unmatched = [];
  for (const h of hugo.cartons) {
    const q = pool.get(keyOf(h));
    const s = q && q.length ? q.shift() : null;
    if (!s) unmatched.push(h);
    result.push({ hugo: h, scavi: s, newWeight: s ? s.gw : h.weight });
  }
  const leftover = [...pool.values()].flat();
  return { result, unmatched, leftover };
}

/* ============ XOÁ CHỮ CŨ KHỎI CONTENT STREAM ============ */
// Tìm các toán tử vẽ chữ (Tj, TJ, ', ") theo thứ tự, thay toán hạng bằng chuỗi rỗng.
export function scanTextOps(src) {
  const n = src.length, ops = [];
  let i = 0, operands = [], arrDepth = 0, arrStart = -1;
  const ws = (c) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
  const delim = (c) => ws(c) || '()<>[]{}/%'.includes(String.fromCharCode(c));
  while (i < n) {
    const c = src.charCodeAt(i);
    if (ws(c)) { i++; continue; }
    const ch = src[i];
    if (ch === '%') { while (i < n && src[i] !== '\n' && src[i] !== '\r') i++; continue; }
    let start = i, tokEnd;
    if (ch === '(') {
      let d = 0;
      for (; i < n; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (src[i] === '(') d++;
        else if (src[i] === ')') { d--; if (d === 0) { i++; break; } }
      }
      tokEnd = i;
    } else if (ch === '<' && src[i + 1] === '<') { i += 2; tokEnd = i; if (!arrDepth) operands.push([start, i]); continue; }
    else if (ch === '>' && src[i + 1] === '>') { i += 2; continue; }
    else if (ch === '<') { i = src.indexOf('>', i) + 1; tokEnd = i; }
    else if (ch === '[') { if (!arrDepth) arrStart = i; arrDepth++; i++; continue; }
    else if (ch === ']') { arrDepth--; i++; if (!arrDepth) operands.push([arrStart, i]); continue; }
    else if (ch === '{' || ch === '}') { i++; continue; }
    else if (ch === '/') { i++; while (i < n && !delim(src.charCodeAt(i))) i++; tokEnd = i; }
    else {
      while (i < n && !delim(src.charCodeAt(i))) i++;
      const tok = src.slice(start, i);
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) { if (!arrDepth) operands.push([start, i]); continue; }
      // toán tử
      if (tok === 'Tj' || tok === 'TJ' || tok === "'" || tok === '"') {
        const o = operands[operands.length - 1];
        if (o) ops.push({ op: tok, s: o[0], e: o[1] });
      } else if (tok === 'ID') {
        const m = src.slice(i).search(/\sEI[\s]/);
        i = m < 0 ? n : i + m + 3;
      }
      operands = [];
      continue;
    }
    if (!arrDepth) operands.push([start, tokEnd]);
  }
  return ops;
}

// origRef: giá trị /Contents ban đầu của trang (trước khi pdf-lib vẽ thêm)
function stripText(PDFLib, doc, origRef, opIndexes, expectedCount) {
  const { PDFArray, PDFRef, PDFRawStream, decodePDFRawStream } = PDFLib;
  const ctx = doc.context;
  const resolved = ctx.lookup(origRef);
  const refs = resolved instanceof PDFArray ? resolved.asArray() : [origRef];
  if (!refs.every((r) => r instanceof PDFRef && ctx.lookup(r) instanceof PDFRawStream)) return false;
  let src = '';
  for (const r of refs) {
    const bytes = decodePDFRawStream(ctx.lookup(r)).decode();
    let part = '';
    for (let j = 0; j < bytes.length; j += 8192) part += String.fromCharCode.apply(null, bytes.subarray(j, j + 8192));
    src += part + '\n';
  }
  const ops = scanTextOps(src);
  if (ops.length !== expectedCount) return false; // không khớp → chỉ phủ trắng
  const kill = [...new Set(opIndexes)].sort((a, b) => b - a);
  for (const k of kill) {
    const o = ops[k];
    const empty = src[o.s] === '[' ? '[]' : '()';
    src = src.slice(0, o.s) + empty + src.slice(o.e);
  }
  const out = new Uint8Array(src.length);
  for (let j = 0; j < src.length; j++) out[j] = src.charCodeAt(j) & 0xff;
  ctx.assign(refs[0], ctx.flateStream(out));
  for (const r of refs.slice(1)) ctx.assign(r, ctx.flateStream(new Uint8Array([10])));
  return true;
}

/* ===================== WRITE ===================== */
export async function buildOutput(PDFLib, hugoBytes, hugo, scavi, match) {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const doc = await PDFDocument.load(hugoBytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pages = doc.getPages();
  const origContents = pages.map((pg) => pg.node.get(PDFLib.PDFName.of('Contents')));
  const WHITE = rgb(1, 1, 1), GREY = rgb(0.753, 0.753, 0.753), BLACK = rgb(0, 0, 0);

  const kills = pages.map(() => []);
  const replace = (pi, its, text, f, bg, align = 'center', size = 10) => {
    const page = pages[pi];
    // đánh dấu lệnh vẽ chữ cũ để xoá
    for (const it of its) {
      const k = (hugo.ops[pi] || []).findIndex((o) => Math.abs(o.x - it.x) < 1.5 && Math.abs(o.y - it.y) < 1.5);
      if (k >= 0) kills[pi].push(k);
    }
    const x0 = Math.min(...its.map((i) => i.x));
    const x1 = Math.max(...its.map((i) => i.x + i.w));
    const y = its[0].y;
    const tw = f.widthOfTextAtSize(text, size);
    const tx = align === 'center' ? (x0 + x1) / 2 - tw / 2 : x0;
    const rx0 = Math.min(x0, tx) - 0.8, rx1 = Math.max(x1, tx + tw) + 0.8;
    // xoá chữ cũ bằng nền cùng màu ô, rồi ghi số mới
    page.drawRectangle({ x: rx0, y: y - 2.3, width: rx1 - rx0, height: size * 0.8 + 2.3, color: bg });
    page.drawText(text, { x: tx, y, size, font: f, color: BLACK });
  };

  // từng thùng
  let runCents = 0, grandCents = 0, idx = 0;
  const subs = [...hugo.subtotals].sort((a, b) => a.afterCarton - b.afterCarton);
  const subValues = [];
  for (const m of match.result) {
    const w = m.newWeight;
    if (m.scavi && m.hugo.weightItems.length) {
      replace(m.hugo.page, m.hugo.weightItems, `${fmt(toCents(w))} KG`, font, WHITE);
    }
    runCents += toCents(w || 0); grandCents += toCents(w || 0); idx++;
    while (subs.length && subs[0].afterCarton === idx && !subs[0].isGrand) {
      const s = subs.shift();
      subValues.push({ old: s.value, new: runCents / 100 });
      replace(s.page, [s.items[0]], fmt(runCents), bold, GREY);
      runCents = 0;
    }
  }
  // tổng cộng (ưu tiên tổng CI của SCAVI)
  const grossCents = scavi.totalGross != null ? toCents(scavi.totalGross) : grandCents;
  for (const s of hugo.subtotals.filter((s) => s.isGrand)) replace(s.page, [s.items[0]], fmt(grossCents), bold, GREY);
  // header
  for (const h of hugo.headers) {
    const v = h.kind === 'net' ? scavi.totalNet : scavi.totalGross;
    if (v == null) continue;
    replace(h.page, h.items, `${fmt(toCents(v))} KG`, font, WHITE, 'left');
  }
  let stripped = 0;
  pages.forEach((pg, pi) => {
    if (kills[pi].length && stripText(PDFLib, doc, origContents[pi], kills[pi], hugo.ops[pi].length)) stripped++;
  });
  const bytes = await doc.save();
  return { bytes, sumCartons: grandCents / 100, subValues, stripped, pagesTouched: kills.filter((k) => k.length).length };
}

export async function processFiles(pdfjs, PDFLib, hugoBytes, scaviBytes) {
  const scavi = await parseScavi(pdfjs, scaviBytes);
  const hugo = await parseHugo(pdfjs, hugoBytes);
  const match = matchCartons(hugo, scavi);
  const out = await buildOutput(PDFLib, hugoBytes, hugo, scavi, match);
  return { scavi, hugo, match, ...out };
}
