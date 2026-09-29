"use strict";

var tape = require("tape");

var protobuf = require("..");

var root = protobuf.loadSync("tests/data/upgrade.proto").resolveAll();

var V1                = root.lookupType("upgrade.V1"),
    V2                = root.lookupType("upgrade.V2"),
    V2TypeConflict    = root.lookupType("upgrade.V2TypeConflict"),
    V2RepeatedConflict = root.lookupType("upgrade.V2RepeatedConflict"),
    V2OneofConflict   = root.lookupType("upgrade.V2OneofConflict");

function decodePreserving(type, buffer) {
    var reader = protobuf.Reader.create(buffer);
    reader.discardUnknown = false;
    return type.decode(reader);
}

function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

// V2 wire payload with a repeated field (packed and unpacked segments mixed),
// a map, a duplicated singular scalar, a oneof successor and a field that
// remains unknown to both schemas.
function mixedPayload() {
    return protobuf.Writer.create()
        .uint32(8).int32(42)                            // known = 42
        .uint32(18).string("renamed")                   // old_name / new_name
        .uint32(26).fork()                              // inner
            .uint32(8).int32(7)                         // inner.known
            .uint32(18).string("nested-new")            // inner.future (unknown to InnerV1)
        .ldelim()
        .uint32(34).string("first")                     // pick.text
        .uint32(40).bool(true)                          // pick.flag (unknown to V1, wins the oneof)
        .uint32(50).fork().sint32(1).sint32(2).ldelim() // nums, packed [1, 2]
        .uint32(48).sint32(3)                           // nums, unpacked 3
        .uint32(50).fork().sint32(4).sint32(5).ldelim() // nums, packed [4, 5]
        .uint32(58).fork()                              // counts
            .uint32(10).string("a").uint32(16).int32(3)
        .ldelim()
        .uint32(66).bytes(new Uint8Array([ 1, 2, 3 ]))  // blob
        .uint32(66).bytes(new Uint8Array([ 4, 5 ]))     // blob, last value wins
        .uint32(72).int32(1)                            // level
        .uint32(72).int32(9)                            // level, last value wins
        .uint32(802).string("mystery")                  // field 100, unknown to V1 and V2
        .finish();
}

tape.test("upgradeMessage - promotes unknown fields to a new schema", function(test) {
    var payload = mixedPayload();
    var decoded = decodePreserving(V1, payload);

    test.equal(decoded.known, 42, "should decode known fields with the old type");
    test.equal(decoded.$unknowns.length, 10, "should preserve unknown fields");

    var upgraded = protobuf.upgradeMessage(V1, V2, decoded);

    test.equal(upgraded.known, 42, "should keep known fields");
    test.equal(upgraded.newName, "renamed", "should expose renamed fields under the new name");
    test.equal(hasOwn(upgraded, "oldName"), false, "should not expose the old field name");
    test.deepEqual(upgraded.nums, [ 1, 2, 3, 4, 5 ], "should merge packed and unpacked repeated values");
    test.deepEqual(upgraded.counts, { a: 3 }, "should promote map fields");
    test.deepEqual(upgraded.blob, new Uint8Array([ 4, 5 ]), "should apply last-value-wins for singular scalars");
    test.equal(upgraded.level, 9, "should apply last-value-wins for repeated varint occurrences");
    test.equal(upgraded.flag, true, "should promote oneof successors");
    test.equal(hasOwn(upgraded, "text"), false, "should clear oneof members superseded on the wire");
    test.equal(upgraded.pick, "flag", "should update the oneof discriminator");
    test.equal(upgraded.inner.known, 7, "should keep known nested fields");
    test.equal(upgraded.inner.future, "nested-new", "should recursively upgrade nested messages");
    test.equal(upgraded.$unknowns.length, 1, "should retain still-unknown fields");
    test.deepEqual(Array.prototype.slice.call(upgraded.$unknowns[0]), [ 0xA2, 0x06, 0x07, 0x6d, 0x79, 0x73, 0x74, 0x65, 0x72, 0x79 ], "should keep raw unknown bytes");

    var reencoded = V2.encode(upgraded).finish();
    var roundtrip = decodePreserving(V2, reencoded);
    test.equal(roundtrip.newName, "renamed", "should re-decode renamed fields");
    test.deepEqual(roundtrip.nums, [ 1, 2, 3, 4, 5 ], "should re-decode all repeated elements");
    test.deepEqual(roundtrip.counts, { a: 3 }, "should re-decode map fields");
    test.deepEqual(roundtrip.blob, new Uint8Array([ 4, 5 ]), "should re-decode scalar fields");
    test.equal(roundtrip.level, 9, "should re-decode last-value-wins scalars");
    test.equal(roundtrip.flag, true, "should re-decode oneof successors");
    test.equal(roundtrip.inner.future, "nested-new", "should re-decode nested promotions");
    test.equal(roundtrip.$unknowns.length, 1, "should preserve still-unknown fields through re-encoding");
    test.deepEqual(Array.prototype.slice.call(roundtrip.$unknowns[0]), [ 0xA2, 0x06, 0x07, 0x6d, 0x79, 0x73, 0x74, 0x65, 0x72, 0x79 ], "should keep the exact unknown field bytes");
    test.end();
});

