// Demonstrates protobuf.upgradeMessage: promoting unknown wire fields of a
// message decoded with an old schema to a new schema, and rejecting
// incompatible schema pairs.
//
// Run with: node examples/upgrade-message.js

"use strict";

var protobuf = require("..");

var proto = "syntax = \"proto3\";\n"
    + "message PersonV1 {\n"
    + "  int32 id = 1;\n"
    + "  string name = 2;\n"
    + "}\n"
    + "message PersonV2 {\n"
    + "  int32 id = 1;\n"
    + "  string full_name = 2;" // renamed, same id and wire semantics
    + "  repeated string emails = 3;\n"
    + "  int32 age = 4;\n"
    + "}\n"
    + "message PersonV2Incompatible {\n"
    + "  int64 id = 1;" // same id, different wire type
    + "}\n";

var root = protobuf.parse(proto).root,
    PersonV1 = root.lookupType("PersonV1"),
    PersonV2 = root.lookupType("PersonV2"),
    PersonV2Incompatible = root.lookupType("PersonV2Incompatible");

// A payload written with the new schema...
var payload = PersonV2.encode({
    id: 7,
    fullName: "Ada",
    emails: [ "ada@example.com", "countess@example.com" ],
    age: 36
}).finish();

// ...but decoded with the old schema, preserving unknown fields.
var reader = protobuf.Reader.create(payload);
reader.discardUnknown = false;
var legacy = PersonV1.decode(reader);

console.log("before upgrade (PersonV1):");
console.log("  id:          ", legacy.id);
console.log("  name:        ", legacy.name);
console.log("  $unknowns:   ", legacy.$unknowns.length, "raw field(s) not understood by PersonV1");

// Upgrade: unknown wire fields become accessible under the new schema.
var upgraded = protobuf.upgradeMessage(PersonV1, PersonV2, legacy);

console.log("after upgrade (PersonV2):");
console.log("  id:          ", upgraded.id);
console.log("  fullName:    ", upgraded.fullName, "(renamed from 'name', matched by field id)");
console.log("  emails:      ", upgraded.emails);
console.log("  age:         ", upgraded.age);
console.log("  $unknowns:   ", upgraded.$unknowns === undefined ? "none left" : upgraded.$unknowns);
console.log("  legacy untouched:", legacy.$unknowns.length, "unknown field(s) still on the old message");

// Incompatible schemas are rejected as a whole.
try {
    protobuf.upgradeMessage(PersonV1, PersonV2Incompatible, legacy);
    console.log("incompatible upgrade unexpectedly succeeded");
} catch (e) {
    console.log("incompatible schema rejected:", e.message);
}

