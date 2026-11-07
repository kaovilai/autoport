#!/usr/bin/env python3
"""TaskerData XML -> IR parser (full-fidelity path for AutoPort).

Usage: python3 -I taskerXml.py <input.xml> [--codes data/taskerCodes.json] [--out out.json]

Handles Tasker exports:
  * root <TaskerData sr="" dvi="1" tv="6.x">
  * <Task> (nme/id/pri) with <Action sr="actN" ve="7"> children
  * <Profile> with <Event sr="conN"/><State sr="conN"> contexts (each carrying <code>)
  * linked tasks: inline <Task> child of <Profile>, or <midK>N</midK> task-id refs
  * <Project> wrapping Tasks/Profiles (+tids/scenesEnabled)
  * typed args: <Str sr="argK" ve="3">, <Int sr="argK" val="N">, <Long>, <Float>,
    <Bundle sr="argK"><Vals>... (flattened, -type companion keys preserved),
    <App sr="argK"> (appPkg/appClass/label), Tasker StringArray-in-Str values
  * %variable extraction from every arg string.

Unmapped codes never raise: kind becomes "plugin" (code >= FIRST_PLUGIN_CODE with a
plugin package in arg1) or "unknown", and codeName is "unknown (code N)".
"""
import argparse
import json
import os
import re
import sys
import xml.etree.ElementTree as ET

VAR_RE = re.compile(r"%([a-zA-Z][a-zA-Z0-9_]+)")
# Tasker convention: %lowercase = local (incl. %par1), %UPPER = global/builtin

NUMERIC_TAGS = {"Int": int, "Long": int, "Float": float}
CONTEXT_TAGS = {"Event": "event", "State": "state"}


def strip_ns(tag):
    return tag.rsplit("}", 1)[-1]


def local_text(el):
    return (el.text or "").strip()


def decode_string_array(text):
    """Tasker serializes StringArray as escaped XML inside a Str value."""
    if not text or not text.lstrip().startswith("<StringArray"):
        return None
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return None
    items = []
    for child in root:
        items.append(child.text if child.text is not None else "")
    return items


def parse_arg(el):
    """Convert one typed arg element into a JSON-native value."""
    tag = strip_ns(el.tag)
    if tag in NUMERIC_TAGS:
        raw = el.get("val")
        if raw is None:
            # e.g. <Int sr="arg1"><var>%priority+1</var></Int> — expression, not a literal
            var = el.find("var")
            if var is not None:
                return {"$var": local_text(var)}
            return None
        try:
            return NUMERIC_TAGS[tag](raw)
        except (TypeError, ValueError):
            return raw
    if tag == "Str":
        txt = el.text if el.text is not None else ""
        arr = decode_string_array(txt)
        if arr is not None:
            return {"$array": arr}
        return txt
    if tag == "Bundle":
        return parse_bundle(el)
    if tag == "App":
        out = {}
        for c in el:
            out[strip_ns(c.tag)] = local_text(c)
        return {"$app": out}
    if tag == "StringArray":
        return {"$array": [local_text(c) for c in el]}
    # scalar metadata-style elements (<mon>true</mon>, <tue>false</tue>) -> plain value
    if not len(el) and el.get("val") is None:
        return local_text(el)
    # generic fallback: keep everything so nothing is silently lost
    out = {"$tag": tag}
    if el.get("val") is not None:
        out["val"] = el.get("val")
    if el.text and el.text.strip():
        out["text"] = el.text.strip()
    kids = [parse_arg(c) for c in el]
    if kids:
        out["children"] = kids
    return out


def parse_bundle(el):
    """<Bundle sr="argK"><Vals sr="val"><KEY>v</KEY><KEY-type>t</KEY-type>...

    Flatten the inner extras into one dict; -type companion keys are preserved
    verbatim (they drive type reconstruction for the target adapter).
    """
    out = {}
    for vals in el:
        if strip_ns(vals.tag) != "Vals":
            out["$nonVals:" + strip_ns(vals.tag)] = parse_arg(vals)
            continue
        for item in vals:
            key = strip_ns(item.tag)
            if len(item):  # nested container inside a Vals entry
                out[key] = [parse_arg(c) for c in item]
            else:
                txt = item.text if item.text is not None else ""
                arr = decode_string_array(txt)
                out[key] = {"$array": arr} if arr is not None else txt
    return {"$bundle": out}


