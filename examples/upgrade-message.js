// Demonstrates protobuf.upgradeMessage: promoting unknown wire fields of a
// message decoded with an old schema to accessible fields of a new schema.
//
// Run with: node examples/upgrade-message.js

/* eslint-disable no-console */
"use strict";

var protobuf = require("..");

var root = protobuf.loadSync("tests/data/upgrade.proto");

var OuterV1      = root.lookupType("upgrade.OuterV1"),
    OuterV2Keep  = root.lookupType("upgrade.OuterV2Keep"),
    OuterBadType = root.lookupType("upgrade.OuterBadType");

// 1. A new-schema writer emits fields the old schema does not know about.
var wire = OuterV2Keep.encode({
    known: 5,
    inner: { known: 2, future: "nested", vals: [ 7, 8 ] },
    nums: [ 1, 2, 3 ],
    renamed: "r",
    added: "z"
}).finish();

// 2. An old-schema reader decodes it, preserving unknown wire fields.
var reader = protobuf.Reader.create(wire);
reader.discardUnknown = false;
var oldMessage = OuterV1.decode(reader);

console.log("before upgrade (decoded with OuterV1):");
console.log("  fields:  " + JSON.stringify(OuterV1.toObject(oldMessage)));
console.log("  unknown: " + oldMessage.$unknowns.length + " raw wire field(s) retained");

// 3. Upgrade: unknown wire fields become accessible fields of the new schema.
var upgraded = protobuf.upgradeMessage(OuterV1, OuterV2Keep, oldMessage);

console.log("after upgrade (upgraded to OuterV2Keep):");
console.log("  fields:  " + JSON.stringify(OuterV2Keep.toObject(upgraded)));
console.log("  nested:  " + JSON.stringify(upgraded.inner));
console.log("  unknown: " + (upgraded.$unknowns ? upgraded.$unknowns.length : 0) + " raw wire field(s) retained");

// 4. Incompatible schemas are rejected as a whole.
try {
    protobuf.upgradeMessage(OuterV1, OuterBadType, oldMessage);
    console.log("incompatible schema was NOT rejected (unexpected)");
} catch (e) {
    console.log("incompatible schema rejected: " + e.message);
}
