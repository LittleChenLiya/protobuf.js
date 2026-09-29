"use strict";
module.exports = upgradeMessage;

var Enum   = require("./enum"),
    Reader = require("./reader"),
    Type   = require("./type"),
    types  = require("./types"),
    util   = require("./util");

function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

function copyBytes(value) {
    if (value == null || typeof value.slice !== "function")
        return value;
    if (util.Buffer && util.Buffer.isBuffer(value))
        return util.Buffer.from(value); // Buffer#slice returns a view
    return value.slice(0);
}

function isClosedEnum(field) {
    return field.resolvedType instanceof Enum
        && field.resolvedType._features
        && field.resolvedType._features.enum_type === "CLOSED";
}

function stringMethod(field) {
    return field._features && field._features.utf8_validation === "VERIFY" ? "stringVerify" : "string";
}

function oneofName(field) {
    var partOf = field.partOf;
    if (!partOf || partOf.isProto3Optional)
        return null;
    return partOf.name;
}

function incompatible(label, reason) {
    return Error("upgradeMessage: incompatible " + label + ": " + reason);
}

function checkFieldTypes(oldField, newField, seen, label) {
    var oldResolved = oldField.resolvedType,
        newResolved = newField.resolvedType;
    if (oldResolved instanceof Type || newResolved instanceof Type) {
        if (!(oldResolved instanceof Type && newResolved instanceof Type))
            throw incompatible(label, "message type changed to or from a scalar type");
        checkTypesCompatible(oldResolved, newResolved, seen, label);
    } else if (oldResolved instanceof Enum || newResolved instanceof Enum) {
        if (!(oldResolved instanceof Enum && newResolved instanceof Enum))
            throw incompatible(label, "enum type changed to or from a scalar type");
        // enums are always wire compatible (varint int32)
    } else if (oldField.type !== newField.type) {
        throw incompatible(label, "type changed from " + oldField.type + " to " + newField.type);
    }
}

function checkTypesCompatible(oldType, newType, seen, path) {
    for (var i = 0; i < seen.length; ++i)
        if (seen[i][0] === oldType && seen[i][1] === newType)
            return;
    seen.push([ oldType, newType ]);
    for (var j = 0; j < newType.fieldsArray.length; ++j) {
        var newField = newType.fieldsArray[j],
            oldField = oldType.fieldsById[newField.id];
        if (!oldField)
            continue;
        var label = "field #" + newField.id + " (" + path + newField.name + ")";
        if (Boolean(oldField.map) !== Boolean(newField.map))
            throw incompatible(label, "map rule changed");
        if (Boolean(oldField.repeated) !== Boolean(newField.repeated))
            throw incompatible(label, "repeated rule changed");
        if (oneofName(oldField) !== oneofName(newField))
            throw incompatible(label, "oneof membership changed");
        if (oldField.map && oldField.keyType !== newField.keyType)
            throw incompatible(label, "map key type changed from " + oldField.keyType + " to " + newField.keyType);
        checkFieldTypes(oldField.resolve(), newField.resolve(), seen, label);
    }
}

function upgradeSingle(oldField, newField, value) {
    if (newField.resolvedType instanceof Type) {
        if (value != null && typeof value === "object")
            return upgradeKnown(oldField.resolvedType, newField.resolvedType, value);
        return value;
    }
    if (newField.type === "bytes")
        return copyBytes(value);
    return value;
}

function upgradeValue(oldField, newField, value) {
    if (newField.map) {
        var map = {},
            keys = Object.keys(value);
        for (var i = 0; i < keys.length; ++i)
            map[keys[i]] = upgradeSingle(oldField, newField, value[keys[i]]);
        return map;
    }
    if (newField.repeated) {
        var array = new Array(value.length);
        for (var j = 0; j < value.length; ++j)
            array[j] = upgradeSingle(oldField, newField, value[j]);
        return array;
    }
    return upgradeSingle(oldField, newField, value);
}

function setSingular(upgraded, field, value) {
    var oneof = field.partOf;
    if (oneof) {
        for (var i = 0; i < oneof.fieldsArray.length; ++i) {
            var other = oneof.fieldsArray[i];
            if (other !== field && hasOwn(upgraded, other.name))
                delete upgraded[other.name];
        }
        upgraded[oneof.name] = field.name;
    }
    upgraded[field.name] = value;
}

