import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalEncoding,
  canonicalProposalFingerprint,
  NonCanonicalValueError,
  PROPOSAL_FINGERPRINT_DOMAIN,
  proposalFingerprintPreimage,
  type CanonicalValue,
  type FingerprintableProposal,
} from '../src/proposal-fingerprint.js';

/**
 * A fingerprint is only an identity if distinct proposals cannot share one. These tests attack
 * that directly, over the **preimage** rather than the digest: proving the preimages distinct is
 * the stronger statement, and it leaves the hash doing only the job a hash is good at.
 */
const BASE: FingerprintableProposal = {
  tool: 'repo.search',
  workspaceId: 'ws_1',
  origin: 'https://chatgpt.com',
  sessionId: 'session_1',
  adapterId: 'browser.chatgpt.native.operator.v4',
  arguments: { workspace_id: 'ws_1', query: 'needle', max_results: 5 },
};

test('the same proposal has one identity, whatever order its keys arrive in', () => {
  const a = canonicalProposalFingerprint(BASE);
  const b = canonicalProposalFingerprint({
    ...BASE,
    arguments: { max_results: 5, query: 'needle', workspace_id: 'ws_1' },
  });
  assert.equal(a, b, 'key order is serialization, not identity');
  assert.match(a, /^fp_[a-f0-9]{64}$/);
});

test('every field of the tuple is part of the identity', () => {
  const base = canonicalProposalFingerprint(BASE);
  const variants: Array<[string, FingerprintableProposal]> = [
    ['tool', { ...BASE, tool: 'file.read' }],
    ['workspace', { ...BASE, workspaceId: 'ws_2' }],
    ['origin', { ...BASE, origin: 'https://evil.example' }],
    ['session', { ...BASE, sessionId: 'session_2' }],
    ['adapter', { ...BASE, adapterId: 'browser.chatgpt.native.verify.v3' }],
    ['an argument value', { ...BASE, arguments: { ...BASE.arguments as object, query: 'haystack' } }],
    ['an argument key', { ...BASE, arguments: { ...BASE.arguments as object, extra: 1 } }],
    ['a removed argument', { ...BASE, arguments: { query: 'needle', max_results: 5 } }],
  ];
  for (const [what, variant] of variants) {
    assert.notEqual(canonicalProposalFingerprint(variant), base, `${what} must change the identity`);
  }
});

test('no two distinct field tuples share a preimage', () => {
  // The adversarial corpus, rather than hand-picked pairs. Each value is chosen to attack a
  // delimiter or concatenation scheme: empty strings, values that are prefixes of one another,
  // and values that contain the encoding's own tag and separator characters. Every combination
  // across the five string fields is enumerated and every preimage must be unique.
  const values = ['', 'a', 'ab', ':', 's:1:a', 'o:1:', '1:1'];
  const seen = new Map<string, string>();
  let count = 0;
  for (const tool of values) {
    for (const workspaceId of values) {
      for (const origin of values) {
        for (const sessionId of values) {
          for (const adapterId of values) {
            const tuple = { tool, workspaceId, origin, sessionId, adapterId, arguments: null };
            const preimage = proposalFingerprintPreimage(tuple);
            const clash = seen.get(preimage);
            assert.equal(clash, undefined,
              `${JSON.stringify(tuple)} shares a preimage with ${clash}`);
            seen.set(preimage, JSON.stringify(tuple));
            count += 1;
          }
        }
      }
    }
  }
  assert.equal(count, values.length ** 5, 'the whole corpus was enumerated');
  assert.equal(seen.size, count, 'and every preimage was distinct');
});

test('no two distinct argument structures share a preimage', () => {
  const shapes: CanonicalValue[] = [
    null, true, false, 0, 1, -1, 1.5, '', '0', '1', 'a', 'ab',
    {}, [], { a: 'b' }, { ab: '' }, { a: '', b: '' }, { 'a:b': '' }, { a: { b: '' } },
    ['a', 'b'], ['ab'], [['a'], 'b'], [{ a: 'b' }], { a: ['b'] }, { a: 1 }, { a: '1' },
  ];
  const seen = new Map<string, unknown>();
  for (const shape of shapes) {
    const preimage = proposalFingerprintPreimage({ ...BASE, arguments: shape });
    const clash = seen.get(preimage);
    assert.equal(clash, undefined, `${JSON.stringify(shape)} collides with ${JSON.stringify(clash)}`);
    seen.set(preimage, shape);
  }
});

test('a key and a value cannot be confused for one another', () => {
  // Written as bare concatenation, the key `a` with value `b` and the key `ab` with an empty
  // value are the same bytes — one proposal wearing another's identity. The tag and the byte
  // length are what keep them apart.
  assert.notEqual(canonicalEncoding({ a: 'b' }), canonicalEncoding({ ab: '' }));
  assert.notEqual(canonicalEncoding({ x: 'yz' }), canonicalEncoding({ xy: 'z' }));
});

