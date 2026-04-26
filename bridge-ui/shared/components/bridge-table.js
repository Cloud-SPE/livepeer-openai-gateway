import { LitElement, html } from 'lit';
import { adoptStyles } from './_adopt-styles.js';

const STYLES = `
@layer components {
  bridge-table {
    display: block;
    container-type: inline-size;
  }
  bridge-table .table-wrap { overflow-x: auto; }
  bridge-table table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--font-size-sm);
  }
  bridge-table thead th {
    text-align: left;
    font-weight: 600;
    color: var(--text-2);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border-1);
    white-space: nowrap;
  }
  bridge-table tbody td {
    padding: var(--space-3);
    border-bottom: 1px solid var(--border-1);
    color: var(--text-1);
    vertical-align: top;
  }
  bridge-table tbody tr:last-child td { border-bottom: 0; }
  bridge-table tbody tr:hover td { background: var(--surface-2); }
  bridge-table .empty {
    padding: var(--space-6);
    text-align: center;
    color: var(--text-3);
  }
  bridge-table .cards { display: none; }

  @container (max-width: 600px) {
    bridge-table .table-wrap { display: none; }
    bridge-table .cards {
      display: grid;
      gap: var(--space-3);
    }
    bridge-table .card {
      background: var(--surface-1);
      border: 1px solid var(--border-1);
      border-radius: var(--radius-md);
      padding: var(--space-3);
      display: grid;
      gap: var(--space-2);
    }
    bridge-table .card .row {
      display: flex;
      justify-content: space-between;
      gap: var(--space-3);
      font-size: var(--font-size-sm);
    }
    bridge-table .card .row .key { color: var(--text-3); }
  }
}
`;

/**
 * Generic table that auto-collapses to a card list under a 600px container
 * width. Consumers pass a columns array and a rows array; each row is an
 * object whose keys match column.field. A column may carry `render(row) =>
 * lit-html` for custom cells.
 *
 * Properties:
 *  - columns: { field: string, header: string, render?: (row) => unknown }[]
 *  - rows:    Record<string, unknown>[]
 *  - empty:   string (shown when rows.length === 0)
 */
export class BridgeTable extends LitElement {
  static properties = {
    columns: { type: Array },
    rows: { type: Array },
    empty: { type: String },
  };

  constructor() {
    super();
    this.columns = [];
    this.rows = [];
    this.empty = 'No rows';
    adoptStyles('bridge-table', STYLES);
  }

  createRenderRoot() { return this; }

  render() {
    if (!this.rows || this.rows.length === 0) {
      return html`<div class="empty">${this.empty}</div>`;
    }
    return html`
      <div class="table-wrap">
        <table>
          <thead>
            <tr>${this.columns.map((c) => html`<th>${c.header}</th>`)}</tr>
          </thead>
          <tbody>
            ${this.rows.map((row) => html`
              <tr>
                ${this.columns.map((c) => html`<td>${c.render ? c.render(row) : row[c.field]}</td>`)}
              </tr>
            `)}
          </tbody>
        </table>
      </div>
      <div class="cards">
        ${this.rows.map((row) => html`
          <div class="card">
            ${this.columns.map((c) => html`
              <div class="row">
                <span class="key">${c.header}</span>
                <span>${c.render ? c.render(row) : row[c.field]}</span>
              </div>
            `)}
          </div>
        `)}
      </div>
    `;
  }
}

if (!customElements.get('bridge-table')) {
  customElements.define('bridge-table', BridgeTable);
}
