/**
 * 极简 .xlsx 生成器：手写 ZIP（存储式、不压缩）+ 最小 Office Open XML。
 *
 * 为什么要自己写：这个项目承诺「零依赖、克隆即用」，不能为了导出 Excel 引入打包器或 CDN。
 * .xlsx 本质就是一个 ZIP 里放几个 XML，用「存储」方式（不压缩）连压缩库都不需要。
 *
 * 用法：
 *   const bytes = buildXlsx([{ name: '明细', rows: [['日期','金额'], ['2026-11-01', 35.5]] }]);
 *   new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
 */

const encoder = new TextEncoder();

/* ---------------- CRC32 ---------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* ---------------- 小工具 ---------------- */

function xmlEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 0 → A，25 → Z，26 → AA */
export function columnName(index) {
  let name = '';
  let n = index;
  while (n >= 0) {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  }
  return name;
}

/** 中文字符按两个宽度算，用来估列宽 */
function displayWidth(value) {
  let width = 0;
  for (const ch of String(value)) {
    width += ch.charCodeAt(0) > 255 ? 2 : 1;
  }
  return width;
}

/* ---------------- sheet XML ---------------- */

function cellXml(ref, value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"><v>${value}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}

function sheetXml(rows, { freezeHeader = true } = {}) {
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);

  // 列宽：按内容估，中文算两格
  const widths = [];
  for (let c = 0; c < columnCount; c += 1) {
    let widest = 6;
    for (const row of rows) {
      const cell = row[c];
      if (cell === null || cell === undefined) continue;
      widest = Math.max(widest, displayWidth(cell));
    }
    widths.push(Math.min(46, widest + 2));
  }
  const cols = columnCount
    ? `<cols>${widths
        .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
        .join('')}</cols>`
    : '';

  const body = rows
    .map((row, r) => {
      const cells = row
        .map((value, c) => cellXml(`${columnName(c)}${r + 1}`, value))
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');

  const pane = freezeHeader
    ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    : '';

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}${cols}<sheetData>${body}</sheetData></worksheet>`;
}

/* ---------------- ZIP（存储方式，不压缩） ---------------- */

function dosDateTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xffff, date: day & 0xffff };
}

export function zipStore(entries, { date = new Date() } = {}) {
  const { time, date: dosDate } = dosDateTime(date);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const data = entry.data instanceof Uint8Array ? entry.data : encoder.encode(entry.data);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // 本地文件头
    lv.setUint16(4, 20, true); // 需要的解压版本
    lv.setUint16(6, 0x0800, true); // UTF-8 文件名标志
    lv.setUint16(8, 0, true); // 存储，不压缩
    lv.setUint16(10, time, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); // 中央目录项
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); // 目录结束
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + centralSize + end.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of [...locals, ...centrals, end]) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

/* ---------------- 组装工作簿 ---------------- */

/**
 * @param {Array<{name: string, rows: Array<Array<string|number|null>>}>} sheets
 * @returns {Uint8Array} .xlsx 文件内容
 */
export function buildXlsx(sheets, { date = new Date() } = {}) {
  const list = (sheets || []).filter(Boolean);
  if (!list.length) throw new Error('至少要有一个工作表');

  const safeName = (name, index) => {
    const cleaned = String(name || `Sheet${index + 1}`)
      .replace(/[\\/?*[\]:]/g, ' ')
      .slice(0, 31);
    return cleaned || `Sheet${index + 1}`;
  };

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${list
    .map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join('')}</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${list
    .map((sheet, i) => `<sheet name="${xmlEscape(safeName(sheet.name, i))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('')}</sheets></workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    )
    .join('')}</Relationships>`;

  const entries = [
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    ...list.map((sheet, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: sheetXml(sheet.rows || []),
    })),
  ];

  return zipStore(entries, { date });
}
