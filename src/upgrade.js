"use strict";
module.exports = upgradeMessage;

var Enum   = require("./enum"),
    Reader = require("./reader"),
    Type   = require("./type"),
    types  = require("./types"),
    util   = require("./util");

var hasOwn = Object.prototype.hasOwnProperty;

// Scalar types that may safely widen to their 64 bit counterpart (same wire semantics)
var scalarWidening = {
    "int32":    "int64",
    "uint32":   "uint64",
    "sint32":   "sint64",
    "fixed32":  "fixed64",
    "sfixed32": "sfixed64"
};

function incompatible(oldType, oldField, reason) {
    throw Error("upgradeMessage: incompatible field " + oldType.fullName.replace(/^\./, "") + "." + oldField.name + " (id " + oldField.id + "): " + reason);
}

// Canonical wire type of a field, with enums resolving to varint
function wireTypeOf(field) {
    if (field.map)
        return 2;
    if (field.resolvedType instanceof Type)
        return field.delimited ? 3 : 2;
    if (field.resolvedType instanceof Enum)
        return 0;
    return types.basic[field.type];
}

// Whether two fields with the same id hold values with compatible wire semantics
function kindsCompatible(oldField, newField) {
    var oldIsType = oldField.resolvedType instanceof Type,
        newIsType = newField.resolvedType instanceof Type;
    if (oldIsType || newIsType)
        return oldIsType && newIsType;
    var oldIsEnum = oldField.resolvedType instanceof Enum,
        newIsEnum = newField.resolvedType instanceof Enum;
    if (oldIsEnum || newIsEnum)
        return oldIsEnum && newIsEnum;
    if (oldField.type === newField.type)
        return true;
    return scalarWidening[oldField.type] === newField.type;
}

function checkField(oldType, oldField, newField, seen) {
    if (oldField.map || newField.map) {
        if (!oldField.map || !newField.map)
            incompatible(oldType, oldField, "map mismatch");
        if (oldField.keyType !== newField.keyType)
            incompatible(oldType, oldField, "map key type " + oldField.keyType + " vs " + newField.keyType);
    }
    if (oldField.repeated !== newField.repeated)
        incompatible(oldType, oldField, "repeated mismatch");
    if (wireTypeOf(oldField) !== wireTypeOf(newField))
        incompatible(oldType, oldField, "wire type mismatch (" + oldField.type + " vs " + newField.type + ")");
    if (!kindsCompatible(oldField, newField))
        incompatible(oldType, oldField, "type mismatch (" + oldField.type + " vs " + newField.type + ")");
    var oldOneof = oldField.partOf || null,
        newOneof = newField.partOf || null;
    if (!oldOneof !== !newOneof)
        incompatible(oldType, oldField, "oneof membership mismatch");
    if (oldField.resolvedType instanceof Type)
        checkCompatible(oldField.resolvedType, newField.resolvedType, seen);
}

// Verifies that every field id known to both types is wire-compatible, recursively
function checkCompatible(oldType, newType, seen) {
    for (var i = 0; i < seen.length; ++i)
        if (seen[i][0] === oldType && seen[i][1] === newType)
            return;
    seen.push([ oldType, newType ]);
    var fieldsById = oldType.fieldsById;
    for (var id in fieldsById) {
        if (hasOwn.call(fieldsById, id)) {
            var newField = newType.fieldsById[id];
            if (newField)
                checkField(oldType, fieldsById[id].resolve(), newField.resolve(), seen);
        }
    }
}

function copyBytes(value) {
    return util.newBuffer(value); // Buffer.from / new Uint8Array both copy
}

function addUnknown(message, bytes) {
    if (!bytes.length)
        return;
    if (!hasOwn.call(message, "$unknowns") || message.$unknowns == null) {
        util.makeProp(message, "$unknowns", false);
        message.$unknowns = [];
    }
    message.$unknowns.push(bytes);
}

function copyValue(oldField, newField, value) {
    if (value == null)
        return value;
    if (oldField.resolvedType instanceof Type)
        return upgradeMessage(oldField.resolvedType, newField.resolvedType, value);
    if (oldField.type === "bytes")
        return copyBytes(value);
    return value;
}

function copyKnown(result, oldField, newField, value) {
    var name = newField.name,
        i;
    if (newField.map) {
        var out = {},
            keys = Object.keys(value);
        for (i = 0; i < keys.length; ++i)
            out[keys[i]] = copyValue(oldField, newField, value[keys[i]]);
        result[name] = out;
    } else if (newField.repeated) {
        var arr = new Array(value.length);
        for (i = 0; i < value.length; ++i)
            arr[i] = copyValue(oldField, newField, value[i]);
        result[name] = arr;
    } else {
        result[name] = copyValue(oldField, newField, value);
    }
    if (newField.partOf)
        result[newField.partOf.name] = name; // oneof setter clears previously set siblings
}

// Re-encodes a field known to the old type but removed from the new type as unknown data
function encodeOrphan(oldType, oldField, value) {
    var temp = {};
    temp[oldField.name] = value;
    return oldType.encode(temp).finish();
}

