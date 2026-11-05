"""Import light-ctrl channel board 2 into a WireBender board file.

    python3 tools/import_channel_board.py /path/to/light-ctrl/re/boards \
        > data/channel-board-2.wirebender.json

Reads the generator `channel_board.py` (imported as a module; build() and
land_wires() are never called, so the perfwire solver is not needed) and the
generated `channel_board.json` beside it (for the landed wire ends).

Also writes `data/channel-board-2.expected-pins.json`: every pin id
(`<ref>.<footprint pin>`) and the hole the source puts it in. The test
`tests/core/channel-board-2.test.ts` places every part with core `placePart`
and compares; a wrong `at` / rotation / flip fails there.
"""

import json
import os
import sys

sys.dont_write_bytecode = True  # never leave __pycache__ in the source repo

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
PINS_OUT = os.path.join(REPO, "data", "channel-board-2.expected-pins.json")


def die(msg):
    sys.stderr.write("import_channel_board: %s\n" % msg)
    sys.exit(1)


def hname(xy):
    col, row = xy
    return "%s%d" % (chr(ord("A") + row - 1), col)


# Source family -> footprint, and the placement that reproduces the source holes
# (controller ruling; the expected-pins test is the authority).
IC_PLACEMENT = {
    "JA": ("terminal-2p-508", "A3", 0, False),
    "JB": ("terminal-2p-508", "A15", 0, True),
    "J3": ("terminal-2p-508", "A7", 0, False),
    "KA": ("relay-g5v2", "D3", 0, False),
    "KB": ("relay-g5v2", "D12", 0, False),
    "QA": ("to220-gds", "O5", 270, False),
    "QB": ("to220-gds", "O13", 90, False),
    "U1": ("dip8", "W8", 270, False),
    "JH": ("header-1x5", "W18", 180, False),
}
TERMINALS = {"JA", "JB", "J3"}
FOOTPRINT_PINS = {
    "terminal-2p-508": ["1", "2"],
    "relay-g5v2": ["1", "16", "4", "13", "6", "11", "8", "9"],
    "to220-gds": ["G", "D", "S"],
    "dip8": ["1", "2", "3", "4", "5", "6", "7", "8"],
    "header-1x5": ["1", "2", "3", "4", "5"],
}
ROLE = {"in": "in", "out": "out", "oc": "oc", "pwr": "pwr", "pwr_in": "pwr"}


def two_lead_footprint(pid, kind, family):
    if family and family.startswith("Polyfuse"):
        return "polyfuse-radial"
    if kind == "r":
        return "axial"           # resistors and the 1N4001 lift diodes
    if kind == "disc":
        return "cap-disc"        # C1
    die("no footprint for two-lead part %s (%s, %s)" % (pid, kind, family))