test('the preimage is domain-separated and versioned', () => {
  const preimage = proposalFingerprintPreimage(BASE);
  assert.ok(preimage.startsWith(`s:${Buffer.byteLength(PROPOSAL_FINGERPRINT_DOMAIN)}:${PROPOSAL_FINGERPRINT_DOMAIN}`),
    'the domain leads the preimage, length-prefixed like any other string');
  assert.match(PROPOSAL_FINGERPRINT_DOMAIN, /\/v\d+$/, 'and it carries a version');
  // The domain is part of the hashed bytes, so a structure hashed elsewhere in WAG with the same
  // field values cannot land on the same digest.
  assert.notEqual(
    canonicalProposalFingerprint(BASE).slice(3),
    canonicalEncoding({
      tool: BASE.tool, workspaceId: BASE.workspaceId, origin: BASE.origin,
      sessionId: BASE.sessionId, adapterId: BASE.adapterId, arguments: BASE.arguments,
    }),
  );
});

test('unpaired surrogates are refused rather than hashed', () => {
  // Measured: the length prefix counts UTF-8 bytes and the digest is over UTF-8, so every lone
  // surrogate encoded to the same three bytes as U+FFFD. Three distinct stored rows shared one
  // identity, and the distinction survived the JSON round trip into SQLite — so it was reachable
  // from page text, where `\uD800` is an ordinary JSON escape.
  for (const bad of ['\uD800', '\uDC00', 'a\uD800b', '\uD800\uD800']) {
    assert.throws(
      () => canonicalProposalFingerprint({ ...BASE, arguments: { query: bad } }),
      NonCanonicalValueError,
      JSON.stringify(bad),
    );
    assert.throws(() => canonicalProposalFingerprint({ ...BASE, tool: bad }), NonCanonicalValueError);
    // Including as an object *key*, which is the other place a string enters the preimage.
    assert.throws(
      () => canonicalProposalFingerprint({ ...BASE, arguments: { [bad]: 'v' } }),
      NonCanonicalValueError,
    );
  }
  // Well-formed text, including astral characters that are legitimate surrogate *pairs*, is fine.
  assert.match(canonicalProposalFingerprint({ ...BASE, arguments: { query: '\u{1F600} ok' } }), /^fp_/);
});

test('values with no JSON form are refused rather than dropped', () => {
  // Dropping a field silently would let two different proposals share one identity, which is the
  // precise failure this module exists to prevent.
  for (const bad of [undefined, () => 1, Symbol('s'), Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => canonicalEncoding({ a: bad } as unknown as CanonicalValue),
      NonCanonicalValueError,
      String(bad),
    );
  }
});

test('negative zero is the same argument as zero', () => {
  assert.equal(canonicalEncoding({ a: -0 }), canonicalEncoding({ a: 0 }));
});

test('nesting is bounded, so identity cannot be turned into a stack overflow', () => {
  let deep: CanonicalValue = 1;
  for (let i = 0; i < 40; i += 1) deep = { a: deep };
  assert.throws(() => canonicalEncoding(deep), NonCanonicalValueError);
  let shallow: CanonicalValue = 1;
  for (let i = 0; i < 8; i += 1) shallow = { a: shallow };
  assert.doesNotThrow(() => canonicalEncoding(shallow));
});

test('an own __proto__ key is encoded, not silently skipped', () => {
  const withProto = JSON.parse('{"__proto__": {"a": 1}, "b": 2}') as CanonicalValue;
  const without = JSON.parse('{"b": 2}') as CanonicalValue;
  assert.notEqual(canonicalEncoding(withProto), canonicalEncoding(without));
});

test('a large argument set fingerprints in linear time', () => {
  // A quadratic identity function would be a denial-of-service on the dispatch path.
  const wide: Record<string, string> = {};
  for (let i = 0; i < 2000; i += 1) wide[`k${i}`] = 'v'.repeat(64);
  const started = process.hrtime.bigint();
  canonicalProposalFingerprint({ ...BASE, arguments: wide });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 250, `fingerprinting 2000 keys took ${elapsedMs.toFixed(1)}ms`);
});

test('only plain objects and dense arrays have a canonical form', () => {
  // `Object.keys` returns nothing for a Map, a Set, a Date or a class instance, so every one of
  // them encoded as `o:0:` — identical to `{}` and to each other. That is the same silent drop
  // this module refuses for `undefined` and functions, one type-layer up, and a review found it
  // there. Not reachable through `JSON.parse` or the strict protocol schemas; refused anyway,
  // because an identity function should not depend on its caller to stay injective.
  class Thing { constructor(public a = 1) {} }
  for (const exotic of [
    new Map([[1, 2]]), new Set([1]), new Date(0), new Thing(), Object.create({ inherited: 1 }),
  ]) {
    assert.throws(
      () => canonicalEncoding({ a: exotic } as unknown as CanonicalValue),
      NonCanonicalValueError,
      exotic?.constructor?.name ?? 'exotic',
    );
  }
  // A null-prototype object is still a plain bag of keys and is accepted.
  const bare = Object.assign(Object.create(null), { a: 'b' }) as CanonicalValue;
  assert.equal(canonicalEncoding(bare), canonicalEncoding({ a: 'b' }));

  // A hole is not an element: `[,1]` has length 2 and one own index, so mapping over it would
  // emit one item under a count of two — an encoding that cannot be parsed back.
  const sparse = [1];
  sparse.length = 3;
  assert.throws(() => canonicalEncoding(sparse as CanonicalValue), NonCanonicalValueError);
  assert.doesNotThrow(() => canonicalEncoding([1, null, 2]));
});
