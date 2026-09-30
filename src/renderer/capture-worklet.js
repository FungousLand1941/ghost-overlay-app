// Audio capture on the audio thread. Collects mono samples into 4096-sample
// blocks and posts them to the page. Unlike a ScriptProcessor (which runs on
// the UI thread and silently drops audio whenever the page is busy rendering
// an answer), nothing is ever lost here: blocks queue until the page reads them.
class GhostCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(4096);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      let i = 0;
      while (i < ch.length) {
        const k = Math.min(ch.length - i, this.buf.length - this.n);
        this.buf.set(ch.subarray(i, i + k), this.n);
        this.n += k; i += k;
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(4096);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('ghost-capture', GhostCapture);
