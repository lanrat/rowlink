// Web Bluetooth connection to the rower, with automatic reconnection.
import { Emitter } from './emitter.js';
import { UUID } from '../protocol/ftms.js';

const NAME_PREFIXES = ['YOSUDA-RM', 'YSD-RM'];
const CHARS = [
  [UUID.ROWER_DATA, 'rower'],
  [UUID.MACHINE_STATUS, 'status'],
  [UUID.TRAINING_STATUS, 'training'],
  [UUID.CONTROL_POINT, 'cp'], // indications carry the replies to our commands
];
const CP_TIMEOUT_MS = 3000;
const CP_GAP_MS = 200; // FED's app waits 200 ms between commands

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY_DELAYS_S = [1, 2, 3, 5, 8, 10];

/** @returns {{ok:boolean, reason?:string}} */
export function bluetoothSupport() {
  if (!globalThis.isSecureContext) {
    return { ok: false, reason: 'This page must be opened over HTTPS or from localhost for Bluetooth to work.' };
  }
  if (!navigator.bluetooth) {
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/.test(ua)) return { ok: false, reason: 'iOS browsers do not support Web Bluetooth. Use Chrome on Android or a computer.' };
    if (/Firefox/.test(ua)) return { ok: false, reason: 'Firefox does not support Web Bluetooth. Use Chrome or Edge.' };
    if (/Linux/.test(ua) && !/Android/.test(ua)) {
      return { ok: false, reason: 'Web Bluetooth is off in this browser. In Chrome, enable chrome://flags/#enable-web-bluetooth and restart.' };
    }
    return { ok: false, reason: 'This browser does not support Web Bluetooth. Use Chrome or Edge.' };
  }
  return { ok: true };
}

export class BleTransport extends Emitter {
  constructor() {
    super();
    this.device = null;
    this.closing = false;
    this.retry = 0;
    this.retryTimer = null;
    this.listening = new WeakSet(); // Chrome may hand back the same characteristic objects after a reconnect
    this.cp = null;
    this.pendingCp = null;
    this.onDisconnected = this.onDisconnected.bind(this);
  }

  now() {
    return performance.now() / 1000;
  }

  /** Show the device picker (needs a user gesture) and connect. */
  async connect() {
    const device = await navigator.bluetooth.requestDevice({
      filters: NAME_PREFIXES.map((namePrefix) => ({ namePrefix })),
      optionalServices: [UUID.FTMS, UUID.DEVICE_INFO],
    });
    await this.use(device);
  }

  /** Reconnect to a previously approved rower without the picker, if the browser allows it. */
  async connectKnown() {
    if (!navigator.bluetooth.getDevices) return false;
    const devices = await navigator.bluetooth.getDevices();
    const device = devices.find((d) => NAME_PREFIXES.some((p) => d.name?.startsWith(p)));
    if (!device) return false;
    await this.use(device);
    return true;
  }

  async use(device) {
    this.device?.removeEventListener('gattserverdisconnected', this.onDisconnected);
    this.device = device;
    this.closing = false;
    device.addEventListener('gattserverdisconnected', this.onDisconnected);
    this.emit('info', { name: device.name, id: device.id });
    this.emit('state', 'connecting');
    await this.open();
  }

  async open() {
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(UUID.FTMS);
    for (const [uuid, name] of CHARS) {
      let ch;
      try {
        ch = await service.getCharacteristic(uuid);
      } catch {
        continue; // optional characteristic missing
      }
      if (!this.listening.has(ch)) {
        this.listening.add(ch);
        ch.addEventListener('characteristicvaluechanged', (e) => {
          const v = e.target.value;
          const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();
          if (name === 'cp') this.onControlReply(bytes);
          this.emit('packet', { t: this.now(), char: name, bytes });
        });
      }
      await ch.startNotifications();
      if (name === 'cp') this.cp = ch;
    }
    this.retry = 0;
    this.emit('state', 'connected');
  }

  /**
   * Zero the rower's counters and start a session, as the FED app does:
   * Request Control (0x00), Reset (0x01), Start/Resume (0x07).
   * The rower answers Reset with a Machine Status "reset" (0x01) notification.
   */
  async resetSession() {
    for (const op of [0x00, 0x01, 0x07]) {
      await this.control(op);
      await sleep(CP_GAP_MS);
    }
  }

  /** Write one FTMS Control Point command and wait for the rower's reply (0x80, op, result). */
  control(op, params = []) {
    if (!this.cp) return Promise.reject(new Error('rower has no control point'));
    this.pendingCp?.reject(new Error('superseded'));
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCp = null;
        reject(new Error(`no reply to command 0x${op.toString(16)}`));
      }, CP_TIMEOUT_MS);
      this.pendingCp = {
        op,
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
    });
    this.cp.writeValueWithResponse(Uint8Array.from([op, ...params])).catch((e) => this.pendingCp?.reject(e));
    return reply;
  }

  onControlReply(bytes) {
    const p = this.pendingCp;
    if (!p || bytes[0] !== 0x80 || bytes[1] !== p.op) return;
    this.pendingCp = null;
    if (bytes[2] === 0x01) p.resolve();
    else p.reject(new Error(`rower refused command 0x${p.op.toString(16)} (result ${bytes[2]})`));
  }

  onDisconnected() {
    if (this.closing) {
      this.emit('state', 'disconnected');
      return;
    }
    this.emit('state', 'reconnecting');
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    clearTimeout(this.retryTimer);
    const delay = RETRY_DELAYS_S[Math.min(this.retry, RETRY_DELAYS_S.length - 1)];
    this.retry++;
    this.retryTimer = setTimeout(async () => {
      if (this.closing) return;
      try {
        await this.open();
      } catch {
        if (!this.device.gatt.connected) this.scheduleReconnect();
      }
    }, delay * 1000);
  }

  disconnect() {
    this.closing = true;
    clearTimeout(this.retryTimer);
    if (this.device?.gatt.connected) this.device.gatt.disconnect();
    else this.emit('state', 'disconnected');
  }
}
