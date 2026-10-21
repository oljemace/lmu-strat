/* AudioWorklet « lmu-rnnoise » : réduction de bruit RNNoise (voir NOTICE.txt).
   Entrée mono à 48 kHz, traitée par blocs de 480 échantillons (10 ms).
   Paramètres :
     bypass : 1 = le son passe sans traitement
     vad    : 0 = désactivé ; sinon seuil de probabilité de parole (0..1) en dessous duquel
              le son est coupé (réduction « forte »)
   Le module envoie {ready:true} quand RNNoise est chargé, ou {error:…} s'il échoue. */
import createRNNWasmModuleSync from './rnnoise-sync.js';

const FRAME = 480;
const RING = 4096, MASK = RING - 1;
const PREFILL_BLOCKS = 6;      // tampon de départ : évite les coupures dues au découpage 128 → 480

class LmuRnnoise extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            { name: 'bypass', defaultValue: 0, minValue: 0, maxValue: 1 },
            { name: 'vad', defaultValue: 0, minValue: 0, maxValue: 1 }
        ];
    }

    constructor() {
        super();
        this.mod = null; this.ctx = 0; this.ptr = 0;
        this.inR = new Float32Array(RING); this.outR = new Float32Array(RING);
        this.inW = 0; this.inRd = 0; this.inN = 0;
        this.outW = 0; this.outRd = 0; this.outN = 0;
        this.blocks = 0; this.gain = 1; this.hold = 0;
        try {
            const m = createRNNWasmModuleSync();
            Promise.resolve(m && m.ready ? m.ready : m).then(mod => {
                mod = mod || m;
                this.ctx = mod._rnnoise_create(0);
                this.ptr = mod._malloc(FRAME * 4);
                this.mod = mod;
                this.port.postMessage({ ready: true });
            }).catch(e => this.port.postMessage({ error: String(e && e.message || e) }));
        } catch (e) {
            this.port.postMessage({ error: String(e && e.message || e) });
        }
    }

    process(inputs, outputs, params) {
        const inp = inputs[0], out = outputs[0];
        if (!out || !out.length) return true;
        const n = out[0].length;
        const x = inp && inp[0];
        if (!x) { for (let c = 0; c < out.length; c++) out[c].fill(0); return true; }

        if (params.bypass[0] >= 0.5) {
            for (let c = 0; c < out.length; c++) out[c].set(inp[c] || x);
            this.inN = this.outN = this.blocks = 0;
            return true;
        }
        if (!this.mod) { for (let c = 0; c < out.length; c++) out[c].fill(0); return true; }

        for (let i = 0; i < n; i++) this.inR[(this.inW + i) & MASK] = x[i];
        this.inW = (this.inW + n) & MASK;
        this.inN += n;
        this.blocks++;

        const vadThr = params.vad[0];
        while (this.inN >= FRAME) {
            const H = this.mod.HEAPF32, base = this.ptr >> 2;
            for (let i = 0; i < FRAME; i++) H[base + i] = this.inR[(this.inRd + i) & MASK] * 32768;
            this.inRd = (this.inRd + FRAME) & MASK;
            this.inN -= FRAME;

            const vad = this.mod._rnnoise_process_frame(this.ctx, this.ptr, this.ptr);

            if (vadThr <= 0 || vad >= vadThr) this.hold = 10; else this.hold--;
            const target = (vadThr <= 0 || this.hold > 0) ? 1 : 0;
            const g0 = this.gain;
            const g1 = g0 + (target - g0) * (target > g0 ? 0.6 : 0.25);
            const H2 = this.mod.HEAPF32;
            for (let i = 0; i < FRAME; i++) {
                this.outR[(this.outW + i) & MASK] = (H2[base + i] / 32768) * (g0 + (g1 - g0) * (i / FRAME));
            }
            this.outW = (this.outW + FRAME) & MASK;
            this.outN += FRAME;
            this.gain = g1;
        }

        if (this.blocks >= PREFILL_BLOCKS && this.outN >= n) {
            for (let i = 0; i < n; i++) out[0][i] = this.outR[(this.outRd + i) & MASK];
            this.outRd = (this.outRd + n) & MASK;
            this.outN -= n;
            for (let c = 1; c < out.length; c++) out[c].set(out[0]);
        } else {
            for (let c = 0; c < out.length; c++) out[c].fill(0);
        }
        return true;
    }
}

registerProcessor('lmu-rnnoise', LmuRnnoise);
