import java.io.ByteArrayOutputStream;
import java.io.ObjectOutputStream;
import java.io.Serializable;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;

/**
 * GenRef — reference generator for the plugin-bundle byte format MacroDroid's
 * LocalePluginAction stores in m_pluginInstanceData.mSerializedBundle.
 *
 * That blob is produced by com.twofortyfouram.locale.sdk.host.internal
 * .BundleSerializer.serializeToByteArray (verified against the decompiled
 * MacroDroid in github.com/Mohsenabn78/macro-reverse-engineering). This class
 * mirrors that method exactly, operating on Map<String,Object> instead of
 * android.os.Bundle (the Bundle is a map wrapper; only the Java Object
 * Serialization wire bytes matter).
 *
 * Envelope (ObjectOutputStream):
 *   writeInt(1)                          version
 *   writeInt(size == 0 ? 0 : 1)          first control code
 *   for each key in case-insensitive sorted order:
 *     value is nested bundle -> writeInt(1); writeObject(key); writeObject(nested bytes)
 *     otherwise              -> writeInt(0); writeObject(key); writeObject(value)
 *     writeInt(last ? 0 : 1)             control code AFTER each entry
 *
 * Values supported (everything Tasker plugin Vals can contain):
 * String, Boolean, Integer, null, String[] (nested bundles recurse).
 *
 * Output: JSON manifest on stdout:
 *   {"vectors":[{"name":...,"bundle":{key:{"t":"s|b|i|n|sa|B","v":...}},"blob":"<base64>"}]}
 *
 * The JS port (js/targets/macrodroid/javaObjectStream.js + bundleSerializer.js)
 * must reproduce every blob byte-for-byte; tests read this manifest.
 *
 * Build & run (no external deps):
 *   javac scripts/josref/GenRef.java -d /tmp/josref
 *   java -cp /tmp/josref GenRef > tests/fixtures/macrodroid/jos-reference.json
 */
public class GenRef {

    static byte[] serialize(Map<String, Object> bundle) throws Exception {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        ObjectOutputStream oos = new ObjectOutputStream(baos);
        oos.writeInt(1); // VERSION_1
        TreeSet<String> keys = new TreeSet<>((a, b) -> a.compareToIgnoreCase(b));
        keys.addAll(bundle.keySet());
        int size = keys.size();
        oos.writeInt(size == 0 ? 0 : 1);
        int i = 0;
        for (String k : keys) {
            Object v = bundle.get(k);
            if (v instanceof Map) {
                oos.writeInt(1); // TYPE_BUNDLE
                oos.writeObject(k);
                oos.writeObject(serialize((Map<String, Object>) v));
            } else {
                if (!(v instanceof Serializable) && v != null) {
                    throw new IllegalArgumentException("not serializable: " + v);
                }
                oos.writeInt(0); // TYPE_SERIALIZABLE
                oos.writeObject(k);
                oos.writeObject(v);
            }
            i++;
            oos.writeInt(i == size ? 0 : 1);
        }
        oos.close();
        return baos.toByteArray();
    }

    // ---- vector construction (new String everywhere: distinct instances,
    // ---- so no TC_REFERENCE dedup — the realistic case for bundles unmarshalled
    // ---- from plugin intents, and what the JS writer produces). --------------

    static String s(String x) { return new String(x); }