def main():
    if len(sys.argv) != 2:
        die("usage: import_channel_board.py <light-ctrl/re/boards folder>")
    src = os.path.abspath(sys.argv[1])
    sys.path.insert(0, src)
    import channel_board as cb   # noqa: E402  (lazy solver import: safe)
    import audit_board as ab     # noqa: E402  (imports solver: needs re/perfwire)

    with open(os.path.join(src, "channel_board.json")) as f:
        landed = json.load(f)

    expected = {}
    parts = []

    # ---- parts with fixed footprints -------------------------------------------
    for pid, family, label, pins, ptypes in cb.IC_PARTS:
        if pid not in IC_PLACEMENT:
            die("no placement for %s (%s)" % (pid, family))
        fp, at, rot, flip = IC_PLACEMENT[pid]
        src_keys = list(pins)
        if pid in TERMINALS:
            # Source pin keys (W1/W2, GND/V12) -> footprint pins 1/2 in source order.
            name_of = {k: str(i + 1) for i, k in enumerate(src_keys)}
            label = "%s (%s)" % (label, ", ".join("%s=%s" % (name_of[k], k) for k in src_keys))
        else:
            name_of = {k: k for k in src_keys}
        fp_pins = {n: None for n in FOOTPRINT_PINS[fp]}
        roles = {}
        for k, (hole, net) in pins.items():
            n = name_of[k]
            if n not in fp_pins:
                die("%s: source pin %s is not a %s pin" % (pid, k, fp))
            fp_pins[n] = net
            expected["%s.%s" % (pid, n)] = hole
            if k in ptypes:
                if ptypes[k] not in ROLE:
                    die("%s.%s: unknown pin type %s" % (pid, k, ptypes[k]))
                roles[n] = ROLE[ptypes[k]]
        if pid == "U1":
            # NC legs: pins 1 and 8 stay null; their holes still come from the source.
            nc = {"1": cb.U1_HOLES["1"], "8": cb.U1_HOLES["8"]}
            if sorted(nc.values()) != sorted(cb.NC_LEGS):
                die("U1 NC legs %s do not match NC_LEGS %s" % (nc, cb.NC_LEGS))
            for n, hole in nc.items():
                expected["U1.%s" % n] = hole
        missing = [n for n, v in fp_pins.items() if v is None and "%s.%s" % (pid, n) not in expected]
        if missing:
            die("%s: footprint pins %s have no source hole" % (pid, missing))
        part = {"ref": pid, "footprint": fp, "at": at, "rotation": rot}
        if flip:
            part["flip"] = True
        part.update({"value": family, "label": label, "pins": fp_pins})
        if roles:
            part["roles"] = roles
        parts.append(part)

    # ---- two-lead parts ----------------------------------------------------------
    for pid, kind, family, label, (ha, na), (hb, nb), extra in cb.TWO_LEAD:
        unknown = set(extra) - {"standing"}
        if unknown:
            die("%s: unhandled extra %s" % (pid, unknown))
        part = {"ref": pid, "footprint": two_lead_footprint(pid, kind, family), "at": ha, "to": hb,
                "rotation": 0}
        if extra.get("standing"):
            part["standing"] = True
        if family:
            part["value"] = family
        part.update({"label": label, "pins": {"a": na, "b": nb}})
        parts.append(part)
        expected["%s.a" % pid] = ha
        expected["%s.b" % pid] = hb

    # Every source lead is a pin here, at the same hole.
    for lead, v in landed["leads"].items():
        ref, pin = lead.split(".", 1)
        if ref in TERMINALS:
            src_keys = list(dict((p[0], p) for p in cb.IC_PARTS)[ref][3])
            pin = str(src_keys.index(pin) + 1)
        key = "%s.%s" % (ref, pin)
        if expected.get(key) != hname(v["at"]):
            die("lead %s: source hole %s, import %s" % (lead, hname(v["at"]), expected.get(key)))

    # ---- bare wire: trails, and lift-chain links as leg folds --------------------
    lift_links = {tuple(b) for b in cb._br_a + cb._br_b}
    anode_of = {}  # anode hole -> diode ref
    cathode_of = {}
    for pid, _k, _f, _l, (ha, _na), (hb, _nb), _e in cb.TWO_LEAD:
        anode_of[ha] = pid
        cathode_of[hb] = pid
    leg_folds = []
    for k, a in lift_links:
        if k not in cathode_of or a not in anode_of:
            die("lift link %s-%s is not cathode -> anode" % (k, a))
        leg_folds.append({"lead": "%s.b" % cathode_of[k], "to": a})
    leg_folds.sort(key=lambda f: (f["lead"][:2], int(f["lead"][2:-2])))

    lead_holes = set(expected.values())
    wire_ends = set()
    for w in landed["wires"]:
        for e in (w["a"], w["b"]):
            wire_ends.add(hname(e["hole"]))

    def run_holes(points):
        out = []
        for p0, p1 in zip(points, points[1:]):
            (c0, r0), (c1, r1) = cb.h(p0), cb.h(p1)
            if c0 != c1 and r0 != r1:
                die("diagonal trail step %s -> %s" % (p0, p1))
            dc, dr = (c1 > c0) - (c1 < c0), (r1 > r0) - (r1 < r0)
            c, r = c0, r0
            out.append(hname((c, r)))
            while (c, r) != (c1, r1):
                c, r = c + dc, r + dr
                out.append(hname((c, r)))
        return list(dict.fromkeys(out))

    trail_src = [t for t in cb.BARE if tuple(t) not in lift_links]
    if len(trail_src) != len(cb.BARE) - len(lift_links):
        die("lift links not all found in BARE")
    paths = [run_holes(list(t)) for t in trail_src]
    trails = []
    for i, (t, holes) in enumerate(zip(trail_src, paths)):
        others = set()
        for j, hs in enumerate(paths):
            if j != i:
                others |= set(hs)   # another trail over or ending at this hole: soldered joint
        joints = [x for x in holes if x in lead_holes or x in wire_ends or x in others
                  or x in (t[0], t[-1])]
        trails.append({"id": "T%d" % (i + 1), "side": "bottom", "points": list(t), "joints": joints})

    # ---- insulated wires: landed ends from channel_board.json --------------------
    wires, bridges = [], []
    for i, w in enumerate(landed["wires"]):
        a, b = hname(w["a"]["hole"]), hname(w["b"]["hole"])
        wire = {"id": "W%d" % (i + 1), "kind": "flying", "side": "bottom", "points": [a, b]}
        if w["net"] in cb.NET_COLORS:
            wire["color"] = cb.NET_COLORS[w["net"]]
        wire.update({"bareSegments": [], "joints": []})
        wires.append(wire)
        for e in (w["a"], w["b"]):
            if "bridgeTo" in e:
                bridges.append({"side": "bottom", "a": hname(e["hole"]), "b": hname(e["bridgeTo"])})

    # ---- nets, classes, rules from audit_board.BOARD_CFG -------------------------
    cfg = ab.BOARD_CFG
    class_name = {"PWR": "GND", "HV12": "HV12", "LOGIC": "LOGIC"}
    class_of = {}
    for cname, nets in cfg["net_classes"].items():
        for n in nets:
            class_of[n] = class_name[cname]
    all_nets = []
    for p in parts:
        for n in p["pins"].values():
            if n is not None and n not in all_nets:
                all_nets.append(n)
    nets = {}
    for n in sorted(all_nets):
        if n not in class_of:
            die("net %s has no class in BOARD_CFG" % n)
        e = {"class": class_of[n]}
        if n in cb.NET_COLORS:
            e["color"] = cb.NET_COLORS[n]
        nets[n] = e
    keep_away = []
    for cname, (others, holes) in cfg["keep_away"].items():
        for o in others:
            keep_away.append({"a": class_name[cname], "b": class_name[o], "holes": holes})

    board = {
        "format": "wirebender/1",
        "revision": 0,
        "name": "Channel board 2",
        "board": {"cols": cb.COLS, "rows": cb.ROWS, "pitchMm": 2.54, "type": "one-sided", "blocked": []},
        "netClasses": {"GND": {}, "HV12": {}, "LOGIC": {}},
        "nets": nets,
        "rules": {
            "keepAway": keep_away,
            "adjacency": [{"classes": ["HV12", "GND"], "level": "supply"},
                          {"classes": ["HV12", "LOGIC"], "level": "mcu"}],
        },
        "parts": parts,
        "trails": trails,
        "wires": wires,
        "legFolds": leg_folds,
        "solderBridges": bridges,
        "bench": {"endLeadMm": 5, "bendAllowanceMm": 1, "spareMm": 5, "flyingSlackMm": 10, "roundToMm": 5},
    }
    os.makedirs(os.path.dirname(PINS_OUT), exist_ok=True)
    with open(PINS_OUT, "w") as f:
        json.dump(dict(sorted(expected.items())), f, indent=2)
        f.write("\n")
    json.dump(board, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
