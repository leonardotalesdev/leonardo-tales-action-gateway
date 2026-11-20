import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { computeSnapshotChecksum } from '../dist/internal/digest.js'
import { inLocale, workspace } from './fixture.mjs'

const digestUrl = new URL('../dist/internal/digest.js', import.meta.url).href
const gatewayUrl = new URL('../dist/index.js', import.meta.url).href
const fixtureUrl = new URL('./fixture.mjs', import.meta.url).href
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

test('v0.1.0 sorts Unicode keys differently in verified English and Swedish ICU collations', () => {
  const source = `
    import { createLegacySnapshotChecksum } from ${JSON.stringify(digestUrl)}
    console.log(JSON.stringify({
      locale: new Intl.Collator().resolvedOptions().locale,
      order: 'z'.localeCompare('ö'),
      checksum: createLegacySnapshotChecksum()({ z: 1, ö: 2 }),
      nested: createLegacySnapshotChecksum()({ items: [{ 10: 'ten', 2: 'two', z: -0, ö: 2 }] }),
    }))
  `
  assert.deepEqual(inLocale('en-US', source), {
    locale: 'en-US', order: 1, checksum: sha256('{"ö":2,"z":1}'),
    nested: sha256('{"items":[{"2":"two","10":"ten","ö":2,"z":0}]}'),
  })
  assert.deepEqual(inLocale('sv-SE', source), {
    locale: 'sv-SE', order: -1, checksum: sha256('{"z":1,"ö":2}'),
    nested: sha256('{"items":[{"2":"two","10":"ten","z":0,"ö":2}]}'),
  })
})

test('utf16-v1 hashes exact JSON bytes with numerical array indexes and UTF-16 ordering elsewhere', () => {
  const input = {
    ö: 2, z: 1, '\ue000': 4, '\u{10000}': 3, 10: 'ten', 2: 'two', 4294967294: 'max index',
    '01': 'ordinary', 4294967295: 'ordinary',
    nested: [{ é: 4, z: -0, ö: 2, 'e\u0301': 3 }, [true, false, null, 'Å', 1.25]],
  }
  const expected = sha256('{"2":"two","10":"ten","4294967294":"max index","01":"ordinary","4294967295":"ordinary",'
    + '"nested":[{"e\u0301":3,"z":0,"é":4,"ö":2},[true,false,null,"Å",1.25]],"z":1,"ö":2,"\u{10000}":3,"\ue000":4}')
  const source = `
    import { computeSnapshotChecksum } from ${JSON.stringify(digestUrl)}
    console.log(JSON.stringify([new Intl.Collator().resolvedOptions().locale, computeSnapshotChecksum(${JSON.stringify(input)})]))
  `
  assert.deepEqual(inLocale('en-US', source), ['en-US', expected])
  assert.deepEqual(inLocale('sv-SE', source), ['sv-SE', expected])
  assert.equal(computeSnapshotChecksum(input), expected)
  assert.equal(computeSnapshotChecksum(Object.fromEntries(Object.entries(input).reverse())), expected)
  assert.notEqual(computeSnapshotChecksum({ ...input, nested: input.nested.toReversed() }), expected)
})

test('utf16-v1 preserves JSON primitive bytes and normalizes signed zero', () => {
  for (const [value, bytes] of [[null, 'null'], [true, 'true'], [false, 'false'],
    ['Å\n', '"Å\\n"'], [12.5, '12.5'], [-0, '0'], [0, '0']]) {
    assert.equal(computeSnapshotChecksum(value), sha256(bytes))
  }
})

test('new Gateway requests match across collations and resume unchanged after a locale change', async (t) => {
  const english = await workspace(t)
  const swedish = await workspace(t)
  function execute(locale, directory, resolution) {
    const source = `
      import { createActionGateway } from ${JSON.stringify(gatewayUrl)}
      import { config, first, legacyIntent } from ${JSON.stringify(fixtureUrl)}
      let review
      const gateway = await createActionGateway({
        ...config(${JSON.stringify(directory)}),
        async review(request) { review = request; return ${JSON.stringify(resolution)} },
      })
      const receipt = await gateway.execute(legacyIntent(first))
      console.log(JSON.stringify({ locale: new Intl.Collator().resolvedOptions().locale, review, receipt }))
    `
    const { locale: actual, ...result } = inLocale(locale, source)
    assert.equal(actual, locale)
    return result
  }
  const initial = execute('en-US', english, 'PENDING')
  assert.equal(initial.receipt.decision, 'APPROVAL_REQUIRED')
  assert.deepEqual(execute('sv-SE', swedish, 'PENDING'), initial)
  const resumed = execute('sv-SE', english, 'APPROVED')
  assert.equal(resumed.receipt.decision, 'EXECUTED')
  assert.equal(resumed.receipt.inputDigest, initial.receipt.inputDigest)
  assert.equal(resumed.receipt.proposalDigest, initial.receipt.proposalDigest)
  assert.deepEqual(resumed.review, initial.review)
})
