"use strict";

var tape = require("tape");

var protobuf = require("..");

var root = protobuf.loadSync("tests/data/upgrade.proto");

var OuterV1      = root.lookupType("upgrade.OuterV1"),
    OuterV2      = root.lookupType("upgrade.OuterV2"),
    OuterV2Keep  = root.lookupType("upgrade.OuterV2Keep"),
    OuterBadType = root.lookupType("upgrade.OuterBadType"),
    OuterBadOneof = root.lookupType("upgrade.OuterBadOneof"),
    OuterBadMap  = root.lookupType("upgrade.OuterBadMap");

function decodePreserving(type, buffer) {
    var reader = protobuf.Reader.create(buffer);
    reader.discardUnknown = false;
    return type.decode(reader);
}

function own(message, name) {
    return Object.hasOwnProperty.call(message, name);
}

tape.test("upgradeMessage - promotes unknown fields and keeps the rest lossless", function(test) {
    var encoded = OuterV2Keep.encode({
        known: 5,
        inner: { known: 2, future: "nested", vals: [ 7, 8 ] },
        pickA: "x",
        counts: { a: 1 },
        nums: [ 1, 2, 3 ],
        renamed: "r",
        added: "z",
        labels: { k: 9 }
    }).finish();
    // a field id no schema knows about (id 100, varint 1)
    var extraUnknown = protobuf.Writer.create().uint32(800).uint32(1).finish();
    var wire = Buffer.concat([ encoded, extraUnknown ]);

    var old = decodePreserving(OuterV1, wire);
    test.equal(old.known, 5, "old schema decodes its known fields");
    test.equal(old.$unknowns.length, 4, "old schema stores unknown wire fields");

    var upgraded = protobuf.upgradeMessage(OuterV1, OuterV2Keep, old);

    test.equal(Number(upgraded.known), 5, "should keep known fields (widened to int64)");
    test.deepEqual(upgraded.nums, [ 1, 2, 3 ], "should promote the new repeated field with all elements");
    test.equal(upgraded.added, "z", "should promote the new scalar field");
    test.equal(upgraded.renamed, "r", "should expose the renamed field under its new name");
    test.notOk(own(upgraded, "legacyName"), "should not keep the old field name");
    test.equal(upgraded.inner.future, "nested", "should recursively upgrade nested messages");
    test.deepEqual(upgraded.inner.vals, [ 7, 8 ], "should recursively promote nested repeated fields");
    test.deepEqual(upgraded.labels, { k: 9 }, "should promote the new map field");
    test.deepEqual(upgraded.counts, { a: 1 }, "should keep known map fields");
    test.equal(upgraded.pickA, "x", "should keep known oneof fields");
    test.equal(upgraded.pick, "pickA", "should keep the oneof discriminator");
    test.equal(upgraded.$unknowns.length, 1, "should keep only still-unknown fields");
    test.deepEqual(Buffer.from(upgraded.$unknowns[0]), Buffer.from(extraUnknown), "should keep still-unknown bytes verbatim");

    // re-encode and re-decode with the new schema to verify wire semantics
    var redecoded = decodePreserving(OuterV2Keep, OuterV2Keep.encode(upgraded).finish());
    test.equal(Number(redecoded.known), 5, "re-decoded known field should match");
    test.deepEqual(redecoded.nums, [ 1, 2, 3 ], "re-decoded repeated field should match");
    test.equal(redecoded.added, "z", "re-decoded scalar field should match");
    test.equal(redecoded.renamed, "r", "re-decoded renamed field should match");
    test.equal(redecoded.inner.future, "nested", "re-decoded nested field should match");
    test.deepEqual(redecoded.inner.vals, [ 7, 8 ], "re-decoded nested repeated field should match");
    test.deepEqual(redecoded.labels, { k: 9 }, "re-decoded map field should match");
    test.equal(redecoded.$unknowns.length, 1, "still-unknown field should survive re-encoding");
    test.deepEqual(Buffer.from(redecoded.$unknowns[0]), Buffer.from(extraUnknown), "still-unknown bytes should survive re-encoding");

    test.end();
});

tape.test("upgradeMessage - merges packed and unpacked repeated fields", function(test) {
    var writer = protobuf.Writer.create();
    writer.uint32(48).uint32(1); // id 6, unpacked varint
    writer.uint32(50).fork().uint32(2).uint32(3).ldelim(); // id 6, packed [2, 3]
    writer.uint32(48).uint32(4); // id 6, unpacked varint

    var old = decodePreserving(OuterV1, writer.finish());
    test.equal(old.$unknowns.length, 3, "should store each wire occurrence");

    var upgraded = protobuf.upgradeMessage(OuterV1, OuterV2Keep, old);
    test.deepEqual(upgraded.nums, [ 1, 2, 3, 4 ], "should merge packed and unpacked occurrences in order");
    test.end();
});

tape.test("upgradeMessage - last value wins for singular scalars", function(test) {
    var writer = protobuf.Writer.create();
    writer.uint32(74).string("first"); // id 9, wire type 2
    writer.uint32(74).string("second");

    var old = decodePreserving(OuterV1, writer.finish());
    var upgraded = protobuf.upgradeMessage(OuterV1, OuterV2Keep, old);
    test.equal(upgraded.added, "second", "should keep the last occurrence");
    test.end();
});