tape.test("upgradeMessage - does not modify the old message or share mutable bytes", function(test) {
    var payload = mixedPayload();
    var decoded = decodePreserving(V1, payload);
    var unknownCount = decoded.$unknowns.length;
    var innerUnknownCount = decoded.inner.$unknowns.length;
    var firstUnknown = Array.prototype.slice.call(decoded.$unknowns[0]);
    var blobUnknown = decoded.$unknowns[6]; // second blob occurrence: [ 0x42, 0x02, 0x04, 0x05 ]

    var upgraded = protobuf.upgradeMessage(V1, V2, decoded);

    test.equal(decoded.$unknowns.length, unknownCount, "should keep the old message unknown fields");
    test.equal(decoded.inner.$unknowns.length, innerUnknownCount, "should keep nested unknown fields");
    test.equal(hasOwn(decoded, "nums"), false, "should not add promoted fields to the old message");
    test.deepEqual(Array.prototype.slice.call(decoded.$unknowns[0]), firstUnknown, "should not alter unknown bytes");

    upgraded.blob[0] = 99;
    upgraded.$unknowns[0][upgraded.$unknowns[0].length - 1] = 88;
    test.notEqual(decoded.$unknowns[decoded.$unknowns.length - 1][9], 88, "should not share remaining unknown bytes with the old message");
    test.deepEqual(Array.prototype.slice.call(blobUnknown), [ 0x42, 0x02, 0x04, 0x05 ], "should not share promoted bytes with the old message");
    test.equal(payload[payload.length - 1], 0x79, "should not share remaining bytes with the source buffer");
    test.end();
});

tape.test("upgradeMessage - rejects incompatible schemas as a whole", function(test) {
    var decoded = decodePreserving(V1, mixedPayload());

    test.throws(function() {
        protobuf.upgradeMessage(V1, V2TypeConflict, decoded);
    }, /incompatible field #1.*type changed/, "should reject changed scalar types");

    test.throws(function() {
        protobuf.upgradeMessage(V1, V2RepeatedConflict, decoded);
    }, /incompatible field #2.*repeated rule changed/, "should reject changed repeated rules");

    test.throws(function() {
        protobuf.upgradeMessage(V1, V2OneofConflict, decoded);
    }, /incompatible field #2.*oneof membership changed/, "should reject changed oneof membership");

    test.equal(decoded.$unknowns.length, 10, "should leave the old message untouched after rejection");
    test.end();
});

tape.test("upgradeMessage - reports corrupt unknown fields with field number and offset", function(test) {
    test.throws(function() {
        protobuf.upgradeMessage(V1, V2, { known: 1, $unknowns: [ new Uint8Array([ 0x08, 0x80 ]) ] });
    }, /invalid unknown field #1 at offset 2 in \$unknowns\[0\]/, "should report a truncated varint value");

    test.throws(function() {
        protobuf.upgradeMessage(V1, V2, { known: 1, $unknowns: [ new Uint8Array([ 0x80 ]) ] });
    }, /invalid unknown field at offset 1 in \$unknowns\[0\]/, "should report a truncated tag varint");

    test.throws(function() {
        protobuf.upgradeMessage(V1, V2, { known: 1, $unknowns: [ new Uint8Array([ 0x00 ]) ] });
    }, /invalid unknown field at offset 1.*field number 0/, "should report an illegal zero field number");

    test.throws(function() {
        protobuf.upgradeMessage(V1, V2, { known: 1, $unknowns: [ new Uint8Array([ 0x32, 0x05, 0x01 ]) ] });
    }, /invalid unknown field #6 at offset/, "should report a truncated packed segment");

    test.end();
});

tape.test("upgradeMessage - validates its arguments", function(test) {
    var decoded = decodePreserving(V1, mixedPayload());
    test.throws(function() {
        protobuf.upgradeMessage(null, V2, decoded);
    }, /oldType must be a Type/, "should require an old type");
    test.throws(function() {
        protobuf.upgradeMessage(V1, null, decoded);
    }, /newType must be a Type/, "should require a new type");
    test.throws(function() {
        protobuf.upgradeMessage(V1, V2, null);
    }, /message must be an object/, "should require a message");
    test.end();
});
