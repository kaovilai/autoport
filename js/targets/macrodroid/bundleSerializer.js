// js/targets/macrodroid/bundleSerializer.js — port of the twofortyfouram
// locale SDK's BundleSerializer.serializeToByteArray, the format MacroDroid's
// LocalePluginAction stores in m_pluginInstanceData.mSerializedBundle.
//
// Mirrors the decompiled MacroDroid (github.com/Mohsenabn78/
// macro-reverse-engineering, com.twofortyfouram.locale.sdk.host.internal
// .BundleSerializer). Envelope on top of a Java ObjectOutputStream:
//
//   writeInt(1)                              VERSION_1
//   writeInt(size == 0 ? 0 : 1)              first control code
//   for key in case-insensitive-sorted order:
//     nested bundle -> writeInt(1); writeObject(key); writeObject(nested bytes)
//     value         -> writeInt(0); writeObject(key); writeObject(value)
//     writeInt(last ? 0 : 1)                 control code AFTER each entry
//
// (The interleaved control codes — initial plus one after every entry — are
// exactly what the decompile does; reproduce them faithfully.)
//
// Values: string, boolean, number (integers only), null, Uint8Array (a
// pre-serialized nested bundle), plain object (nested bundle), string[].
// Keys are compared with Java's String.compareToIgnoreCase — for ASCII that
// is plain case-insensitive code-unit ordering.

import { JavaObjectOutputStream } from './javaObjectStream.js';

/** Java String.compareToIgnoreCase, restricted to the BMP behavior that
 *  matters for bundle keys. */
function compareIgnoreCase(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    let ca = a.charCodeAt(i);
    let cb = b.charCodeAt(i);
    // toUpperCase for ASCII letters
    if (ca >= 0x61 && ca <= 0x7a) ca -= 0x20;
    if (cb >= 0x61 && cb <= 0x7a) cb -= 0x20;
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  return a.length - b.length;
}

export function serializeBundle(bundle) {
  const keys = Object.keys(bundle).sort(compareIgnoreCase);
  const oos = new JavaObjectOutputStream();

  oos.writeInt(1); // VERSION_1
  oos.writeInt(keys.length === 0 ? 0 : 1);

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const value = bundle[key];
    if (value !== null && value !== undefined && typeof value === 'object'
        && !(value instanceof Uint8Array) && !Array.isArray(value)) {
      // nested bundle: serialized as its own complete stream (fresh header
      // and handle space — the SDK recurses into a NEW ObjectOutputStream)
      oos.writeInt(1); // TYPE_BUNDLE
      oos.writeObject(key);
      oos.writeObject(serializeBundle(value));
    } else {
      oos.writeInt(0); // TYPE_SERIALIZABLE
      oos.writeObject(key);
      oos.writeObject(value === undefined ? null : value);
    }
    oos.writeInt(i === keys.length - 1 ? 0 : 1);
  }

  return oos.toBytes();
}

/** Base64 of serializeBundle. Used only as a COMPACT ENCODING in the JVM
 *  reference fixture (tests/fixtures/macrodroid/jos-reference.json) — the
 *  macro JSON itself must carry mSerializedBundle as a numeric byte array,
 *  because MacroDroid's importer (Gson) has no base64 adapter for byte[]. */
export function serializeBundleB64(bundle) {
  const bytes = serializeBundle(bundle);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
