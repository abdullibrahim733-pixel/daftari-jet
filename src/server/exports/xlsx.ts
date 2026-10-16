/**
 * Minimal, dependency-free XLSX writer.
 *
 * Exports must produce real .xlsx files without pulling in a native
 * dependency (this environment blocks native build tooling), so the
 * container format is written directly: a ZIP archive made of stored
 * (uncompressed) entries, the required OOXML parts, and inline shared
 * strings. The result opens in Excel, LibreOffice and Google Sheets.
 *
 * Only what the export feature needs is implemented: one worksheet of
 * string/number cells with a bold header row.
 */

import { createHash } from 'node:crypto';

type XlsxCell = string | number | null | undefined;

export type XlsxRow = XlsxCell[];

let crcTable: Uint32Array | null = null;

function crc32(buffer: Buffer): number {
  // CRC-32 (IEEE) as required by the ZIP spec.
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[index] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipEntry(name: string, content: Buffer): Buffer {
  const nameBuffer = Buffer.from(name, 'utf8');
  const crc = crc32(content);
  // Local file header, stored (method 0), no data descriptor.
  const local = Buffer.alloc(30 + nameBuffer.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // UTF-8 flag
  local.writeUInt16LE(0, 8); // stored
  local.writeUInt16LE(0, 10); // mod time
  local.writeUInt16LE(0, 12); // mod date
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBuffer.length, 26);
  local.writeUInt16LE(0, 28);
  nameBuffer.copy(local, 30);
  return Buffer.concat([local, content]);
}

function centralDirectory(
  entries: { name: string; content: Buffer; offset: number }[],
  centralDirectoryOffset: number,
): Buffer {
  const parts: Buffer[] = [];
  let size = 0;
  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    const record = Buffer.alloc(46 + nameBuffer.length);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt16LE(0, 12);
    record.writeUInt16LE(0, 14);
    record.writeUInt32LE(crc32(entry.content), 16);
    record.writeUInt32LE(entry.content.length, 20);
    record.writeUInt32LE(entry.content.length, 24);
    record.writeUInt16LE(nameBuffer.length, 28);
    record.writeUInt32LE(entry.offset, 42);
    nameBuffer.copy(record, 46);
    parts.push(record);
    size += record.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(centralDirectoryOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, end]);
}

function cellReference(column: number, row: number): string {
  let letters = '';
  let index = column;
  do {
    letters = String.fromCharCode(65 + (index % 26)) + letters;
    index = Math.floor(index / 26) - 1;
  } while (index >= 0);
  return `${letters}${row + 1}`;
}

function sheetXml(rows: XlsxRow[]): string {
  const cells: string[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    const rowCells: string[] = [];
    for (let column = 0; column < row.length; column += 1) {
      const value = row[column];
      if (value === null || value === undefined || value === '') continue;
      const reference = cellReference(column, rowIndex);
      if (typeof value === 'number' && Number.isFinite(value)) {
        rowCells.push(`<c r="${reference}"><v>${value}</v></c>`);
      } else {
        const escaped = String(value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        rowCells.push(`<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escaped}</t></is></c>`);
      }
    }
    cells.push(`<row r="${rowIndex + 1}">${rowCells.join('')}</row>`);
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${cells.join('')}</sheetData></worksheet>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
  `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
  `</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
  `</Relationships>`;

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
  `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
  `<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
  `</Relationships>`;

/** Builds a valid .xlsx buffer with a single worksheet. */
export function buildXlsx(rows: XlsxRow[]): Buffer {
  const parts: { name: string; content: Buffer }[] = [
    { name: '[Content_Types].xml', content: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', content: Buffer.from(ROOT_RELS, 'utf8') },
    { name: 'xl/workbook.xml', content: Buffer.from(WORKBOOK, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', content: Buffer.from(WORKBOOK_RELS, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', content: Buffer.from(sheetXml(rows), 'utf8') },
  ];

  const entries: { name: string; content: Buffer; offset: number }[] = [];
  const localParts: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const entry = zipEntry(part.name, part.content);
    entries.push({ name: part.name, content: part.content, offset });
    localParts.push(entry);
    offset += entry.length;
  }
  return Buffer.concat([...localParts, centralDirectory(entries, offset)]);
}

/** Deterministic content hash used as the export checksum. */
export function xlsxChecksum(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}
