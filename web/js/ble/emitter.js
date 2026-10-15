// Minimal event emitter shared by all transports.
// Transports emit:
//   'packet' {t, char: 'rower'|'status'|'training', bytes: Uint8Array}
//   'state'  'disconnected'|'connecting'|'connected'|'reconnecting'
//   'info'   {name, ...}  (device details, optional)
export class Emitter {
  constructor() {
    this.handlers = {};
  }

  on(event, fn) {
    (this.handlers[event] ??= []).push(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    this.handlers[event] = (this.handlers[event] ?? []).filter((h) => h !== fn);
  }

  emit(event, data) {
    for (const fn of this.handlers[event] ?? []) fn(data);
  }
}