def collect_args(parent, skip_tags=("code",), extra_named=False):
    args = {}
    for child in parent:
        tag = strip_ns(child.tag)
        if tag in skip_tags:
            continue
        sr = child.get("sr") or ""
        if sr.startswith("arg") or tag in ("Bundle", "App", "Str", "Int", "Long", "Float"):
            key = sr if sr else tag.lower()
            args[key] = parse_arg(child)
        elif extra_named:
            # context payloads carry bare named children (Time: fh/fm/th/tm, Day: mon/tue...)
            args[sr or tag.lower()] = parse_arg(child)
    return args


def parse_condition_list(el, sr_key):
    conds = []
    for c in el:
        tag = strip_ns(c.tag)
        if tag != "Condition":
            continue
        item = {"tag": tag, "sr": c.get("sr"), "ve": c.get("ve")}
        for part in c:
            pt = strip_ns(part.tag)
            item[pt] = parse_arg(part) if pt not in ("lhs", "rhs", "op") else local_text(part)
        conds.append(item)
    return {"sr": sr_key or el.get("sr"), "conditions": conds}


def vars_of_element(el, skip_tags=("Share",)):
    """All %var refs anywhere in an element subtree (text + val attrs), minus metadata."""
    found = set()
    def walk(e):
        for t in (e.text or "", e.get("val") or ""):
            for m in VAR_RE.finditer(t):
                found.add(m.group(1))
        for ch in e:
            if strip_ns(ch.tag) in skip_tags:
                continue
            walk(ch)
    walk(el)
    return found


def walk_strings(value, found):
    if isinstance(value, str):
        for m in VAR_RE.finditer(value):
            found.add(m.group(1))
    elif isinstance(value, dict):
        for v in value.values():
            walk_strings(v, found)
    elif isinstance(value, list):
        for v in value:
            walk_strings(v, found)


def classify_vars(names):
    local = sorted(n for n in names if n[:1].islower() or n.startswith("par"))
    glob = sorted(n for n in names if not (n[:1].islower() or n.startswith("par")))
    return {"local": ["%" + n for n in local], "global": ["%" + n for n in glob]}


class CodeTable:
    def __init__(self, path):
        self.data = json.load(open(path, encoding="utf-8")) if path and os.path.exists(path) else {}
        self.actions = self.data.get("actions", {})
        self.events = self.data.get("events", {})
        self.states = self.data.get("states", {})
        self.by = {
            "actions": self.data.get("byCode", {}).get("actions", {}),
            "events": self.data.get("byCode", {}).get("events", {}),
            "states": self.data.get("byCode", {}).get("states", {}),
        }
        self.first_plugin = {
            fam: self.data.get("specials", {}).get(fam, {}).get("FIRST_PLUGIN_CODE")
            for fam in ("actions", "events", "states")
        }

    def lookup(self, family, code):
        key = {"event": "events", "state": "states"}.get(family, family)
        return self.by.get(key, {}).get(str(code))


