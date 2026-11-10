/**
 * .xlsx 生成器测试。
 *
 * 这里刻意用「另一个独立的 ZIP 读取实现」来解自己生成的包——如果生成和解析共用同一套
 * 代码，写错了也是两边一起错，等于没测。顺带校验每个条目的 CRC32，保证文件不是坏的。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildXlsx, zipStore, crc32, columnName } from '../src/xlsx.js';

const decoder = new TextDecoder();

/** 独立实现的 ZIP 读取（只支持存储方式，够用） */
function unzipStore(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // 从尾部找目录结束标记
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.notEqual(eocd, -1, '没找到 ZIP 目录结束标记，文件不是合法 ZIP');

  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  assert.equal(cdOffset + cdSize, eocd, '中央目录大小/偏移对不上');

  const files = [];
  let cursor = cdOffset;
  for (let i = 0; i < count; i += 1) {
    assert.equal(view.getUint32(cursor, true), 0x02014b50, '中央目录项标记不对');
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen));

    assert.equal(method, 0, `${name} 不是存储方式`);

    // 读本地文件头，跳过文件名和扩展区，取数据
    assert.equal(view.getUint32(localOffset, true), 0x04034b50, `${name} 本地文件头不对`);
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = bytes.subarray(dataStart, dataStart + size);

    assert.equal(crc32(data), crc, `${name} 的 CRC32 对不上，文件是坏的`);
    files.push({ name, data, text: decoder.decode(data) });

    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function find(files, name) {
  const hit = files.find((f) => f.name === name);
  assert.ok(hit, `包里没有 ${name}`);
  return hit.text;
}

test('生成的文件是合法 ZIP，条目齐全，CRC 正确', () => {
  const bytes = buildXlsx([{ name: '明细', rows: [['日期', '金额'], ['2026-11-01', 35.5]] }]);
  const files = unzipStore(bytes);

  assert.deepEqual(
    files.map((f) => f.name).sort(),
    [
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ].sort(),
  );

  assert.match(find(files, '_rels/.rels'), /officeDocument/);
  assert.match(find(files, '[Content_Types].xml'), /spreadsheetml\.sheet\.main\+xml/);
  assert.match(find(files, 'xl/workbook.xml'), /name="明细"/);
});

test('单元格：数字写成 v，文字写成 inlineStr', () => {
  const bytes = buildXlsx([
    { name: 'S1', rows: [['金额', '备注'], [35.5, '买菜'], [0, '']] },
  ]);
  const sheet = find(unzipStore(bytes), 'xl/worksheets/sheet1.xml');

  assert.match(sheet, /<c r="A2"><v>35\.5<\/v><\/c>/, '数字没有写成数值单元格');
  assert.match(sheet, /<c r="B2" t="inlineStr"><is><t xml:space="preserve">买菜<\/t><\/is><\/c>/);
  assert.match(sheet, /<c r="A3"><v>0<\/v><\/c>/, '0 被当成空值丢掉了');
  assert.ok(!/<c r="B3"[\s\S]*?<\/c>/.test(sheet), '空字符串不该生成单元格');
});

test('特殊字符被正确转义（不然 Excel 会说文件损坏）', () => {
  const evil = 'a<b&c>"d"\'e\'';
  const bytes = buildXlsx([{ name: 'S1', rows: [['文本'], [evil]] }]);
  const sheet = find(unzipStore(bytes), 'xl/worksheets/sheet1.xml');

  assert.ok(!sheet.includes('<b&'), '尖括号没转义');
  assert.match(sheet, /a&lt;b&amp;c&gt;&quot;d&quot;&apos;e&apos;/);
});

test('表名里的非法字符被换掉，且不超过 31 字', () => {
  const longName = '一'.repeat(40);
  const bytes = buildXlsx([{ name: 'a/b:c*d?', rows: [['x']] }, { name: longName, rows: [['y']] }]);
  const workbook = find(unzipStore(bytes), 'xl/workbook.xml');

  assert.ok(!/name="[^"]*[/:?*]/.test(workbook), '表名里还有非法字符');
  const names = [...workbook.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(names.length, 2);
  assert.ok(names.every((n) => n.length <= 31), `表名超长了：${names.map((n) => n.length).join(',')}`);
});

test('多个工作表：关系文件与内容类型都要对得上', () => {
  const bytes = buildXlsx([
    { name: '明细', rows: [['a']] },
    { name: '汇总', rows: [['b']] },
  ]);
  const files = unzipStore(bytes);

  const rels = find(files, 'xl/_rels/workbook.xml.rels');
  assert.match(rels, /worksheets\/sheet1\.xml/);
  assert.match(rels, /worksheets\/sheet2\.xml/);

  const types = find(files, '[Content_Types].xml');
  assert.match(types, /\/xl\/worksheets\/sheet1\.xml/);
  assert.match(types, /\/xl\/worksheets\/sheet2\.xml/);

  assert.match(find(files, 'xl/worksheets/sheet2.xml'), /b/);
});

test('列名换算：A、Z、AA 都要对', () => {
  assert.equal(columnName(0), 'A');
  assert.equal(columnName(25), 'Z');
  assert.equal(columnName(26), 'AA');
  assert.equal(columnName(27), 'AB');
  assert.equal(columnName(51), 'AZ');
  assert.equal(columnName(52), 'BA');
});

test('表头冻结、列宽都在', () => {
  const bytes = buildXlsx([{ name: 'S1', rows: [['日期', '金额'], ['2026-11-01', 12]] }]);
  const sheet = find(unzipStore(bytes), 'xl/worksheets/sheet1.xml');
  assert.match(sheet, /<pane ySplit="1"/, '表头没冻结');
  assert.match(sheet, /<col min="1" max="1" width="\d+" customWidth="1"\/>/);
});

test('空工作簿会明确报错，而不是产出坏文件', () => {
  assert.throws(() => buildXlsx([]), /至少要有一个工作表/);
});

test('zipStore 自己的边界：空条目', () => {
  const bytes = zipStore([{ name: 'empty.txt', data: '' }]);
  const files = unzipStore(bytes);
  assert.equal(files.length, 1);
  assert.equal(files[0].data.length, 0);
});
