package com.mistermorph.console;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Reads the console server's JSON answers into maps, lists, strings, doubles, booleans and null.
 * Android's org.json is not on the JDK the JVM tests run on, and the answers the native part reads
 * are small, so this is all it needs.
 */
final class Json {
    private final String text;
    private int at;

    private Json(String text) {
        this.text = text;
    }

    static Object parse(String text) {
        Json json = new Json(text == null ? "" : text);
        json.space();
        Object value = json.value();
        json.space();
        if (json.at != json.text.length()) throw json.error("trailing text");
        return value;
    }

    /** {@code value} when it is a JSON object, else an empty one. */
    static Map<?, ?> object(Object value) {
        return value instanceof Map ? (Map<?, ?>) value : new LinkedHashMap<>();
    }

    static List<?> array(Object value) {
        return value instanceof List ? (List<?>) value : new ArrayList<>();
    }

    static String string(Object value) {
        return value instanceof String ? (String) value : "";
    }

    static long number(Object value, long fallback) {
        return value instanceof Double ? (long) (double) (Double) value : fallback;
    }

    private IllegalArgumentException error(String what) {
        return new IllegalArgumentException("JSON: " + what + " at " + at);
    }

    private void space() {
        while (at < text.length() && Character.isWhitespace(text.charAt(at))) at++;
    }

    private Object value() {
        if (at >= text.length()) throw error("unexpected end");
        char c = text.charAt(at);
        switch (c) {
            case '{':
                return object();
            case '[':
                return array();
            case '"':
                return string();
            case 't':
                return word("true", Boolean.TRUE);
            case 'f':
                return word("false", Boolean.FALSE);
            case 'n':
                return word("null", null);
            default:
                if (c == '-' || (c >= '0' && c <= '9')) return number();
                throw error("unexpected '" + c + "'");
        }
    }

    private Object word(String word, Object value) {
        if (!text.startsWith(word, at)) throw error("unexpected word");
        at += word.length();
        return value;
    }

    private Map<String, Object> object() {
        Map<String, Object> out = new LinkedHashMap<>();
        at++;
        space();
        if (at < text.length() && text.charAt(at) == '}') {
            at++;
            return out;
        }
        while (true) {
            space();
            if (at >= text.length() || text.charAt(at) != '"') throw error("expected a key");
            String key = string();
            space();
            expect(':');
            space();
            out.put(key, value());
            space();
            if (at < text.length() && text.charAt(at) == ',') {
                at++;
                continue;
            }
            expect('}');
            return out;
        }
    }

    private List<Object> array() {
        List<Object> out = new ArrayList<>();
        at++;
        space();
        if (at < text.length() && text.charAt(at) == ']') {
            at++;
            return out;
        }
        while (true) {
            space();
            out.add(value());
            space();
            if (at < text.length() && text.charAt(at) == ',') {
                at++;
                continue;
            }
            expect(']');
            return out;
        }
    }

    private void expect(char c) {
        if (at >= text.length() || text.charAt(at) != c) throw error("expected '" + c + "'");
        at++;
    }

    private String string() {
        StringBuilder out = new StringBuilder();
        at++;
        while (true) {
            if (at >= text.length()) throw error("unterminated string");
            char c = text.charAt(at++);
            if (c == '"') return out.toString();
            if (c != '\\') {
                out.append(c);
                continue;
            }
            if (at >= text.length()) throw error("unterminated escape");
            char e = text.charAt(at++);
            switch (e) {
                case 'b':
                    out.append('\b');
                    break;
                case 'f':
                    out.append('\f');
                    break;
                case 'n':
                    out.append('\n');
                    break;
                case 'r':
                    out.append('\r');
                    break;
                case 't':
                    out.append('\t');
                    break;
                case 'u':
                    if (at + 4 > text.length()) throw error("short \\u escape");
                    try {
                        out.append((char) Integer.parseInt(text.substring(at, at + 4), 16));
                    } catch (NumberFormatException ex) {
                        throw error("bad \\u escape");
                    }
                    at += 4;
                    break;
                default:
                    out.append(e);
            }
        }
    }

    private Double number() {
        int start = at;
        if (text.charAt(at) == '-') at++;
        while (at < text.length() && "0123456789.eE+-".indexOf(text.charAt(at)) >= 0) at++;
        try {
            return Double.valueOf(text.substring(start, at));
        } catch (NumberFormatException e) {
            throw error("bad number");
        }
    }
}
