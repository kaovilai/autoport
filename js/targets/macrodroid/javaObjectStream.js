// js/targets/macrodroid/javaObjectStream.js — Java Object Serialization
// writer subset, for MacroDroid's LocalePluginAction bundle blobs.
//
// MacroDroid stores a Tasker/Locale plugin's configuration bundle as
// m_pluginInstanceData.mSerializedBundle: a byte[] produced by the
// twofortyfouram locale SDK's BundleSerializer (an ObjectOutputStream
// envelope — see bundleSerializer.js). This module implements the exact
// Java Object Serialization wire format for the value types Tasker plugin
// bundles contain: String, Boolean, Integer, null, byte[] and String[].
//
// Wire format (verified byte-for-byte against a JVM-generated reference,
// tests/fixtures/macrodroid/jos-reference.json, produced by
// scripts/josref/GenRef.java which mirrors the decompiled MacroDroid code):
//
//   stream:  AC ED 00 05                          (magic + version)
//   writeInt: buffered as TC_BLOCKDATA (77 <len> <bytes>), coalescing
//             consecutive primitive writes; flushed before any writeObject
//             and at close
//   String:  74 <u2 len> <modified-UTF-8>          (TC_STRING, new handle)
//   null:    70                                    (TC_NULL, no handle)
//   Boolean: 73 <classdesc Boolean> <1 byte>       (TC_OBJECT)
//   Integer: 73 <classdesc Integer><classdesc Number><70> <4 bytes>
//   byte[]:  75 <classdesc "[B"> <u4 len> <bytes>  (TC_ARRAY)
//   String[]:75 <classdesc "[Ljava.lang.String;"> <u4 len> <elements>
//   classdesc: 72 <u2 len name> <8 suid> <flags> <u2 fieldCount>
//              <fields> 78 70                      (TC_CLASSDESC … TC_ENDBLOCKDATA, TC_NULL)
//   repeated class: 71 00 7e 00 XX                 (TC_REFERENCE to classdesc handle)
//
// Handles count up from 0x7E0000 in stream order; for an object/array the
// classdesc chain consumes its handles BEFORE the object's own handle. Only
// classdescs are ever re-referenced in these streams (all String instances
// are distinct, matching bundles unmarshalled from plugin intents).

const TC_BLOCKDATA = 0x77;
const TC_OBJECT = 0x73;
const TC_CLASSDESC = 0x72;
const TC_STRING = 0x74;
const TC_ARRAY = 0x75;
const TC_ENDBLOCKDATA = 0x78;
const TC_NULL = 0x70;
const TC_REFERENCE = 0x71;

// Class descriptors: name -> { suid: [8 bytes], fields: [[typeCode, name]], super }
const CLASSDESCS = {
  'java.lang.Boolean': { suid: [0xcd, 0x20, 0x72, 0x80, 0xd5, 0x9c, 0xfa, 0xee], fields: [['Z', 'value']], super: null },
  'java.lang.Integer': { suid: [0x12, 0xe2, 0xa0, 0xa4, 0xf7, 0x81, 0x87, 0x38], fields: [['I', 'value']], super: 'java.lang.Number' },
  'java.lang.Number': { suid: [0x86, 0xac, 0x95, 0x1d, 0x0b, 0x94, 0xe0, 0x8b], fields: [], super: null },
  '[B': { suid: [0xac, 0xf3, 0x17, 0xf8, 0x06, 0x08, 0x54, 0xe0], fields: [], super: null },
  '[Ljava.lang.String;': { suid: [0xad, 0xd2, 0x56, 0xe7, 0xe9, 0x1d, 0x7b, 0x47], fields: [], super: null },
};

/** Java's DataOutputStream.writeUTF "modified UTF-8":
 *  NUL -> C0 80, supplementary code points -> two 3-byte surrogate sequences. */
export function modifiedUtf8(str) {
  const out = [];
  // operate on UTF-16 code units, exactly like the JVM
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c === 0x00) {
      out.push(0xc0, 0x80);
    } else if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else {
      // 0x800..0xFFFF: plain 3-byte (surrogates included — this is the
      // "modified" part: supplementary chars are NOT 4-byte UTF-8)
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return out;
}

export class JavaObjectOutputStream {
  constructor() {
    this.bytes = [];
    this.block = [];       // pending TC_BLOCKDATA payload (primitive writes)
    this.nextHandle = 0x7e0000;
    this.classdescHandles = new Map(); // class name -> handle
    this.objectHandles = new Map();    // identity key -> handle (JVM identity dedup)
  }

  // ---- low-level ------------------------------------------------------ //

  raw(...bytes) {
    for (const b of bytes) this.bytes.push(b & 0xff);
  }

  u2(n) {
    this.raw((n >> 8) & 0xff, n & 0xff);
  }

