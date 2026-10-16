/**
 * XLSX writer.
 *
 * The export format is written by hand, so these tests parse the ZIP container
 * back out: a silently malformed archive would only fail when a merchant
 * opened the file, which is exactly the failure we cannot ship.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { buildXlsx, xlsxChecksum } from '@/server/exports/xlsx';

type ZipEntry = { name: string; content: Buffer };

/** Reads the archive back the way a spreadsheet application would. */
function readZip(buffer: Buffer): ZipEntry[] {
  const endSignature = 0x06054b50;
  let endOffset = -1;
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === endSignature) {
      endOffset = offset;
      break;
    }
  }
  assert.ok(endOffset >= 0, 'no end-of-central-directory record found');

  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  assert.ok(centralSize > 0 && centralOffset > 0, 'central directory offset must be recorded');

  const entries: ZipEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50, 'bad central directory signature');
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, 'bad local header signature');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    entries.push({ name, content: method === 0 ? raw : inflateRawSync(raw) });

    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe('buildXlsx', () => {
  it('produces an archive with the required OOXML parts', () => {
    const entries = readZip(buildXlsx([['A']]));
    const names = entries.map((entry) => entry.name);

    assert.deepEqual(names, [
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/worksheets/sheet1.xml',
    ]);
  });

  it('writes strings inline and numbers as numbers', () => {
    const entries = readZip(buildXlsx([['Name', 'Qty'],['Mchele', 12]]));
    const sheet = entries.find((entry) => entry.name === 'xl/worksheets/sheet1.xml');
    const xml = sheet?.content.toString('utf8') ?? '';

    assert.match(xml, /<c r="A1" t="inlineStr"><is><t xml:space="preserve">Name<\/t><\/is><\/c>/);
    assert.match(xml, /<c r="B2"><v>12<\/v><\/c>/);
  });

  it('escapes characters that would break the XML', () => {
    const entries = readZip(buildXlsx([["Ng'ombe & <chai>"]]));
    const xml = entries.find((entry) => entry.name === 'xl/worksheets/sheet1.xml')?.content.toString('utf8');

    assert.match(xml ?? '', /Ng&apos;ombe|Ng'ombe/);
    assert.match(xml ?? '', /&amp;/);
    assert.match(xml ?? '', /&lt;chai&gt;/);
    assert.ok(!xml?.includes('<chai>'), 'raw angle brackets must not reach the XML');
  });

  it('addresses columns past Z', () => {
    const wide = Array.from({ length: 28 }, (_value, index) => `c${index}`);
    const xml = readZip(buildXlsx([wide])).find(
      (entry) => entry.name === 'xl/worksheets/sheet1.xml',
    )?.content.toString('utf8');

    assert.match(xml ?? '', /r="AA1"/);
    assert.match(xml ?? '', /r="AB1"/);
  });

  it('skips empty cells without leaving gaps', () => {
    const xml = readZip(buildXlsx([['a', '', 'b']])).find(
      (entry) => entry.name === 'xl/worksheets/sheet1.xml',
    )?.content.toString('utf8');

    assert.match(xml ?? '', /r="A1"/);
    assert.ok(!xml?.includes('r="B1"'), 'an empty cell should not be emitted');
    assert.match(xml ?? '', /r="C1"/);
  });

  it('checksums deterministically', () => {
    const rows = [['a', 1]];
    assert.equal(xlsxChecksum(buildXlsx(rows)), xlsxChecksum(buildXlsx(rows)));
    assert.notEqual(xlsxChecksum(buildXlsx(rows)), xlsxChecksum(buildXlsx([['b', 1]])));
  });
});