function repeatedArray(upgraded, field) {
    var array = upgraded[field.name];
    if (!array || !array.length)
        upgraded[field.name] = array = [];
    return array;
}

function promoteMapField(upgraded, field, wireType, reader, raw, remaining) {
    if (wireType !== 2)
        return false;
    var end = reader.uint32() + reader.pos;
    if (end > reader.len)
        throw RangeError("index out of range: " + reader.pos + " + " + (end - reader.pos) + " > " + reader.len);
    var keyType = field.keyType,
        type    = field.resolvedType instanceof Enum ? "int32" : field.type,
        key     = types.defaults[keyType] !== undefined ? types.defaults[keyType] : null,
        value;
    if (types.long[type] !== undefined)
        value = util.Long ? util.Long.fromNumber(0, type === "uint64" || type === "fixed64") : 0;
    else
        value = types.defaults[type] !== undefined ? types.defaults[type] : null;
    while (reader.pos < end) {
        var tag = reader.uint32(),
            id  = tag >>> 3,
            wt  = tag & 7;
        if (!id)
            throw Error("illegal tag: field number 0");
        if (id === 1 && wt === types.mapKey[keyType]) {
            key = reader[keyType === "string" ? stringMethod(field) : keyType]();
        } else if (id === 2 && wt === (types.basic[type] === undefined ? 2 : types.basic[type])) {
            if (types.basic[type] === undefined)
                value = field.resolvedType.decode(reader, reader.uint32(), undefined, 0, value || undefined);
            else
                value = reader[type === "string" ? stringMethod(field) : type]();
        } else {
            reader.skipType(wt);
        }
    }
    if (reader.pos !== end)
        throw RangeError("index out of range: " + reader.pos + " != " + end);
    if (isClosedEnum(field) && field.resolvedType.valuesById[value] === undefined) {
        remaining.push(copyBytes(raw));
        return true;
    }
    var map = upgraded[field.name];
    if (!map || map === util.emptyObject)
        upgraded[field.name] = map = {};
    if (types.long[keyType] !== undefined && typeof key === "object")
        key = util.longToHash(key);
    if (key === "__proto__")
        util.makeProp(map, key);
    map[key] = value;
    return true;
}

function promoteMessageField(upgraded, field, wireType, reader) {
    var mtype = field.resolvedType;
    if (field.delimited) {
        if (wireType !== 3)
            return false;
    } else if (wireType !== 2)
        return false;
    var length  = field.delimited ? undefined : reader.uint32(),
        endTag  = field.delimited ? field.id * 8 + 4 : undefined;
    if (field.repeated) {
        repeatedArray(upgraded, field).push(mtype.decode(reader, length, endTag, 0));
        return true;
    }
    var existing = hasOwn(upgraded, field.name) ? upgraded[field.name] : undefined;
    setSingular(upgraded, field, mtype.decode(reader, length, endTag, 0, existing));
    return true;
}

function promoteScalarField(upgraded, field, type, wireType, reader, remaining) {
    var closed = isClosedEnum(field),
        method = type === "string" ? stringMethod(field) : type;
    if (field.repeated) {
        var array = repeatedArray(upgraded, field);
        if (types.packed[type] !== undefined && wireType === 2) {
            if (closed) {
                var end = reader.uint32() + reader.pos;
                if (end > reader.len)
                    throw RangeError("index out of range: " + reader.pos + " + " + (end - reader.pos) + " > " + reader.len);
                while (reader.pos < end) {
                    var packedStart = reader.pos,
                        packedValue = reader[type]();
                    if (field.resolvedType.valuesById[packedValue] !== undefined)
                        array.push(packedValue);
                    else
                        remaining.push(util.rawField(field.id, 0, reader.raw(packedStart, reader.pos)));
                }
                if (reader.pos !== end)
                    throw RangeError("index out of range: " + reader.pos + " != " + end);
            } else {
                reader[type + "s"](array);
            }
            return true;
        }
        if (wireType !== types.basic[type])
            return false;
        var repeatedStart = reader.pos,
            repeatedValue = reader[method]();
        if (closed && field.resolvedType.valuesById[repeatedValue] === undefined) {
            remaining.push(util.rawField(field.id, 0, reader.raw(repeatedStart, reader.pos)));
            return true;
        }
        array.push(field.type === "bytes" ? copyBytes(repeatedValue) : repeatedValue);
        return true;
    }
    if (wireType !== types.basic[type])
        return false;
    var start = reader.pos,
        value = reader[method]();
    if (closed && field.resolvedType.valuesById[value] === undefined) {
        remaining.push(util.rawField(field.id, 0, reader.raw(start, reader.pos)));
        return true;
    }
    setSingular(upgraded, field, field.type === "bytes" ? copyBytes(value) : value);
    return true;
}

