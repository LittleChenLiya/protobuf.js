"use strict";

var tape = require("tape");

var protobuf = require("..");

var def = {
    nested: {
        Inner: {
            fields: {
                counts: {
                    keyType: "int64",
                    type: "string",
                    id: 1
                }
            }
        },
        Test: {
            oneofs: {
                choice: {
                    oneof: ["str", "num"]
                }
            },
            fields: {
                byLong: {
                    keyType: "int64",
                    type: "int32",
                    id: 1
                },
                byUlong: {
                    keyType: "uint64",
                    type: "string",
                    id: 2
                },
                byString: {
                    keyType: "string",
                    type: "Inner",
                    id: 3
                },
                byBool: {
                    keyType: "bool",
                    type: "int32",
                    id: 4
                },
                bySint: {
                    keyType: "sint32",
                    type: "string",
                    id: 5
                },
                nums: {
                    rule: "repeated",
                    type: "int32",
                    id: 6
                },
                str: {
                    type: "string",
                    id: 7
                },
                num: {
                    type: "int32",
                    id: 8
                },
                nested: {
                    type: "Inner",
                    id: 9
                }
            }
        }
    }
};

var root = protobuf.Root.fromJSON(def);
var Test = root.lookupType("Test");

// Reads the raw wire bytes and returns the map keys of the given field in wire order.
function mapKeyOrder(buf, fieldId, keyType) {
    var reader = protobuf.Reader.create(buf),
        keys = [];
    while (reader.pos < reader.len) {
        var tag = reader.uint32();
        if (tag >>> 3 !== fieldId) {
            reader.skipType(tag & 7);
            continue;
        }
        var end = reader.uint32() + reader.pos;
        while (reader.pos < end) {
            var etag = reader.uint32();
            if (etag >>> 3 === 1) {
                keys.push(keyType === "string"
                    ? reader.string()
                    : keyType === "bool"
                        ? reader.bool()
                        : reader[keyType]().toString());
            } else {
                reader.skipType(etag & 7);
            }
        }
    }
    return keys;
}

