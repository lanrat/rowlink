// The rower splits each 1 Hz record into two notifications:
//   A: More Data bit set (averages, distance, pace, power)
//   B: More Data bit clear (stroke rate/count, kcal, elapsed)
// Buffer A and emit one merged frame when B arrives.

export class Assembler {
  constructor() {
    this.pending = null;
  }

  /** @returns {{t:number, fields:object}|null} a complete frame, or null while waiting for the second half */
  push(t, parsed) {
    if (parsed.moreData) {
      this.pending = { ...parsed.fields }; // a newer A replaces an orphaned one
      return null;
    }
    const fields = { ...this.pending, ...parsed.fields };
    this.pending = null;
    return { t, fields };
  }

  reset() {
    this.pending = null;
  }
}
