import { expect, fixture, html } from '@open-wc/testing';
import '../../../../shared/components/bridge-table.js';

const COLUMNS = [
  { field: 'name', header: 'Name' },
  { field: 'amount', header: 'Amount', render: (r) => `$${r.amount}` },
];

describe('bridge-table', () => {
  it('renders the empty state when rows is empty', async () => {
    const el = await fixture(html`
      <bridge-table .columns=${COLUMNS} .rows=${[]} empty="No data yet"></bridge-table>
    `);
    expect(el.textContent).to.contain('No data yet');
    expect(el.querySelector('table')).to.equal(null);
  });

  it('renders one row per data entry with default & custom cells', async () => {
    const rows = [
      { name: 'Alice', amount: 12 },
      { name: 'Bob', amount: 34 },
    ];
    const el = await fixture(html`
      <bridge-table .columns=${COLUMNS} .rows=${rows}></bridge-table>
    `);
    const tbody = el.querySelector('tbody');
    expect(tbody.querySelectorAll('tr').length).to.equal(2);
    const cells = tbody.querySelectorAll('tr')[0].querySelectorAll('td');
    expect(cells[0].textContent.trim()).to.equal('Alice');
    expect(cells[1].textContent.trim()).to.equal('$12');
  });

  it('renders header cells from columns[].header', async () => {
    const el = await fixture(html`
      <bridge-table .columns=${COLUMNS} .rows=${[{ name: 'x', amount: 1 }]}></bridge-table>
    `);
    const headers = [...el.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    expect(headers).to.deep.equal(['Name', 'Amount']);
  });

  it('also renders a card view (visible only at narrow container widths via @container)', async () => {
    const rows = [{ name: 'Alice', amount: 12 }];
    const el = await fixture(html`
      <bridge-table .columns=${COLUMNS} .rows=${rows}></bridge-table>
    `);
    // Both views are present in the DOM; @container query controls visibility.
    expect(el.querySelector('.cards')).to.exist;
    expect(el.querySelector('.table-wrap')).to.exist;
  });
});