    static void add(List<Object[]> out, String name, Object... pairs) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i + 1 < pairs.length; i += 2) m.put((String) pairs[i], pairs[i + 1]);
        out.add(new Object[]{name, m});
    }

    @SuppressWarnings("unchecked")
    static List<Object[]> vectors() {
        List<Object[]> out = new ArrayList<>();

        add(out, "empty");

        add(out, "strings",
                "com.twofortyfouram.locale.intent.extra.BLURB", s("Click the button"),
                "key.two", s("value two"),
                "zz-last", s("z"));

        add(out, "booleans",
                "a", Boolean.TRUE, "b", Boolean.FALSE, "c", Boolean.TRUE);

        add(out, "integers",
                "one", Integer.valueOf(1), "neg", Integer.valueOf(-42), "big", Integer.valueOf(1732635924));

        // repeated small Integer: Integer.valueOf caches -128..127, so both
        // entries hold the SAME instance -> second write is a TC_REFERENCE
        // (mirrors Android Bundle.putInt -> Integer.valueOf)
        add(out, "repeat_integer",
                "first", Integer.valueOf(7), "second", Integer.valueOf(7), "big", Integer.valueOf(100000));

        // null-valued extra: writeObject(null) -> TC_NULL
        add(out, "null_value",
                "NearbyText", null,
                "ActionId", s("com.instagram.android:id/icon_view"));

        // String[] (Tasker RELEVANT_VARIABLES)
        add(out, "string_array",
                "net.dinglisch.android.tasker.RELEVANT_VARIABLES", new String[]{
                        s("%err\nError Code\nOnly available if you select <b>Continue Task After Error</b> and the action ends in error"),
                        s("%errmsg\nError Message"),
                },
                "plain", s("after array"));

        // nested sub-bundle (TYPE_BUNDLE)
        Map<String, Object> nested = new LinkedHashMap<>();
        nested.put("inner.string", s("x"));
        nested.put("inner.flag", Boolean.TRUE);
        nested.put("inner.int", Integer.valueOf(7));
        Map<String, Object> deeper = new LinkedHashMap<>();
        deeper.put("leaf", s("deep"));
        nested.put("deeper", deeper);
        add(out, "nested",
                "outer", s("before"),
                "sub.bundle", nested,
                "after", s("after"));

        // modified-UTF-8 edge cases: NUL, non-BMP (surrogate pair), CJK, accents
        add(out, "utf8",
                "nul", s("a\u0000b"),
                "emoji", s("tap 👆 here"),
                "cjk", s("点击图标"),
                "accent", s("café naïve"));

        // real AutoInput v2 action bundle (CyanBridge ChatGPT handler, corpus)
        add(out, "autoinput_v2_real",
                "com.twoforty44am.placeholder", s("key-ordering: sorted case-insensitively"),
                "com.twofortyfouram.locale.intent.extra.BLURB", s("Fill and send the CyanBridge question in ChatGPT"),
                "net.dinglisch.android.tasker.JSON_ENCODED_KEYS", s("parameters"),
                "net.dinglisch.android.tasker.extras.VARIABLE_REPLACE_KEYS", s("parameters plugininstanceid plugintypeid "),
                "net.dinglisch.android.tasker.subbundled", Boolean.TRUE,
                "parameters", s("{\"_action\":\"waitForElement(id,com.openai.chatgpt:id/composer_edit_text)\\n\\nsetText(id,com.openai.chatgpt:id/composer_edit_text,%question)\\n\\nwaitForElement(id,com.openai.chatgpt:id/send_button)\\n\\nclick(id,com.openai.chatgpt:id/send_button)\\n\",\"_additionalOptions\":{\"checkMs\":\"1000\",\"preActionDelay\":\"250\",\"separator\":\",\",\"withCoordinates\":false},\"_whenToPerformAction\":{\"notInAutoInput\":true,\"notInTasker\":false},\"generatedValues\":{}}"),
                "plugininstanceid", s("f0b1c2d3-4567-489a-bcde-fa0123456789"),
                "plugintypeid", s("com.joaomgcd.autoinput.intent.IntentActionv2"));

        // real AutoInput v1 PerformAction bundle (LaunchInstagram, corpus) —
        // typed per the Vals -type companions, nulls for "<null>" sentinels
        add(out, "autoinput_v1_real",
                "ActionId", s("com.instagram.android:id/icon_view"),
                "ActionType", s("16"),
                "EnableDisableAccessibilityService", null,
                "FieldSelectionType", s("1"),
                "IsFirstAction", Boolean.FALSE,
                "IsTaskerAction", Boolean.FALSE,
                "NearbyText", null,
                "Password", null,
                "RepeatInterval", null,
                "RepeatTimes", null,
                "StoredAction", null,
                "TextToWrite", null,
                "com.twofortyfouram.locale.intent.extra.BLURB", s("Type: Id\nValue: com.instagram.android:id/icon_view\nAction : Click"),
                "net.dinglisch.android.tasker.RELEVANT_VARIABLES", new String[]{
                        s("%err\nError Code\nOnly available if you select <b>Continue Task After Error</b> and the action ends in error"),
                        s("%errmsg\nError Message\nOnly available if you select <b>Continue Task After Error</b> and the action ends in error"),
                },
                "net.dinglisch.android.tasker.extras.VARIABLE_REPLACE_KEYS", s("ActionId FieldSelectionType ActionType plugininstanceid plugintypeid "),
                "net.dinglisch.android.tasker.subbundled", Boolean.TRUE,
                "plugininstanceid", s("b3bb3012-6205-472e-8339-28637b3e2094"),
                "plugintypeid", s("com.joaomgcd.autoinput.intent.IntentPerformAction"));

        return out;
    }

    // ---- tagged JSON emission ------------------------------------------------

    static void esc(StringBuilder sb, String x) {
        sb.append('"');
        for (int i = 0; i < x.length(); i++) {
            char c = x.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        sb.append('"');
    }

    @SuppressWarnings("unchecked")
    static void tagged(StringBuilder sb, Object v) {
        if (v == null) { sb.append("{\"t\":\"n\"}"); return; }
        if (v instanceof String) { sb.append("{\"t\":\"s\",\"v\":"); esc(sb, (String) v); sb.append('}'); return; }
        if (v instanceof Boolean) { sb.append("{\"t\":\"b\",\"v\":").append(v).append('}'); return; }
        if (v instanceof Integer) { sb.append("{\"t\":\"i\",\"v\":").append(v).append('}'); return; }
        if (v instanceof String[]) {
            sb.append("{\"t\":\"sa\",\"v\":[");
            String[] a = (String[]) v;
            for (int i = 0; i < a.length; i++) { if (i > 0) sb.append(','); esc(sb, a[i]); }
            sb.append("]}");
            return;
        }
        if (v instanceof Map) {
            sb.append("{\"t\":\"B\",\"v\":{");
            Map<String, Object> m = (Map<String, Object>) v;
            boolean first = true;
            for (Map.Entry<String, Object> e : m.entrySet()) {
                if (!first) sb.append(',');
                first = false;
                esc(sb, e.getKey());
                sb.append(':');
                tagged(sb, e.getValue());
            }
            sb.append("}}");
            return;
        }
        throw new IllegalArgumentException("unhandled: " + v.getClass());
    }

    public static void main(String[] args) throws Exception {
        List<Object[]> vs = vectors();
        StringBuilder sb = new StringBuilder();
        sb.append("{\"generator\":\"java\",\"vectors\":[");
        boolean first = true;
        for (Object[] v : vs) {
            String name = (String) v[0];
            Map<String, Object> bundle = (Map<String, Object>) v[1];
            byte[] blob = serialize(bundle);
            if (!first) sb.append(',');
            first = false;
            sb.append("{\"name\":");
            esc(sb, name);
            sb.append(",\"bundle\":{");
            boolean fk = true;
            for (Map.Entry<String, Object> e : bundle.entrySet()) {
                if (!fk) sb.append(',');
                fk = false;
                esc(sb, e.getKey());
                sb.append(':');
                tagged(sb, e.getValue());
            }
            sb.append("},\"blob\":\"");
            sb.append(Base64.getEncoder().encodeToString(blob));
            sb.append("\"}");
        }
        sb.append("]}\n");
        System.out.print(sb);
    }
}
