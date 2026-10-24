const MAX_INVOICE_BYTES = 5 * 1024 * 1024

export function parseInvoiceMultipart(body, contentType) {
  const boundary = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)?.slice(1).find(Boolean)?.trim()
  if (!boundary || boundary.length > 200) throw httpError(400, 'Invalid multipart boundary')
  const delimiter = Buffer.from(`--${boundary}`)
  const fields = Object.create(null)
  let invoice = null
  let cursor = body.indexOf(delimiter)
  if (cursor < 0) throw httpError(400, 'Invalid multipart body')

  while (cursor >= 0) {
    cursor += delimiter.length
    if (body.subarray(cursor, cursor + 2).toString() === '--') break
    if (body.subarray(cursor, cursor + 2).toString() !== '\r\n') throw httpError(400, 'Invalid multipart body')
    cursor += 2
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), cursor)
    if (headerEnd < 0) throw httpError(400, 'Invalid multipart headers')
    const headers = body.subarray(cursor, headerEnd).toString('latin1')
    const next = body.indexOf(delimiter, headerEnd + 4)
    if (next < 0) throw httpError(400, 'Incomplete multipart body')
    let dataEnd = next
    if (body.subarray(dataEnd - 2, dataEnd).toString() === '\r\n') dataEnd -= 2
    const data = body.subarray(headerEnd + 4, dataEnd)
    const disposition = /content-disposition:\s*form-data;([^\r\n]+)/i.exec(headers)?.[1]
    const fieldName = /(?:^|;)\s*name="([^"]+)"/i.exec(disposition ?? '')?.[1]
    const filename = /(?:^|;)\s*filename="([^"]*)"/i.exec(disposition ?? '')?.[1]
    if (!fieldName) throw httpError(400, 'Invalid multipart field')
    if (filename !== undefined) {
      if (fieldName !== 'invoice' || invoice) throw httpError(400, 'Provide exactly one invoice file')
      if (data.length > MAX_INVOICE_BYTES) throw httpError(413, 'Invoice exceeds the 5 MB limit')
      invoice = {
        originalName: filename,
        declaredType: /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim().toLowerCase() ?? 'application/octet-stream',
        data: Buffer.from(data),
      }
    } else {
      if (Object.hasOwn(fields, fieldName)) throw httpError(400, `Duplicate field: ${fieldName}`)
      fields[fieldName] = data.toString('utf8')
    }
    cursor = next
  }
  return { fields, invoice }
}

export function detectInvoiceType(invoice) {
  if (!invoice?.data?.length) throw httpError(400, 'Invoice file is required')
  if (invoice.data.length > MAX_INVOICE_BYTES) throw httpError(413, 'Invoice exceeds the 5 MB limit')
  const signatures = [
    { type: 'application/pdf', extension: '.pdf', matches: () => invoice.data.subarray(0, 5).toString() === '%PDF-' },
    { type: 'image/jpeg', extension: '.jpg', matches: () => invoice.data[0] === 0xff && invoice.data[1] === 0xd8 && invoice.data.at(-2) === 0xff && invoice.data.at(-1) === 0xd9 },
    { type: 'image/png', extension: '.png', matches: () => invoice.data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  ]
  const detected = signatures.find((signature) => signature.matches())
  if (!detected || invoice.declaredType !== detected.type) throw httpError(400, 'Invoice must be a valid PDF, JPEG or PNG file')
  return detected
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status })
}
