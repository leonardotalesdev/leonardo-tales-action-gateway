import { createHash } from 'node:crypto';
export const legacyDigestVersion = 'legacy-v0.1';
export const currentDigestVersion = 'utf16-v1';
// Operation input, proposal, scope/definition/policy bindings, approval IDs and
// digests, and execution identities follow the persisted operation version.
// Allowance and attempt evidence carry that same version. Local-record v0.1
// checksums use the legacy hash, and v0.2 checksums always use utf16-v1.
// Manifest equality uses its validated contents. The historical scope ID still
// hashes the manifest with the operation's original contract.
// Scalar project/Task/Run/operation IDs, paths and approval decision IDs keep
// their bytes, as do audit event IDs over flat arrays of primitives. Task/Run
// validation and audit event/chain hashing use their own deterministic codecs.
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function sortJsonValue(value, compare) {
    if (Array.isArray(value)) {
        return value.map((item) => sortJsonValue(item, compare));
    }
    if (!isRecord(value)) {
        return value;
    }
    return Object.fromEntries(Object.keys(value).sort(compare).map((key) => [key, sortJsonValue(value[key], compare)]));
}
function checksum(payload, compare) {
    if (typeof payload === 'undefined') {
        throw new Error('File memory payload is required.');
    }
    const json = JSON.stringify(payload);
    const sorted = sortJsonValue(json === undefined ? null : JSON.parse(json), compare);
    return createHash('sha256').update(JSON.stringify(sorted), 'utf8').digest('hex');
}
/**
 * utf16-v1: SHA-256 of compact UTF-8 JSON. Round-trip through JSON first,
 * preserve array order, and sort object keys by UTF-16 code units. JSON.stringify
 * emits array-index keys first in numeric order. Strings retain their original
 * code units and JSON numbers normalize signed zero.
 */
export function computeSnapshotChecksum(payload) {
    return checksum(payload);
}
/** v0.1.0 used the default Node/ICU localeCompare ordering with stable ties. */
export function createLegacySnapshotChecksum(locale) {
    if (locale !== undefined && (typeof locale !== 'string' || Intl.Collator.supportedLocalesOf(locale).length !== 1)) {
        throw new Error('unsupported-legacy-digest-locale');
    }
    const { compare } = new Intl.Collator(locale);
    return (payload) => checksum(payload, compare);
}
