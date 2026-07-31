import { createHash } from 'node:crypto';

import { MaterialsError } from './materials.errors';
import type { Material, MaterialExport, MaterialExportFormat } from './materials.types';

export function exportMaterial(material: Material, format: MaterialExportFormat): MaterialExport {
  if (material.status !== 'approved' || !material.checks.publishable) {
    throw new MaterialsError(
      'MATERIAL_NOT_PUBLISHABLE',
      'Only approved, publishable material can be exported.',
    );
  }
  const safeBaseName = `${material.kind}-${material.id}-v${material.version}`.replace(
    /[^A-Za-z0-9._-]/gu,
    '-',
  );
  let bytes: Uint8Array;
  let mediaType: MaterialExport['media_type'];
  let extension: string;
  switch (format) {
    case 'text':
      bytes = Buffer.from(material.document.plain_text, 'utf8');
      mediaType = 'text/plain';
      extension = 'txt';
      break;
    case 'docx':
      bytes = createDocx(material.document.plain_text, material.updated_at);
      mediaType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      extension = 'docx';
      break;
    case 'pdf':
      bytes = createPdf(material.document.plain_text);
      mediaType = 'application/pdf';
      extension = 'pdf';
      break;
    default:
      throw new MaterialsError('VALIDATION_FAILED', 'Unsupported material export format.');
  }
  return {
    format,
    media_type: mediaType,
    filename: `${safeBaseName}.${extension}`,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function createDocx(text: string, timestamp: string): Uint8Array {
  const paragraphs = text
    .split('\n')
    .map(
      (line) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line || ' ')}</w:t></w:r></w:p>`,
    );
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${paragraphs.join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>` +
    '<w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body>' +
    '</w:document>';
  const files = [
    {
      name: '[Content_Types].xml',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ' +
        'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" ' +
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ' +
        'Target="word/document.xml"/></Relationships>',
    },
    { name: 'word/document.xml', content: documentXml },
  ];
  return createStoredZip(files, timestamp);
}

function createStoredZip(
  files: readonly { name: string; content: string }[],
  timestamp: string,
): Uint8Array {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  const date = Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp) : new Date(0);
  const { dosDate, dosTime } = toDosDate(date);
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const content = Buffer.from(file.content, 'utf8');
    const crc = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + content.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function createPdf(text: string): Uint8Array {
  const allLines = text.split('\n').flatMap((line) => wrapPdfLine(line, 90));
  const pages = chunk(allLines.length > 0 ? allLines : [''], 52);
  const firstPageObject = 7;
  const pageReferences = pages.map((_, index) => `${firstPageObject + index * 2} 0 R`);
  const toUnicode = createToUnicodeCMap(text);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageReferences.join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type0 /BaseFont /ArialUnicodeMS ' +
      '/Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 6 0 R >>',
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ArialUnicodeMS ' +
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ' +
      '/FontDescriptor 5 0 R /CIDToGIDMap /Identity /DW 1000 >>',
    '<< /Type /FontDescriptor /FontName /ArialUnicodeMS /Flags 32 ' +
      '/FontBBox [0 -250 1200 1000] /ItalicAngle 0 /Ascent 900 /Descent -250 ' +
      '/CapHeight 700 /StemV 80 >>',
    `<< /Length ${Buffer.byteLength(toUnicode, 'ascii')} >>\nstream\n${toUnicode}\nendstream`,
    ...pages.flatMap((lines, index) => {
      const pageObject = firstPageObject + index * 2;
      const contentObject = pageObject + 1;
      const operations = createPdfPageOperations(lines);
      return [
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
          `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObject} 0 R >>`,
        `<< /Length ${Buffer.byteLength(operations, 'ascii')} >>\nstream\n${operations}\nendstream`,
      ];
    }),
  ];
  let body = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'binary'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body, 'binary');
  body += `xref\n0 ${objects.length + 1}\n`;
  body += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) {
    body += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  }
  body +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'binary');
}

function createPdfPageOperations(lines: readonly string[]): string {
  return [
    'BT',
    '/F1 10 Tf',
    '50 742 Td',
    ...lines.flatMap((line, index) =>
      index === 0 ? [`<${toUtf16BeHex(line)}> Tj`] : ['0 -13 Td', `<${toUtf16BeHex(line)}> Tj`],
    ),
    'ET',
  ].join('\n');
}

function createToUnicodeCMap(text: string): string {
  const codeUnits = new Set<number>();
  for (let index = 0; index < text.length; index += 1) codeUnits.add(text.charCodeAt(index));
  const mappings = [...codeUnits]
    .sort((left, right) => left - right)
    .map((code) => {
      const hex = code.toString(16).toUpperCase().padStart(4, '0');
      return `<${hex}> <${hex}>`;
    });
  const groups = chunk(mappings, 100).flatMap((group) => [
    `${group.length} beginbfchar`,
    ...group,
    'endbfchar',
  ]);
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    ...groups,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
}

function wrapPdfLine(line: string, width: number): string[] {
  if (line.length <= width) return [line];
  const lines: string[] = [];
  for (let offset = 0; offset < line.length; offset += width) {
    lines.push(line.slice(offset, offset + width));
  }
  return lines;
}

function toUtf16BeHex(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    result += value.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0');
  }
  return result;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

function toDosDate(date: Date): { dosDate: number; dosTime: number } {
  const year = Math.max(1980, Math.min(2107, date.getUTCFullYear()));
  return {
    dosDate: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
    dosTime:
      (date.getUTCHours() << 11) |
      (date.getUTCMinutes() << 5) |
      Math.floor(date.getUTCSeconds() / 2),
  };
}

function crc32(content: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}
