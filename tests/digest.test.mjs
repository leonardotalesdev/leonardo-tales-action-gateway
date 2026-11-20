import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { computeSnapshotChecksum, createLegacySnapshotChecksum } from '../dist/internal/digest.js'
import { openLocalRecordStore } from '../dist/internal/local-store.js'
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

test('utf16-v1 rejects unsupported values before JSON serialization', () => {
  const accessor = () => assert.fail('accessors must not be invoked')
  const cyclic = {}
  cyclic.child = cyclic
  const cases = [
    ['undefined property', { a: undefined }],
    ['NaN', NaN],
    ['undefined', undefined],
    ['Infinity', Infinity],
    ['negative Infinity', -Infinity],
    ['BigInt', 1n],
    ['function', () => null],
    ['symbol value', Symbol('value')],
    ['symbol key', { [Symbol('key')]: null }],
    ['Date', new Date(0)],
    ['Map', new Map()],
    ['sparse array', Array(1)],
    ['extra array property', Object.assign([null], { extra: true })],
    ['object getter', { get a() { return accessor() } }],
    ['array getter', Object.defineProperty([null], '0', { get: accessor })],
    ['toJSON hook', { toJSON: accessor }],
    ['own __proto__ key', { ['__proto__']: null }],
    ['constructor key', { constructor: null }],
    ['prototype key', { prototype: null }],
    ['custom prototype', Object.create({ a: 1 })],
    ['cyclic object', cyclic],
    ['depth limit', Array.from({ length: 33 }).reduce((child) => ({ child }), null)],
    ['array length limit', Array(50_001).fill(null)],
    ['node limit', [Array(50_000).fill(null), Array(50_000).fill(null)]],
    ['string length limit', 'a'.repeat(16 * 1024 * 1024 + 1)],
  ]
  for (const [name, input] of cases) {
    assert.throws(() => computeSnapshotChecksum(input), { code: 'invalid-record' }, name)
  }
})

test('record envelope hashing preserves existing depth and node limits for record payloads', async (t) => {
  const directory = await workspace(t)
  const projectId = 'project-digest-bounds'
  const store = await openLocalRecordStore(directory, projectId)
  // Including the outer array, this reaches depth 32 and contains 100,000 nodes.
  const nested = Array.from({ length: 31 }).reduce((child) => [child], null)
  const payload = [nested, Array(50_000).fill(null), Array(49_965).fill(null)]
  const record = { kind: 'tasks', id: 'task-digest-bounds', projectId, revision: 1, payload }
  await store.create(record)
  assert.deepEqual(await store.read(record.kind, record.id), { ...record, digestVersion: 'utf16-v1' })
})

test('legacy digest retains v0.1.0 JSON coercions', () => {
  const checksum = createLegacySnapshotChecksum('en-US')
  assert.equal(checksum({ a: undefined }), sha256('{}'))
  assert.equal(checksum(NaN), sha256('null'))
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