class Parser:
    def __init__(self, codes, path):
        self.codes = codes
        self.path = path
        self.parsed = {}    # id(element) -> parsed task dict (parse each task once)
        self.consumed_ids = set()  # task ids already emitted as profile macros
        self.stats = {"actionsTotal": 0, "actionsDecoded": 0, "actionsPlugin": 0,
                      "actionsUnknown": 0, "contextsTotal": 0, "contextsDecoded": 0,
                      "contextsUnknown": 0, "unrepresentable": []}

    # ---- tasks / profiles -------------------------------------------------
    def parse_action(self, el, index):
        self.stats["actionsTotal"] += 1
        code_txt = None
        for c in el:
            if strip_ns(c.tag) == "code":
                code_txt = local_text(c)
                break
        try:
            code = int(code_txt) if code_txt is not None else None
        except ValueError:
            code = None
        args = collect_args(el, skip_tags=("code", "ConditionList"), extra_named=True)
        action = {
            "kind": "unknown",
            "code": code,
            "codeName": "unknown (code %s)" % (code_txt,),
            "args": args,
            "sr": el.get("sr"),
            "ve": el.get("ve"),
        }
        conds = [parse_condition_list(c, c.get("sr")) for c in el if strip_ns(c.tag) == "ConditionList"]
        if conds:
            action["condition"] = conds[0] if len(conds) == 1 else conds
        action["_refs"] = sorted(vars_of_element(el))
        name = self.codes.lookup("actions", code) if code is not None else None
        fp = self.codes.first_plugin.get("actions") or 1000
        if name:
            action["kind"] = "builtin"
            action["codeName"] = name
            self.stats["actionsDecoded"] += 1
        elif code is not None and code >= fp:
            pkg = args.get("arg1")
            action["kind"] = "plugin"
            action["package"] = pkg if isinstance(pkg, str) else None
            action["pluginClass"] = args.get("arg2") if isinstance(args.get("arg2"), str) else None
            # plugin identity lives in arg1/arg2, not in the numeric code
            action["codeName"] = "PLUGIN(%s)" % (action.get("package") or "unknown")
            self.stats["actionsPlugin"] += 1
            self.stats["unrepresentable"].append(
                "plugin bundle action code=%s package=%s: inner extras kept raw, "
                "no semantic op decode (AutoInput decoder is a separate workstream)"
                % (code, action.get("package")))
        else:
            self.stats["actionsUnknown"] += 1
            self.stats["unrepresentable"].append(
                "unknown action code %r at %s/%s" % (code_txt, el.get("sr"), index))
        return action

    def parse_task(self, el):
        if id(el) in self.parsed:
            return self.parsed[id(el)]
        task = {
            "taskId": local_text(el.find("id")) if el.find("id") is not None else None,
            "name": local_text(el.find("nme")) if el.find("nme") is not None else None,
            "priority": local_text(el.find("pri")) if el.find("pri") is not None else None,
            "sr": el.get("sr"),
            "actions": [],
        }
        img = el.find("Img")
        if img is not None:
            task["icon"] = {strip_ns(c.tag): local_text(c) for c in img}
        share = el.find("Share")
        if share is not None:
            task["share"] = {strip_ns(c.tag): local_text(c) for c in share}
        idx = 0
        for child in el:
            if strip_ns(child.tag) == "Action":
                task["actions"].append(self.parse_action(child, idx))
                idx += 1
        self.parsed[id(el)] = task
        return task

    def parse_context(self, el):
        tag = strip_ns(el.tag)
        family = CONTEXT_TAGS.get(tag, tag.lower())
        self.stats["contextsTotal"] += 1
        code = None
        code_el = el.find("code")
        if code_el is not None:
            try:
                code = int(local_text(code_el))
            except ValueError:
                code = None
        ctx = {
            "family": family,
            "code": code,
            "codeName": None,
            "args": collect_args(el, extra_named=True),
            "sr": el.get("sr"),
            "ve": el.get("ve"),
            "_refs": sorted(vars_of_element(el)),
        }
        name = self.codes.lookup(family, code) if code is not None else None
        if name is None and family not in ("event", "state") and code is None:
            # Time/Day/Location contexts have no numeric code table entry
            ctx["codeName"] = family.upper()
            self.stats["contextsDecoded"] += 1
            return ctx
        if name:
            ctx["codeName"] = name
            self.stats["contextsDecoded"] += 1
        else:
            ctx["codeName"] = "unknown (code %s)" % (code,)
            self.stats["contextsUnknown"] += 1
            self.stats["unrepresentable"].append(
                "unknown %s context code %r (agent may be a plugin context)" % (family, code))
        return ctx

    def build_macro(self, name, triggers, actions, task_ids=None, extra=None):
        names = set()
        for a in actions:
            walk_strings(a["args"], names)
            names.update(a.pop("_refs", []))   # refs incl. ConditionList / <var> exprs
        for t in triggers:
            walk_strings(t["args"], names)
            names.update(t.pop("_refs", []))
        macro = {
            "name": name,
            "triggers": triggers,
            "actions": actions,
            "variables": classify_vars(names),
        }
        if task_ids:
            macro["taskIds"] = task_ids
        if extra:
            macro.update(extra)
        return macro

    # ---- root -------------------------------------------------------------
    def parse(self):
        raw = open(self.path, "rb").read()
        if raw.startswith(b"\xef\xbb\xbf"):
            raw = raw[3:]          # UTF-8 BOM from some file managers breaks ET.parse
        if b"<!DOCTYPE" in raw[:8192] or b"<!ENTITY" in raw[:8192]:
            # real Tasker exports never declare entities; refuse to risk expansion bombs
            raise SystemExit("refusing XML with DOCTYPE/ENTITY declaration: %s" % self.path)
        root = ET.fromstring(raw)
        if strip_ns(root.tag) != "TaskerData":
            raise SystemExit("not a TaskerData document: %s" % root.tag)
        version = root.get("tv")
        macros = []
        projects = []
        task_index = {}   # taskId -> task dict (for <midK> refs)
        consumed = set()  # id()s of Task elements already turned into macros

        def index_tasks(el):
            for child in el:
                tag = strip_ns(child.tag)
                if tag == "Task":
                    t = self.parse_task(child)
                    if t["taskId"] is not None:
                        task_index[str(t["taskId"])] = t
                if tag in ("Task", "Project", "Profile", "Data", "Scene"):
                    index_tasks(child)

        index_tasks(root)

        def profile_macro(el):
            triggers = []
            for child in el:
                sr = child.get("sr") or ""
                if re.match(r"^con\d+$", sr):
                    triggers.append(self.parse_context(child))
            inline_task = el.find("Task")
            actions = []
            task_ids = []
            if inline_task is not None:
                consumed.add(id(inline_task))
                t = self.parse_task(inline_task)
                actions = t["actions"]
                if t["taskId"]:
                    task_ids.append(t["taskId"])
            refs = [local_text(c) for c in el if strip_ns(c.tag).startswith("mid")]
            for r in refs:
                if r not in task_ids:
                    task_ids.append(r)
            for ref in refs:
                t = task_index.get(str(ref))
                self.consumed_ids.add(str(ref))
                if t is not None and not actions:
                    actions = t["actions"]
            name_el = el.find("nme")
            name = local_text(name_el) if name_el is not None else "Profile %s" % (el.get("sr"),)
            meta = {}
            share = el.find("Share")
            if share is not None:
                for part in share:
                    pt = strip_ns(part.tag)
                    meta[{"d": "description", "g": "tags", "p": "public", "t": "title", "b": "button"}.get(pt, pt)] = local_text(part)
            for part in el:
                pt = strip_ns(part.tag)
                if pt in ("cdate", "edate", "limit", "enabled", "pri", "flags", "clp"):
                    meta[pt] = local_text(part)
            return self.build_macro(name, triggers, actions, task_ids,
                                    {"kind": "profile", "meta": meta,
                                     "profileId": local_text(el.find("id")) if el.find("id") is not None else None,
                                     "enabled": (local_text(el.find("enabled")) or "true")
                                     if el.find("enabled") is not None else None,
                                     "sr": el.get("sr")})

        def emit_tasks(el):
            for child in el:
                tag = strip_ns(child.tag)
                if tag == "Task":
                    tid = local_text(child.find("id")) if child.find("id") is not None else None
                    if id(child) in consumed or (tid is not None and str(tid) in self.consumed_ids):
                        continue
                    t = task_index.get(str(tid)) if tid is not None else None
                    t = t or self.parse_task(child)
                    extra = {"kind": "task", "sr": t.get("sr")}
                    meta = {}
                    if t.get("icon"):
                        meta["icon"] = t["icon"]
                    sh = t.get("share") or {}
                    for k, v in sh.items():
                        meta[{"d": "description", "g": "tags", "p": "public",
                              "t": "title", "b": "button"}.get(k, k)] = v
                    if meta:
                        extra["meta"] = meta
                    macros.append(self.build_macro(t["name"] or "Task %s" % t["taskId"],
                                                   [], t["actions"],
                                                   [t["taskId"]] if t["taskId"] else [], extra))
                elif tag == "Profile":
                    macros.append(profile_macro(child))
                    emit_tasks(child)
                elif tag == "Project":
                    pid = local_text(child.find("id")) if child.find("id") is not None else None
                    pname = local_text(child.find("nme")) if child.find("nme") is not None else None
                    tids = local_text(child.find("tids")).split(",") if child.find("tids") is not None else []
                    proj = {"id": pid, "name": pname, "taskIds": [x for x in tids if x],
                            "profileIds": [x for x in (local_text(child.find("pids")).split(",")
                                                        if child.find("pids") is not None else []) if x]}
                    if child.find("name") is not None:
                        proj["displayName"] = local_text(child.find("name"))
                    img = child.find("Img")
                    if img is not None:
                        proj["icon"] = {strip_ns(c.tag): local_text(c) for c in img}
                    projects.append(proj)
                    projects[-1].update({"taskIds": [x for x in tids if x],
                                     "scenesEnabled": local_text(child.find("scenesEnabled"))
                                     if child.find("scenesEnabled") is not None else None,
                                     "sr": child.get("sr")})
                    emit_tasks(child)
                elif tag == "Data":  # full-backup exports wrap everything in <Data>
                    emit_tasks(child)
                elif tag in ("Scene", "SceneElement"):
                    self.stats["unrepresentable"].append(
                        "scene element <%s> not represented in IR (no scene target in Phase 1)" % tag)
                    emit_tasks(child)

        # pre-pass: profiles reference their action task via <midK>; suppress the
        # standalone task macro so one automation appears exactly once in the IR
        for el in root.iter():
            if strip_ns(el.tag) == "Profile":
                for c in el:
                    if strip_ns(c.tag).startswith("mid"):
                        self.consumed_ids.add(local_text(c))

        # full-backup exports wrap the same children under <Data>; descend generically
        emit_tasks(root)

        ir = {
            "source": {"app": "tasker", "file": os.path.basename(self.path), "taskerVersion": version},
            "macros": macros,
        }
        if projects:
            ir["projects"] = projects
        return ir


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("--codes", default=os.path.join(os.path.dirname(__file__), "..", "data", "taskerCodes.json"))
    ap.add_argument("--out")
    ap.add_argument("--stats")
    a = ap.parse_args()
    codes = CodeTable(a.codes)
    p = Parser(codes, a.input)
    try:
        ir = p.parse()
    except SystemExit:
        raise
    except ET.ParseError as e:
        # a truncated / non-Tasker file must yield a friendly error, never a stack trace
        ir = {"source": {"app": "tasker", "file": os.path.basename(a.input), "taskerVersion": None},
              "error": {"kind": "parse", "message": str(e)}, "macros": []}
        if a.out:
            open(a.out, "w", encoding="utf-8").write(json.dumps(ir, indent=1) + "\n")
        sys.stderr.write("parse error: %s\n" % e)
        raise SystemExit(2)
    text = json.dumps(ir, indent=1, ensure_ascii=False) + "\n"
    if a.out:
        os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
        open(a.out, "w", encoding="utf-8").write(text)
    else:
        sys.stdout.write(text)
    if a.stats:
        st = dict(p.stats)
        st["fixture"] = os.path.basename(a.input)
        st["macros"] = len(ir["macros"])
        st["actions"] = sum(len(m["actions"]) for m in ir["macros"])
        st["triggers"] = sum(len(m["triggers"]) for m in ir["macros"])
        st["variableCount"] = {"local": sorted({v for m in ir["macros"] for v in m["variables"]["local"]}),
                               "global": sorted({v for m in ir["macros"] for v in m["variables"]["global"]})}
        os.makedirs(os.path.dirname(a.stats) or ".", exist_ok=True)
        open(a.stats, "w", encoding="utf-8").write(json.dumps(st, indent=1) + "\n")
        print(json.dumps(st, indent=1))


if __name__ == "__main__":
    main()
