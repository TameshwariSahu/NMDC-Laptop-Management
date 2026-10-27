import { deflateRawSync } from 'node:zlib'

const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const columns = [
  ['SAP ID', 'sapId', 14], ['Employee Name', 'employeeName', 26], ['Designation', 'designation', 20],
  ['Category', 'category', 15], ['Department', 'department', 22],
  ['Serial Number', 'serialNumber', 22], ['Model Number', 'modelNumber', 24], ['MAC Address', 'macAddress', 18],
  ['Operating System', 'operatingSystem', 18], ['Purchase Date', 'purchaseDate', 17],
  ['Windows Key Provided', 'windowsKeyPresent', 21], ['Windows Key Duplicate Check', 'windowsKeyDuplicate', 29],
  ['MS Office Key Provided', 'officeKeyPresent', 23], ['MS Office Key Duplicate Check', 'officeKeyDuplicate', 31],
  ['Status', 'status', 30], ['Latest Remarks', 'latestRemarks', 42],
  ['Created By', 'createdBy', 30], ['Updated By', 'updatedBy', 30],
  ['Created Date', 'createdAt', 17], ['Updated Date', 'updatedAt', 17],
]

const crcTable = new Uint32Array(256)
for (let n = 0; n < 256; n += 1) {
  let value = n
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1
  crcTable[n] = value >>> 0
}

function crc32(buffer) {
  let crc = 0xFFFFFFFF
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function safeText(value) {
  const text = String(value ?? '')
  return /^[=+\-@]/.test(text) ? `'${text}` : text
}

function formatDate(value) {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric',
  }).format(date)
}

function cellReference(column, row) {
  let value = column + 1, letters = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    letters = String.fromCharCode(65 + remainder) + letters
    value = Math.floor((value - 1) / 26)
  }
  return `${letters}${row}`
}

function textCell(reference, value, style = 0) {
  const text = escapeXml(safeText(value))
  return `<c r="${reference}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`
}

function cellValue(row, field) {
  if (field === 'purchaseDate' || field === 'createdAt' || field === 'updatedAt') return formatDate(row[field])
  if (['windowsKeyPresent', 'officeKeyPresent', 'legacyKeyPresent'].includes(field)) return row[field] ? 'Yes' : 'No'
  if (['windowsKeyDuplicate', 'officeKeyDuplicate'].includes(field)) return row[field] ? 'Duplicate match' : 'No duplicate match'
  if (field === 'status') return ({
    PENDING_ENGINEER: 'Pending Engineer', NEEDS_EMPLOYEE_CORRECTION: 'Needs Employee Correction',
    PENDING_ADMIN: 'Pending Admin', NEEDS_ENGINEER_CORRECTION: 'Needs Engineer Correction', APPROVED: 'Approved',
  })[row.status] ?? row.status ?? ''
  return row[field] ?? ''
}

function worksheetXml(rows) {
  const activeColumns = rows.some((row) => row.legacyKeyPresent)
    ? [...columns.slice(0, 14), ['Legacy Key', 'legacyKeyPresent', 16], ...columns.slice(14)]
    : columns
  const values = [activeColumns.map(([heading]) => heading), ...rows.map((row) => activeColumns.map(([, field]) => cellValue(row, field)))]
  const sheetRows = values.map((row, rowIndex) => {
    const rowNumber = rowIndex + 1
    const cells = row.map((value, columnIndex) => textCell(cellReference(columnIndex, rowNumber), value, rowIndex === 0 ? 1 : 0)).join('')
    return `<row r="${rowNumber}"${rowIndex === 0 ? ' ht="28" customHeight="1"' : ''}>${cells}</row>`
  }).join('')
  const widths = activeColumns.map(([, , width], index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths}</cols><sheetData>${sheetRows}</sheetData></worksheet>`
}

function zip(entries) {
  const localParts = [], centralParts = []
  let offset = 0
  for (const [name, content] of Object.entries(entries)) {
    const filename = Buffer.from(name, 'utf8')
    const data = Buffer.from(content, 'utf8')
    const compressed = deflateRawSync(data)
    const checksum = crc32(data)
    const local = Buffer.alloc(30 + filename.length)
    local.writeUInt32LE(0x04034B50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(filename.length, 26)
    local.writeUInt16LE(0, 28)
    filename.copy(local, 30)
    localParts.push(local, compressed)

    const central = Buffer.alloc(46 + filename.length)
    central.writeUInt32LE(0x02014B50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(filename.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    filename.copy(central, 46)
    centralParts.push(central)
    offset += local.length + compressed.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054B50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(centralParts.length, 8)
  end.writeUInt16LE(centralParts.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, centralDirectory, end])
}

export function createReportWorkbook(rows) {
  if (!Array.isArray(rows)) throw new TypeError('Report rows must be an array')
  return zip({
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Report" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    'xl/worksheets/sheet1.xml': worksheetXml(rows),
  })
}

export { XLSX_MIME_TYPE }