  u4(n) {
    this.raw((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  }

  newHandle() {
    return this.nextHandle++;
  }

  flushBlock() {
    if (this.block.length) {
      if (this.block.length > 255) throw new Error('block data segment over 255 bytes');
      this.raw(TC_BLOCKDATA, this.block.length, ...this.block);
      this.block = [];
    }
  }

  // ---- primitive writes (buffered into block data) --------------------- //

  writeInt(n) {
    if (!Number.isInteger(n) || n < -0x80000000 || n > 0x7fffffff) {
      throw new Error(`writeInt: not a 32-bit integer: ${n}`);
    }
    this.block.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  }

  // ---- object writes --------------------------------------------------- //

  writeUTFString(s) {
    this.flushBlock();
    const utf = modifiedUtf8(String(s));
    if (utf.length > 0xffff) throw new Error('string too long for TC_STRING (needs TC_LONGSTRING)');
    this.newHandle(); // every TC_STRING consumes a handle
    this.raw(TC_STRING);
    this.u2(utf.length);
    this.raw(...utf);
  }

  writeClassDesc(name) {
    const cached = this.classdescHandles.get(name);
    if (cached !== undefined) {
      this.raw(TC_REFERENCE);
      this.u4(cached);
      return;
    }
    const desc = CLASSDESCS[name];
    if (!desc) throw new Error(`unsupported class: ${name}`);
    this.raw(TC_CLASSDESC);
    const nameUtf = modifiedUtf8(name);
    this.u2(nameUtf.length);
    this.raw(...nameUtf);
    this.raw(...desc.suid);
    this.raw(0x02); // SC_SERIALIZABLE
    this.u2(desc.fields.length);
    for (const [typeCode, fieldName] of desc.fields) {
      this.raw(typeCode.charCodeAt(0));
      const fn = modifiedUtf8(fieldName);
      this.u2(fn.length);
      this.raw(...fn);
    }
    this.raw(TC_ENDBLOCKDATA);
    this.classdescHandles.set(name, this.newHandle());
    if (desc.super) {
      this.writeClassDesc(desc.super);
    } else {
      this.raw(TC_NULL);
    }
  }

  writeReference(handle) {
    this.raw(TC_REFERENCE);
    this.u4(handle);
  }

  /** JVM identity dedup. Java's ObjectOutputStream writes a TC_REFERENCE
   *  when the SAME object instance is written twice. Real Android bundles
   *  hit this: Bundle.putBoolean stores the Boolean.TRUE/FALSE singletons,
   *  and Bundle.putInt stores Integer.valueOf results (cached -128..127).
   *  Strings/arrays are always fresh instances from intent unmarshalling —
   *  never deduped. Model exactly that. */
  objectId(value) {
    if (typeof value === 'boolean') return `java.lang.Boolean@${value}`;
    if (typeof value === 'number' && Number.isInteger(value) && value >= -128 && value <= 127) {
      return `java.lang.Integer@${value}`;
    }
    return null; // strings, byte[], String[] — always distinct instances
  }

  writeObject(value) {
    this.flushBlock();
    if (value === null || value === undefined) {
      this.raw(TC_NULL); // no handle
      return;
    }
    const id = this.objectId(value);
    if (id !== null && this.objectHandles.has(id)) {
      this.writeReference(this.objectHandles.get(id));
      return;
    }
    const assign = () => {
      const h = this.newHandle();
      if (id !== null) this.objectHandles.set(id, h);
      return h;
    };
    if (typeof value === 'string') {
      this.writeUTFString(value);
      return;
    }
    if (typeof value === 'boolean') {
      this.raw(TC_OBJECT);
      this.writeClassDesc('java.lang.Boolean');
      assign();
      this.raw(value ? 1 : 0);
      return;
    }
    if (typeof value === 'number' && Number.isInteger(value)) {
      this.raw(TC_OBJECT);
      this.writeClassDesc('java.lang.Integer');
      assign();
      this.u4(value);
      return;
    }
    if (value instanceof Uint8Array) {
      this.raw(TC_ARRAY);
      this.writeClassDesc('[B');
      assign();
      this.u4(value.length);
      this.raw(...value);
      return;
    }
    if (Array.isArray(value)) {
      for (const el of value) {
        if (typeof el !== 'string') throw new Error('only String[] arrays are supported');
      }
      this.raw(TC_ARRAY);
      this.writeClassDesc('[Ljava.lang.String;');
      assign();
      this.u4(value.length);
      for (const el of value) this.writeUTFString(el);
      return;
    }
    throw new Error(`unsupported value type: ${typeof value}`);
  }

  toBytes() {
    this.flushBlock();
    return Uint8Array.from([0xac, 0xed, 0x00, 0x05, ...this.bytes]);
  }
}
