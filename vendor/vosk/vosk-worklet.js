// AudioWorklet that forwards microphone samples to the main thread for Vosk.
// Runs on the audio render thread; batches mono frames to cut postMessage churn.
// vosk-browser resamples to the model's rate internally, so we send the raw
// capture-rate samples and pass sampleRate alongside on the main thread.
class VoskCaptureProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._batchSize = 2048; // ~43ms at 48kHz; low latency, few messages
        this._buffer = new Float32Array(this._batchSize);
        this._offset = 0;
    }

    process(inputs) {
        const input = inputs[0];
        if (!input || !input[0]) return true; // no mic frame this quantum
        const channel = input[0]; // already mono (getUserMedia channelCount:1)
        for (let i = 0; i < channel.length; i++) {
            this._buffer[this._offset++] = channel[i];
            if (this._offset === this._batchSize) {
                // Transfer a copy so the render thread can keep filling _buffer.
                const chunk = this._buffer.slice(0);
                this.port.postMessage(chunk, [chunk.buffer]);
                this._offset = 0;
            }
        }
        return true; // keep processor alive
    }
}

registerProcessor('vosk-capture-processor', VoskCaptureProcessor);
