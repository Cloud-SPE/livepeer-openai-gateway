import { describe, it, expect } from 'vitest';
import { BehaviorSubject } from 'rxjs';
import { ObservableController } from '../controllers/observable-controller.js';

function makeFakeHost() {
  /** @type {Array<unknown>} */
  const updates = [];
  const controllers = [];
  const host = {
    addController(c) {
      controllers.push(c);
    },
    requestUpdate() {
      updates.push(Date.now());
    },
    /* test helpers */
    get updateCount() {
      return updates.length;
    },
    fireConnect() {
      for (const c of controllers) c.hostConnected();
    },
    fireDisconnect() {
      for (const c of controllers) c.hostDisconnected();
    },
  };
  return host;
}

describe('ObservableController', () => {
  it('subscribes on hostConnected and stores the latest value', () => {
    const subject = new BehaviorSubject(null);
    const host = makeFakeHost();
    const ctrl = new ObservableController(host, subject.asObservable());
    expect(ctrl.value).toBeUndefined();

    host.fireConnect();
    // BehaviorSubject emits initial value synchronously on subscribe
    expect(ctrl.value).toBeNull();
    expect(host.updateCount).toBe(1);

    subject.next({ id: 'x' });
    expect(ctrl.value).toEqual({ id: 'x' });
    expect(host.updateCount).toBe(2);
  });

  it('unsubscribes on hostDisconnected — no further updates', () => {
    const subject = new BehaviorSubject('a');
    const host = makeFakeHost();
    const ctrl = new ObservableController(host, subject.asObservable());

    host.fireConnect();
    expect(host.updateCount).toBe(1);

    host.fireDisconnect();
    subject.next('b');
    expect(ctrl.value).toBe('a'); // last value before unsubscribe
    expect(host.updateCount).toBe(1);
  });

  it('handles connect → disconnect → connect lifecycle', () => {
    const subject = new BehaviorSubject(0);
    const host = makeFakeHost();
    const ctrl = new ObservableController(host, subject.asObservable());

    host.fireConnect();
    subject.next(1);
    host.fireDisconnect();
    subject.next(2); // dropped
    host.fireConnect();
    expect(ctrl.value).toBe(2); // latest from BehaviorSubject on re-subscribe
    subject.next(3);
    expect(ctrl.value).toBe(3);
  });

  it('uses the initial value before any subscribe', () => {
    const subject = new BehaviorSubject(99);
    const host = makeFakeHost();
    const ctrl = new ObservableController(host, subject.asObservable(), 'placeholder');
    expect(ctrl.value).toBe('placeholder');
  });
});
