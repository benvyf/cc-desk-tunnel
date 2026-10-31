// Two independent presses belong to one live conversation run. Expiry needs no timer or polling.
export class StopSequence {
  private first: { key: string; at: number } | undefined;
  reset() {
    this.first = undefined;
  }
  press(key: string, now: number): boolean {
    const first = this.first;
    this.reset();
    if (first?.key === key && now >= first.at && now - first.at <= 500) return true;
    this.first = { key, at: now };
    return false;
  }
}