function promoteField(upgraded, field, wireType, reader, raw, remaining) {
    if (field.map)
        return promoteMapField(upgraded, field, wireType, reader, raw, remaining);
    if (field.resolvedType instanceof Type)
        return promoteMessageField(upgraded, field, wireType, reader);
    return promoteScalarField(upgraded, field, field.resolvedType instanceof Enum ? "int32" : field.type, wireType, reader, remaining);
}

function promoteUnknowns(newType, upgraded, unknowns) {
    var remaining = [];
    for (var i = 0; i < unknowns.length; ++i) {
        var raw = unknowns[i];
        if (!(raw instanceof Uint8Array))
            throw TypeError("upgradeMessage: $unknowns[" + i + "] must be a Uint8Array");
        var reader = Reader.create(raw);
        reader.discardUnknown = false;
        var id = 0;
        try {
            var tag      = reader.uint32(),
                wireType = tag & 7;
            id = tag >>> 3;
            if (!id)
                throw Error("illegal tag: field number 0");
            var field = newType.fieldsById[id];
            if (!field || !promoteField(upgraded, field, wireType, reader, raw, remaining))
                remaining.push(copyBytes(raw));
            else if (reader.pos !== reader.len)
                throw Error("unexpected trailing bytes");
        } catch (e) {
            throw Error("upgradeMessage: invalid unknown field" + (id ? " #" + id : "")
                + " at offset " + reader.pos + " in $unknowns[" + i + "]: " + e.message, { cause: e });
        }
    }
    return remaining;
}

function upgradeKnown(oldType, newType, message) {
    var upgraded = newType.create();
    for (var i = 0; i < newType.fieldsArray.length; ++i) {
        var newField = newType.fieldsArray[i],
            oldField = oldType.fieldsById[newField.id];
        if (!oldField || !hasOwn(message, oldField.name))
            continue;
        var value = message[oldField.name];
        if (value == null)
            continue;
        upgraded[newField.name] = upgradeValue(oldField, newField, value);
        if (newField.partOf)
            upgraded[newField.partOf.name] = newField.name;
    }
    var unknowns = hasOwn(message, "$unknowns") ? message.$unknowns : undefined;
    if (unknowns != null) {
        if (!Array.isArray(unknowns))
            throw TypeError("upgradeMessage: $unknowns must be an Array of Uint8Array");
        var remaining = promoteUnknowns(newType, upgraded, unknowns);
        if (remaining.length) {
            util.makeProp(upgraded, "$unknowns", false);
            upgraded.$unknowns = remaining;
        }
    }
    return upgraded;
}

/**
 * Upgrades a message decoded with an older schema to a newer schema by promoting
 * matching unknown wire fields to accessible fields. Field compatibility is checked
 * by field id against the resolved types (not by field name); if any shared field id
 * is incompatible, the entire upgrade is rejected. The source message is not modified
 * and no mutable bytes are shared with it.
 * @param {Type} oldType Message type the message was decoded with
 * @param {Type} newType Message type to upgrade to
 * @param {Message<{}>|Object.<string,*>} message Message decoded with oldType, with $unknowns preserved
 * @returns {Message<{}>} Upgraded message of newType with any still-unknown fields retained in $unknowns
 * @throws {TypeError} If arguments are invalid
 * @throws {Error} If the schemas are incompatible or an unknown field is corrupt
 */
function upgradeMessage(oldType, newType, message) {
    if (!(oldType instanceof Type))
        throw TypeError("oldType must be a Type");
    if (!(newType instanceof Type))
        throw TypeError("newType must be a Type");
    if (!message || typeof message !== "object")
        throw TypeError("message must be an object");
    oldType.resolveAll();
    newType.resolveAll();
    checkTypesCompatible(oldType, newType, [], newType.name + ".");
    return upgradeKnown(oldType, newType, message);
}
