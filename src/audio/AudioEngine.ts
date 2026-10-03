import { Analyzer } from './Analyzer';
import type { AudioFeatures } from './Analyzer';

export type AudioMode = 'off' | 'mic' | 'file';

const SILENCE: AudioFeatures = { low: 0, mid: 0, high: 0, level: 0, onset: 0, kick: 0, flux: 0 };

/** Audio input (microphone or a looping file) feeding an AnalyserNode. */
export class AudioEngine {
  mode: AudioMode = 'off';
  label = '';
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private analyzer: Analyzer | null = null;
  private freq: Float32Array<ArrayBuffer> | null = null;
  private stream: MediaStream | null = null;
  private source: AudioNode | null = null;
  private fileNode: AudioBufferSourceNode | null = null;

  private ensure(): { ctx: AudioContext; analyser: AnalyserNode } {
    if (!this.ctx || !this.analyser) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0;
      this.analyzer = new Analyzer(this.analyser.frequencyBinCount, this.ctx.sampleRate);
      this.freq = new Float32Array(this.analyser.frequencyBinCount);
    }
    return { ctx: this.ctx, analyser: this.analyser };
  }

  /** Microphone with the browser's voice processing switched off (it would wreck the analysis). */
  async useMic(): Promise<void> {
    const { ctx, analyser } = this.ensure();
    await ctx.resume();
    this.stop();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const node = ctx.createMediaStreamSource(this.stream);
    node.connect(analyser);
    this.source = node;
    this.mode = 'mic';
    this.label = this.stream.getAudioTracks()[0]?.label ?? 'microphone';
  }

  /** Plays a file in a loop through the speakers and analyses it directly. */
  async useFile(file: File | string): Promise<void> {
    const { ctx, analyser } = this.ensure();
    await ctx.resume();
    this.stop();
    const data = typeof file === 'string' ? await (await fetch(file)).arrayBuffer() : await file.arrayBuffer();
    const buffer = await ctx.decodeAudioData(data);
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.loop = true;
    node.connect(analyser);
    node.connect(ctx.destination);
    node.start();
    this.fileNode = node;
    this.source = node;
    this.mode = 'file';
    this.label = typeof file === 'string' ? file.split('/').pop() ?? file : file.name;
  }

  stop(): void {
    try {
      this.fileNode?.stop();
    } catch {
      /* already stopped */
    }
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.fileNode = null;
    this.source = null;
    this.stream = null;
    this.mode = 'off';
    this.label = '';
  }

  read(dt: number): AudioFeatures {
    if (this.mode === 'off' || !this.analyser || !this.analyzer || !this.freq) return SILENCE;
    this.analyser.getFloatFrequencyData(this.freq);
    return this.analyzer.process(this.freq, dt);
  }
}