// Merges a partially decoded message into the result using protobuf merge semantics
function mergePartial(result, partial, type) {
    var fields = type.fieldsArray,
        i;
    for (i = 0; i < fields.length; ++i) {
        var field = fields[i].resolve(),
            name = field.name;
        if (!hasOwn.call(partial, name) || partial[name] == null)
            continue;
        var value = partial[name];
        if (field.map) {
            var target = result[name];
            if (target == null)
                target = result[name] = {};
            var keys = Object.keys(value);
            for (var k = 0; k < keys.length; ++k)
                target[keys[k]] = value[keys[k]];
        } else if (field.repeated) {
            var arr = result[name];
            if (arr == null)
                arr = result[name] = [];
            for (var j = 0; j < value.length; ++j)
                arr.push(value[j]);
        } else if (field.resolvedType instanceof Type && result[name] != null && typeof result[name] === "object") {
            mergePartial(result[name], value, field.resolvedType); // singular messages merge
        } else {
            result[name] = value; // singular scalars: last one wins
        }
        if (field.partOf)
            result[field.partOf.name] = name;
    }
    if (partial.$unknowns != null && hasOwn.call(partial, "$unknowns"))
        for (i = 0; i < partial.$unknowns.length; ++i)
            addUnknown(result, partial.$unknowns[i]);
}

// Promotes a single raw unknown field entry to the new schema, or keeps it unknown
function promoteUnknown(newType, entry, result) {
    var data   = copyBytes(entry), // never share mutable bytes with the old message
        reader = Reader.create(data),
        id     = 0;
    reader.discardUnknown = false;
    try {
        id = reader.uint32() >>> 3;
        reader.pos = 0;
    } catch (e) {
        throw Error("upgradeMessage: invalid unknown field at offset " + reader.pos + ": " + e.message, { cause: e });
    }
    var partial = newType.create();
    try {
        newType.decode(reader, undefined, undefined, 0, partial);
    } catch (e) {
        if (!(e instanceof util.ProtocolError)) // missing required fields are tolerated while upgrading
            throw Error("upgradeMessage: invalid unknown field " + id + " at offset " + reader.pos + ": " + e.message, { cause: e });
    }
    mergePartial(result, partial, newType);
}

/**
 * Upgrades a message decoded with an older schema to a newer schema.
 *
 * Field ids present in both types are checked for compatibility up front (wire type,
 * repeated/map rule and oneof membership, based on the resolved types) and the whole
 * upgrade is rejected on any conflict. Unknown wire fields preserved on the old message
 * (see Reader#discardUnknown) that match fields of the new schema are promoted to
 * accessible fields following protobuf merge semantics (last value wins for singular
 * scalars, concatenation for repeated fields, merging for singular messages), nested
 * messages are upgraded recursively and fields renamed in the new schema are exposed
 * under their new name. Fields removed from the new schema are re-encoded as unknown
 * data and any still unknown fields are kept as raw bytes, so re-encoding the result
 * is lossless. Neither the old message nor its unknown field bytes are modified or
 * shared with the result. Corrupt unknown fields are reported with their field number
 * and offset.
 * @param {Type} oldType Reflected message type the message was decoded with
 * @param {Type} newType Reflected message type to upgrade to
 * @param {Message<{}>|Object.<string,*>} message Message decoded with oldType
 * @returns {Message<{}>} Upgraded message of newType
 * @throws {Error} If the schemas are incompatible or an unknown field is corrupt
 */
function upgradeMessage(oldType, newType, message) {
    if (!(oldType instanceof Type))
        throw TypeError("oldType must be a Type");
    if (!(newType instanceof Type))
        throw TypeError("newType must be a Type");
    if (!message || typeof message !== "object")
        throw TypeError("message must be an object");

    checkCompatible(oldType, newType, []);

    var result = newType.create(),
        i;

    // Copy fields known to the old schema, renaming and upgrading nested messages
    var oldFields = oldType.fieldsArray;
    for (i = 0; i < oldFields.length; ++i) {
        var oldField = oldFields[i].resolve();
        if (!hasOwn.call(message, oldField.name) || message[oldField.name] == null)
            continue;
        var value    = message[oldField.name],
            newField = newType.fieldsById[oldField.id];
        if (!newField) {
            addUnknown(result, encodeOrphan(oldType, oldField, value));
            continue;
        }
        copyKnown(result, oldField, newField.resolve(), value);
    }

    // Restore oneof discriminators from the old message where still applicable
    var oldOneofs = oldType.oneofsArray;
    for (i = 0; i < oldOneofs.length; ++i) {
        var discriminator = message[oldOneofs[i].name];
        if (typeof discriminator !== "string")
            continue;
        var selected = oldType.fields[discriminator];
        if (!selected)
            continue;
        var selectedNew = newType.fieldsById[selected.id];
        if (selectedNew && selectedNew.partOf && hasOwn.call(result, selectedNew.name))
            result[selectedNew.partOf.name] = selectedNew.name;
    }

    // Promote unknown wire fields to fields of the new schema
    if (message.$unknowns != null && hasOwn.call(message, "$unknowns"))
        for (i = 0; i < message.$unknowns.length; ++i)
            promoteUnknown(newType, message.$unknowns[i], result);

    return result;
}
