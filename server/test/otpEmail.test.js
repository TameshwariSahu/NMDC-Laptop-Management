import assert from 'node:assert/strict'
import test from 'node:test'
import { sendLoginOtp } from '../src/services/otpEmail.js'

test('login OTP email has the requested sender, subject, and plain-text and HTML body', async () => {
  const syntheticCode = '731904'
  const deliveries = []
  const fakeTransportFactory = () => ({
    async sendMail(message) { deliveries.push(message) },
  })

  await sendLoginOtp('synthetic.employee@example.invalid', syntheticCode, fakeTransportFactory)

  assert.equal(deliveries.length, 1)
  const [message] = deliveries
  assert.equal(message.subject, 'NMDC Laptop Management System: Login OTP')
  assert.equal(message.from.name, 'NMDC Laptop Management System')
  assert.ok(message.from.address)
  assert.equal(typeof message.text, 'string')
  assert.equal(typeof message.html, 'string')

  const nonBodyFields = Object.entries(message).filter(([field]) => field !== 'text' && field !== 'html')
  assert.equal(nonBodyFields.some(([, value]) => JSON.stringify(value).includes(syntheticCode)), false, 'OTP is absent outside the bodies')
  assert.ok(message.text.includes('Dear Employee,'))
  assert.ok(message.text.includes(syntheticCode))
  assert.ok(message.html.includes(syntheticCode))
  assert.match(message.html, /font-size:\s*30px;\s*font-weight:\s*700/)
  for (const body of [message.text, message.html]) {
    assert.ok(body.includes('valid for 10 minutes'))
    assert.ok(body.includes('can be used only once'))
    assert.ok(body.includes('Do not share it with anyone.'))
    assert.ok(body.includes('ignore this email or contact the administrator'))
    assert.ok(body.includes('NMDC Laptop Management System'))
    assert.equal(body.includes('SAP12345'), false, 'SAP ID is absent from email body')
  }
})
