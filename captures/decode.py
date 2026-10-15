import json, sys, struct
FIELDS = [  # (bit, name, size, signed, scale)  bit0 is inverted
 (0,"spm",1,False,0.5),(0,"strokes",2,False,1),(1,"avg_spm",1,False,0.5),(2,"dist",3,False,1),
 (3,"pace",2,False,1),(4,"avg_pace",2,False,1),(5,"power",2,True,1),(6,"avg_power",2,True,1),
 (7,"resist",2,True,1),(8,"kcal",2,False,1),(8,"kcal_h",2,False,1),(8,"kcal_m",1,False,1),
 (9,"hr",1,False,1),(10,"met",1,False,0.1),(11,"elapsed",2,False,1),(12,"remain",2,False,1)]
def parse_rower(b):
    flags = b[0] | b[1] << 8; off = 2; out = {}
    for bit, name, size, signed, scale in FIELDS:
        present = not (flags & 1) if bit == 0 else bool(flags >> bit & 1)
        if not present: continue
        if off + size > len(b): out["_short"] = True; break
        v = int.from_bytes(b[off:off+size], "little", signed=signed); off += size
        out[name] = v * scale
    if off != len(b): out["_extra"] = len(b) - off
    return flags, out
if __name__ == "__main__":
    for line in open(sys.argv[1]):
        r = json.loads(line); b = bytes.fromhex(r["hex"])
        if r["c"] == "rower":
            fl, d = parse_rower(b); print(f'{r["t"]:7.2f} rower fl={fl:04x} len={len(b):2d} {d}')
        else:
            print(f'{r["t"]:7.2f} {r["c"]} {r["hex"]}')
