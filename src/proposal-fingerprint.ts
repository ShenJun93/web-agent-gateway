/**
 * The canonical identity of a queued proposal, computed by WAG from the record WAG holds.
 *
 * ## Why this module exists at all
 *
 * The first cut of Goal UI Delegation took a `proposalFingerprint` and an
 * `expectedProposalFingerprint` from the caller and compared them to each other. A caller that
 * sent the same value twice passed. The check was reached by a test — the test supplied two
 * different values — but it defended nothing against the adversary it named, because both sides
 * of the comparison came from the untrusted side of the boundary.
 *
 * A fingerprint is only worth anything if the party relying on it computed it. So this function
 * is the single place a proposal's identity is derived, it takes the stored record rather than a
 * claim about it, and no delegated path may accept a fingerprint over the wire.
 *
 * ## The encoding
 *
 * Tagged, length-prefixed and total, over a domain-separated, versioned preimage. There is no
 * delimiter anywhere and no string concatenation of caller-controlled values: every scalar
 * carries its own type tag and its own byte length, and every container carries its element
 * count. That is what makes the preimage unambiguous — a reader could parse it back — and a
 * parseable encoding cannot have two tuples sharing a preimage.
 *
 * Object keys are sorted by code unit, so two records differing only in key order encode
 * identically. That is what makes this a *canonical* form rather than a serialization.
 *
 * ## Two measured defects this encoding has already had
 *
 * Both found by review rather than by the tests that claimed to cover them, which is why the
 * adversarial corpus in the test file enumerates tuples rather than hand-picking pairs:
 *
 *  - **Bare concatenation merges a key into a value.** Without the tag and the length, the key
 *    `a` with value `b` and the key `ab` with an empty value are the same bytes.
 *  - **Unpaired surrogates collided.** The length counts UTF-8 bytes and the digest is over
 *    UTF-8, and every unpaired surrogate encodes to the same three bytes as U+FFFD. `"\uD800"`,
 *    `"\uDC00"` and `"�"` produced one identity for three distinct stored rows, and the
 *    distinction survived the JSON round trip into SQLite — so it was reachable from page text,
 *    where `\uD800` is an ordinary JSON escape. Ill-formed strings are now refused.
 */
import { createHash } from 'node:crypto';

/**
 * Domain separation and version, in one string that is itself length-prefixed into the preimage.
 *
 * Anything else in WAG that ever hashes a structure gets its own domain, so a preimage built here
 * can never be mistaken for one built elsewhere. The version moves if the field set or the
 * encoding changes, which makes old and new fingerprints incomparable *by construction* rather
 * than silently equal for some inputs.
 */
export const PROPOSAL_FINGERPRINT_DOMAIN = 'WAG/proposal-fingerprint/v1';

/** What the arguments of a staged proposal may contain, after protocol validation. */
export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

/** Thrown for values with no canonical form. Always a refusal upstream, never a crash. */
export class NonCanonicalValueError extends Error {}

const byteLength = (value: string): number => Buffer.byteLength(value, 'utf8');

/** `s:<utf8 byte length>:<value>` — the one way a string enters a preimage. */
function encodeString(value: string): string {
  // Refused rather than encoded: an unpaired surrogate has no valid UTF-8 form, cannot occur in a
  // well-formed protocol argument, and was a measured collision when it was allowed through.
  if (/\p{Surrogate}/u.test(value)) {
    throw new NonCanonicalValueError('a string contains an unpaired surrogate');
  }
  return `s:${byteLength(value)}:${value}`;
}