tape.test("upgradeMessage - promotes oneof fields and honors last one wins", function(test) {
    var writer = protobuf.Writer.create();
    writer.uint32(26).string("a"); // id 3 (pick_a), known to the old schema
    writer.uint32(80).uint32(5); // id 10 (pick_c), unknown to the old schema

    var old = decodePreserving(OuterV1, writer.finish());
    test.equal(old.pickA, "a", "old schema decodes its oneof member");

    var upgraded = protobuf.upgradeMessage(OuterV1, OuterV2Keep, old);
    test.equal(upgraded.pickC, 5, "should promote the new oneof member");
    test.equal(upgraded.pick, "pickC", "should point the discriminator at the promoted member");
    test.notOk(own(upgraded, "pickA"), "should clear the previously set oneof member");
    test.end();
});

tape.test("upgradeMessage - renames fields with unchanged id and wire semantics", function(test) {
    var old = decodePreserving(OuterV1, OuterV1.encode({ known: 1, legacyName: "renamed-value", dropped: 7 }).finish());

    var upgraded = protobuf.upgradeMessage(OuterV1, OuterV2, old);
    test.equal(upgraded.renamed, "renamed-value", "should expose id 7 under its new name");
    test.equal(upgraded.dropped2, 7, "should expose id 8 under its new name");
    test.notOk(own(upgraded, "legacyName"), "should not expose the old name of id 7");
    test.notOk(own(upgraded, "dropped"), "should not expose the old name of id 8");
    test.end();
});

tape.test("upgradeMessage - re-encodes removed fields as unknown data", function(test) {
    var old = decodePreserving(OuterV1, OuterV1.encode({ known: 1, dropped: 42 }).finish());

    var upgraded = protobuf.upgradeMessage(OuterV1, OuterV2Keep, old);
    test.notOk(own(upgraded, "dropped"), "should not expose removed fields");
    test.equal(upgraded.$unknowns.length, 1, "should re-encode removed fields as unknown data");

    var roundtrip = decodePreserving(OuterV1, OuterV2Keep.encode(upgraded).finish());
    test.equal(roundtrip.dropped, 42, "should not lose removed field data");
    test.end();
});

tape.test("upgradeMessage - rejects incompatible schemas as a whole", function(test) {
    var old = decodePreserving(OuterV1, OuterV2Keep.encode({ known: 1, nums: [ 1 ], added: "z" }).finish());

    test.throws(function() {
        protobuf.upgradeMessage(OuterV1, OuterBadType, old);
    }, /incompatible field upgrade\.OuterV1\.known \(id 1\): wire type mismatch/, "should reject wire type changes");

    test.throws(function() {
        protobuf.upgradeMessage(OuterV1, OuterBadOneof, old);
    }, /incompatible field upgrade\.OuterV1\.pickA \(id 3\): oneof membership mismatch/, "should reject oneof membership changes");

    test.throws(function() {
        protobuf.upgradeMessage(OuterV1, OuterBadMap, old);
    }, /incompatible field upgrade\.OuterV1\.counts \(id 5\): map mismatch/, "should reject map mismatches");

    test.end();
});

tape.test("upgradeMessage - reports corrupt unknown fields with id and offset", function(test) {
    var old = decodePreserving(OuterV1, OuterV1.encode({ known: 1 }).finish());

    old.$unknowns = [ new Uint8Array([ 0x08, 0xFF ]) ]; // id 1, truncated varint payload
    test.throws(function() {
        protobuf.upgradeMessage(OuterV1, OuterV2Keep, old);
    }, /invalid unknown field 1 at offset 2/, "should report the field id and offset of a bad varint");

    old.$unknowns = [ new Uint8Array([ 0xA0, 0x06, 0xFF ]) ]; // id 100, truncated varint payload
    test.throws(function() {
        protobuf.upgradeMessage(OuterV1, OuterV2Keep, old);
    }, /invalid unknown field 100 at offset 3/, "should report corrupt fields unknown to the new schema");

    old.$unknowns = [ new Uint8Array([ 0xFF ]) ]; // truncated tag
    test.throws(function() {
        protobuf.upgradeMessage(OuterV1, OuterV2Keep, old);
    }, /invalid unknown field at offset/, "should report a corrupt tag");

    test.end();
});

tape.test("upgradeMessage - neither modifies the old message nor shares mutable bytes", function(test) {
    var extraUnknown = protobuf.Writer.create().uint32(800).uint32(1).finish();
    var wire = Buffer.concat([
        OuterV2Keep.encode({
            inner: { known: 1, future: "f" },
            nums: [ 1, 2 ],
            added: "z",
            blob: [ 1, 2, 3 ]
        }).finish(),
        extraUnknown
    ]);
    var old = decodePreserving(OuterV1, wire);
    var oldUnknowns = old.$unknowns.map(function(entry) { return Buffer.from(entry); });
    var oldInnerUnknowns = old.inner.$unknowns.map(function(entry) { return Buffer.from(entry); });
    var oldBlob = Buffer.from(old.blob);

    var upgraded = protobuf.upgradeMessage(OuterV1, OuterV2Keep, old);

    test.deepEqual(old.$unknowns.map(function(entry) { return Buffer.from(entry); }), oldUnknowns, "should not modify old unknown fields");
    test.deepEqual(old.inner.$unknowns.map(function(entry) { return Buffer.from(entry); }), oldInnerUnknowns, "should not modify old nested unknown fields");
    test.notEqual(upgraded.inner, old.inner, "should not share nested messages");

    upgraded.$unknowns[0][0] = 0xFF;
    test.equal(old.$unknowns[old.$unknowns.length - 1][0], 0xA0, "should not share unknown field bytes");

    upgraded.blob[0] = 0xFF;
    test.deepEqual(Buffer.from(old.blob), oldBlob, "should not share bytes field values");

    upgraded.nums.push(99);
    test.deepEqual(upgraded.nums, [ 1, 2, 99 ], "should build fresh repeated arrays");

    test.end();
});
