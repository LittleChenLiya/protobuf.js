var tape = require("tape");

var protobuf = require("..");

var proto = "syntax = \"proto3\";\
package test;\
message Inner {\
    map<string, int32> counts = 1;\
    int32 id = 2;\
}\
message Test {\
    map<int64, string> i64 = 1;\
    map<uint64, string> u64 = 2;\
    map<sint32, string> i32 = 3;\
    map<bool, string> b = 4;\
    map<string, string> s = 5;\
    map<int64, Inner> nested = 6;\
    Inner inner = 7;\
    repeated int32 nums = 8;\
    oneof choice {\
        string cs = 9;\
        int32 cn = 10;\
    }\
}";

var root = protobuf.parse(proto).root;
var Test = root.lookupType("test.Test");

// 64 bit keys covering negatives, zero and values that lose precision as Number (> 2^53)
var i64Keys = [
    "-9223372036854775808",
    "-9007199254740993",
    "-1",
    "0",
    "5",
    "9007199254740993",
    "9223372036854775807"
];
var u64Keys = [
    "0",
    "5",
    "9007199254740993",
    "18446744073709551615"
];
var i32Keys = [ "-2147483648", "-5", "0", "7", "2147483647" ];
var boolKeys = [ "false", "true" ];
// UTF-8 byte order: a z é 中 文 \uE000 \u{1F600} (code unit order would place \u{1F600} before \uE000)
var stringKeys = [ "a", "z", "é", "中", "文", "\uE000", "\u{1F600}" ];

function mapFromKeys(keys, valueFor) {
    var obj = {};
    keys.forEach(function(key, index) {
        obj[key] = valueFor(key, index);
    });
    return obj;
}

function reversed(keys) {
    return keys.slice().reverse();
}

function sampleMessage(keysOrder) {
    return {
        i64: mapFromKeys(keysOrder(i64Keys), function(key) { return "v" + key; }),
        u64: mapFromKeys(keysOrder(u64Keys), function(key) { return "v" + key; }),
        i32: mapFromKeys(keysOrder(i32Keys), function(key) { return "v" + key; }),
        b: mapFromKeys(keysOrder(boolKeys), function(key) { return "v" + key; }),
        s: mapFromKeys(keysOrder(stringKeys), function(key) { return "v" + key; }),
        nested: mapFromKeys(keysOrder(i64Keys.slice(0, 3)), function(key) {
            return {
                counts: mapFromKeys(keysOrder(stringKeys.slice(0, 4)), function(skey) {
                    return stringKeys.indexOf(skey);
                }),
                id: i64Keys.indexOf(key)
            };
        }),
        inner: {
            counts: mapFromKeys(keysOrder(stringKeys), function(key) { return stringKeys.indexOf(key); }),
            id: 7
        },
        nums: [ 3, 1, 2 ],
        cs: "hello"
    };
}

function sortedStringify(value) {
    return JSON.stringify(value, function(key, val) {
        if (val && typeof val === "object" && !Array.isArray(val)) {
            var sorted = {};
            Object.keys(val).sort().forEach(function(k) {
                sorted[k] = val[k];
            });
            return sorted;
        }
        return val;
    });
}

tape.test("deterministic encoding", function(test) {

    var forward = sampleMessage(function(keys) { return keys; });
    var backward = sampleMessage(reversed);

    var forwardBytes = Test.encodeDeterministic(forward).finish();
    var backwardBytes = Test.encodeDeterministic(backward).finish();

    test.deepEqual(backwardBytes, forwardBytes, "should produce identical bytes for maps constructed in opposite order");

    test.test("should sort map entries by key", function(t) {
        function expectedBytes(field, keys, valueFor) {
            var parts = keys.map(function(key, index) {
                var single = {};
                single[field] = mapFromKeys([ key ], function() { return valueFor(key, index); });
                return Test.encodeDeterministic(single).finish();
            });
            return Buffer.concat(parts.map(function(part) { return Buffer.from(part); }));
        }

        var cases = [
            [ "i64", i64Keys, function(key) { return "v" + key; } ],
            [ "u64", u64Keys, function(key) { return "v" + key; } ],
            [ "i32", i32Keys, function(key) { return "v" + key; } ],
            [ "b", boolKeys, function(key) { return "v" + key; } ],
            [ "s", stringKeys, function(key) { return "v" + key; } ]
        ];
        cases.forEach(function(testCase) {
            var field = testCase[0],
                keys = testCase[1],
                valueFor = testCase[2];
            var msg = {};
            msg[field] = mapFromKeys(reversed(keys), valueFor);
            var actual = Buffer.from(Test.encodeDeterministic(msg).finish());
            t.deepEqual(actual, expectedBytes(field, keys, valueFor), "should serialize map '" + field + "' in sorted key order");
        });
        t.end();
    });

    test.test("should encode nested messages and nested maps deterministically", function(t) {
        var a = Test.encodeDeterministic({ nested: forward.nested, inner: forward.inner }).finish();
        var b = Test.encodeDeterministic({ nested: backward.nested, inner: backward.inner }).finish();
        t.deepEqual(b, a, "should produce identical bytes for nested maps constructed in opposite order");
        t.end();
    });

    test.test("should encode empty messages to zero bytes", function(t) {
        t.equal(Test.encodeDeterministic({}).finish().length, 0, "empty message should encode to zero bytes");
        t.equal(Test.encodeDeterministic(Test.create()).finish().length, 0, "default message should encode to zero bytes");
        t.end();
    });

    test.test("should keep repeated field order and support oneof", function(t) {
        var msg = { nums: [ 3, 1, 2 ], cs: "hello" };
        var bytes = Test.encodeDeterministic(msg).finish();
        t.deepEqual(Test.encodeDeterministic(msg).finish(), bytes, "should be stable across calls");
        var decoded = Test.decode(bytes);
        t.deepEqual(decoded.nums, [ 3, 1, 2 ], "should keep repeated field order");
        t.equal(decoded.cs, "hello", "should round-trip the oneof string member");
        t.equal(decoded.choice, "cs", "should select the oneof member");
        var decodedNum = Test.decode(Test.encodeDeterministic({ cn: 42 }).finish());
        t.equal(decodedNum.cn, 42, "should round-trip the oneof int member");
        t.equal(decodedNum.choice, "cn", "should select the other oneof member");
        t.end();
    });

    test.test("should decode to the same values as regular encoding", function(t) {
        var regularBytes = Test.encode(backward).finish();
        var fromDeterministic = Test.toObject(Test.decode(forwardBytes), { longs: String, defaults: false });
        var fromRegular = Test.toObject(Test.decode(regularBytes), { longs: String, defaults: false });
        t.equal(sortedStringify(fromDeterministic), sortedStringify(fromRegular), "should decode deterministic bytes to the same values as regular bytes");

        var reencoded = Test.encodeDeterministic(Test.decode(forwardBytes)).finish();
        t.deepEqual(reencoded, forwardBytes, "should re-encode decoded messages (hash string keys) to the same bytes");
        t.end();
    });

    test.test("should be exposed on message constructors", function(t) {
        var msg = Test.create(forward);
        var bytes = Test.ctor.encodeDeterministic(msg).finish();
        t.deepEqual(bytes, forwardBytes, "Message.encodeDeterministic should match Type#encodeDeterministic");
        t.end();
    });

    test.end();
});