function encode(value: unknown, depth: number): string {
  // A bound, so pathological nesting cannot turn identity computation into a stack overflow.
  // The protocol schemas are far shallower than this; exceeding it is a defect, not an input.
  if (depth > 32) throw new NonCanonicalValueError('proposal arguments nest too deeply');

  if (value === null) return 'n:';
  if (typeof value === 'boolean') return value ? 'b:1' : 'b:0';
  if (typeof value === 'number') {
    // NaN and the infinities have no JSON form, so they cannot have arrived through the protocol.
    if (!Number.isFinite(value)) throw new NonCanonicalValueError('a number is not finite');
    // `String(-0)` is "0" already, but normalising explicitly makes the intent legible: negative
    // zero and zero are the same argument and must not be two identities.
    const text = String(value === 0 ? 0 : value);
    return `d:${text.length}:${text}`;
  }
  if (typeof value === 'string') return encodeString(value);
  if (Array.isArray(value)) {
    // A hole is not `undefined` and not an element: `[,1]` has length 2 and one own index, so
    // mapping over it would emit one item under a count of two — an encoding that cannot be
    // parsed back, which is the property the whole design rests on.
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new NonCanonicalValueError('an array has holes');
    }
    return `a:${value.length}:${value.map((item) => encode(item, depth + 1)).join('')}`;
  }
  if (typeof value === 'object') {
    // Plain objects only. `Object.keys` returns nothing for a `Map`, a `Set`, a `Date` or a class
    // instance, so every one of them encoded as `o:0:` — identical to `{}`, and identical to each
    // other. That is the same silent-drop this function refuses for `undefined` and functions,
    // one type-layer up, and a review found it there. Not reachable through `JSON.parse` or the
    // `.strict()` protocol schemas, but an identity function should not depend on its caller.
    const prototype = Object.getPrototypeOf(value as object);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new NonCanonicalValueError('only plain objects have a canonical form');
    }
    // Own enumerable keys only, sorted. `JSON.parse` can produce an own `__proto__` key; it is
    // encoded like any other, because canonical means deterministic, not filtered.
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const body = keys
      .map((key) => encodeString(key) + encode((value as Record<string, unknown>)[key], depth + 1))
      .join('');
    return `o:${keys.length}:${body}`;
  }
  // `undefined`, functions and symbols have no JSON form. Refusing is right: silently dropping a
  // field would let two different proposals share one identity.
  throw new NonCanonicalValueError(`a ${typeof value} has no canonical form`);
}

/**
 * The exact record WAG holds.
 *
 * The session and adapter are part of the identity, not merely checked alongside it: a proposal
 * belongs to one browser context, and the same arguments observed in a different context are a
 * different proposal.
 */
export interface FingerprintableProposal {
  readonly tool: string;
  readonly workspaceId: string;
  readonly origin: string;
  readonly sessionId: string;
  readonly adapterId: string;
  readonly arguments: CanonicalValue;
}

/**
 * The full preimage, exported so tests can assert injectivity over the preimage itself rather
 * than over its digest. Proving the preimages distinct is the stronger statement; it leaves the
 * hash doing only the job a hash is good at.
 */
export function proposalFingerprintPreimage(proposal: FingerprintableProposal): string {
  return encodeString(PROPOSAL_FINGERPRINT_DOMAIN) + encode({
    tool: proposal.tool,
    workspaceId: proposal.workspaceId,
    origin: proposal.origin,
    sessionId: proposal.sessionId,
    adapterId: proposal.adapterId,
    arguments: proposal.arguments,
  }, 0);
}

/**
 * The canonical identity of a proposal.
 *
 * Deterministic over the six fields and dependent on nothing else — not the clock, not the
 * delegation, not who is asking. Injective over the values it *accepts*: ill-formed inputs are
 * refused rather than encoded, which is the only way the claim can be true rather than nearly
 * true.
 */
export function canonicalProposalFingerprint(proposal: FingerprintableProposal): string {
  return `fp_${createHash('sha256').update(proposalFingerprintPreimage(proposal), 'utf8').digest('hex')}`;
}

/** The encoding of one value, exported so tests can assert the shape rather than only hashes. */
export function canonicalEncoding(value: CanonicalValue): string {
  return encode(value, 0);
}
