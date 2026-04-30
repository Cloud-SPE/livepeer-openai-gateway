/**
 * ObservableController — Lit ReactiveController that subscribes to an RxJS
 * Observable on hostConnected and unsubscribes on hostDisconnected. Each
 * emission writes into `this.value` and triggers `host.requestUpdate()`.
 *
 * Usage in a LitElement:
 *
 *   constructor() {
 *     super();
 *     this.account = new ObservableController(this, accountService.account$);
 *   }
 *   render() { return html`<p>${this.account.value?.email ?? '...'}</p>`; }
 */
export class ObservableController {
  /**
   * @param {import('lit').ReactiveControllerHost} host
   * @param {import('rxjs').Observable<unknown>} observable
   * @param {unknown} [initial]
   */
  constructor(host, observable, initial = undefined) {
    this.host = host;
    this.observable = observable;
    this.value = initial;
    this._sub = null;
    host.addController(this);
  }

  hostConnected() {
    this._sub = this.observable.subscribe((v) => {
      this.value = v;
      this.host.requestUpdate();
    });
  }

  hostDisconnected() {
    if (this._sub) {
      this._sub.unsubscribe();
      this._sub = null;
    }
  }
}