tape.test("deterministic encoding", function (test) {

    test.test("same map built in reverse order encodes to identical bytes", function (t) {
        var forward = Test.create({
            byLong: { "5": 1, "-3": 2, "9007199254740993": 3, "9007199254740992": 4, "-9223372036854775808": 5 },
            byUlong: { "18446744073709551615": "a", "0": "b", "9007199254740993": "c" },
            byString: { "中文": { counts: { "1": "x" } }, "abc": { counts: { "2": "y" } }, "世界": { counts: { "3": "z" } } },
            byBool: { "true": 1, "false": 2 },
            bySint: { "7": "a", "-7": "b", "0": "c" },
            nums: [3, 1, 2],
            str: "oneof"
        });
        var reverse = Test.create({
            str: "oneof",
            nums: [3, 1, 2],
            bySint: { "0": "c", "-7": "b", "7": "a" },
            byBool: { "false": 2, "true": 1 },
            byString: { "世界": { counts: { "3": "z" } }, "abc": { counts: { "2": "y" } }, "中文": { counts: { "1": "x" } } },
            byUlong: { "9007199254740993": "c", "0": "b", "18446744073709551615": "a" },
            byLong: { "-9223372036854775808": 5, "9007199254740992": 4, "9007199254740993": 3, "-3": 2, "5": 1 }
        });
        var a = Test.encodeDeterministic(forward).finish(),
            b = Test.encodeDeterministic(reverse).finish();
        t.ok(Buffer.from(a).equals(Buffer.from(b)), "bytes are identical");
        t.ok(a.length > 0, "bytes are not empty");
        t.end();
    });

    test.test("int64 keys sort by exact numeric value without precision loss", function (t) {
        var msg = Test.create({
            byLong: { "9007199254740993": 1, "5": 2, "9007199254740992": 3, "-3": 4, "-9223372036854775808": 5 }
        });
        var keys = mapKeyOrder(Test.encodeDeterministic(msg).finish(), 1, "int64");
        t.deepEqual(keys, ["-9223372036854775808", "-3", "5", "9007199254740992", "9007199254740993"], "exactly sorted, including keys above 2^53");
        t.end();
    });

    test.test("uint64 keys sort by exact numeric value without precision loss", function (t) {
        var msg = Test.create({
            byUlong: { "18446744073709551615": "a", "9007199254740993": "b", "0": "c", "9007199254740992": "d" }
        });
        var keys = mapKeyOrder(Test.encodeDeterministic(msg).finish(), 2, "uint64");
        t.deepEqual(keys, ["0", "9007199254740992", "9007199254740993", "18446744073709551615"], "exactly sorted, including keys above 2^53");
        t.end();
    });

    test.test("bool keys sort false before true", function (t) {
        var msg = Test.create({ byBool: { "true": 1, "false": 2 } });
        var keys = mapKeyOrder(Test.encodeDeterministic(msg).finish(), 4, "bool");
        t.deepEqual(keys, [false, true], "false first");
        t.end();
    });

    test.test("sint32 keys sort numerically, not lexicographically", function (t) {
        var msg = Test.create({ bySint: { "7": "a", "-7": "b", "0": "c", "100": "d", "-100": "e" } });
        var keys = mapKeyOrder(Test.encodeDeterministic(msg).finish(), 5, "sint32");
        t.deepEqual(keys, ["-100", "-7", "0", "7", "100"], "numerically sorted");
        t.end();
    });

    test.test("string keys sort by UTF-8 byte order", function (t) {
        var msg = Test.create({
            byString: {
                "𐀀": { counts: { "1": "a" } }, // U+10000, UTF-8 F0 90 80 80
                "￿": { counts: { "2": "b" } }, // U+FFFF, UTF-8 EF BF BF
                "中文": { counts: { "3": "c" } },
                "世界": { counts: { "4": "d" } },
                "abc": { counts: { "5": "e" } }
            }
        });
        var keys = mapKeyOrder(Test.encodeDeterministic(msg).finish(), 3, "string");
        t.deepEqual(keys, ["abc", "世界", "中文", "￿", "𐀀"], "sorted by UTF-8 bytes, not UTF-16 code units");
        t.end();
    });

    test.test("nested maps are encoded deterministically", function (t) {
        var a = Test.encodeDeterministic(Test.create({
            nested: { counts: { "9": "x", "-1": "y", "9223372036854775807": "z" } }
        })).finish();
        var b = Test.encodeDeterministic(Test.create({
            nested: { counts: { "9223372036854775807": "z", "-1": "y", "9": "x" } }
        })).finish();
        t.ok(Buffer.from(a).equals(Buffer.from(b)), "bytes are identical");
        var reader = protobuf.Reader.create(a);
        reader.uint32(); // tag of the nested message field
        var keys = mapKeyOrder(reader.bytes(), 1, "int64");
        t.deepEqual(keys, ["-1", "9", "9223372036854775807"], "nested map keys are sorted");
        t.end();
    });

    test.test("empty message encodes to zero bytes", function (t) {
        var buf = Test.encodeDeterministic(Test.create({})).finish();
        t.equal(buf.length, 0, "no bytes");
        t.end();
    });

    test.test("repeated fields keep their order and oneof round-trips", function (t) {
        var msg = Test.create({ nums: [3, 1, 2], num: 42 });
        var decoded = Test.decode(Test.encodeDeterministic(msg).finish());
        t.deepEqual(decoded.nums, [3, 1, 2], "repeated order preserved");
        t.equal(decoded.num, 42, "oneof value preserved");
        t.equal(decoded.choice, "num", "oneof selection preserved");
        t.end();
    });

    test.test("deterministic bytes decode to the same values as regular encode", function (t) {
        var msg = Test.create({
            byLong: { "5": 1, "-3": 2, "9007199254740993": 3 },
            byString: { "中文": { counts: { "1": "x" } } },
            byBool: { "true": 1 },
            nums: [1, 2, 3],
            str: "hello"
        });
        var det = Test.toObject(Test.decode(Test.encodeDeterministic(msg).finish()), { longs: String });
        var reg = Test.toObject(Test.decode(Test.encode(msg).finish()), { longs: String });
        t.deepEqual(det, reg, "decoded values are equal");
        t.equal(det.byLong["9007199254740993"], 3, "huge 64 bit key survived the round trip");
        t.ok(det.byString["中文"], "chinese key survived the round trip");
        t.end();
    });

    test.test("Message.encodeDeterministic static is exposed", function (t) {
        var msg = Test.create({ byBool: { "true": 1, "false": 2 } });
        var a = Test.ctor.encodeDeterministic(msg).finish(),
            b = Test.encodeDeterministic(msg).finish();
        t.ok(Buffer.from(a).equals(Buffer.from(b)), "static and type encoders agree");
        t.end();
    });

    test.end();
});
