import { expect, fixture, html, oneEvent } from '@open-wc/testing';
import '../../../../shared/components/bridge-popover-menu.js';

describe('bridge-popover-menu', () => {
  const items = [
    { label: 'Refund', value: 'refund' },
    { label: 'Suspend', value: 'suspend', danger: true },
  ];

  it('renders a trigger button with label', async () => {
    const el = await fixture(html`
      <bridge-popover-menu label="Actions" .items=${items}></bridge-popover-menu>
    `);
    const trigger = el.querySelector('bridge-button');
    expect(trigger).to.exist;
    expect(trigger.textContent).to.contain('Actions');
  });

  it('renders one item button per item', async () => {
    const el = await fixture(html`
      <bridge-popover-menu label="Actions" .items=${items}></bridge-popover-menu>
    `);
    const itemButtons = el.querySelectorAll('.item');
    expect(itemButtons.length).to.equal(2);
    expect(itemButtons[0].textContent.trim()).to.equal('Refund');
    expect(itemButtons[1].textContent.trim()).to.equal('Suspend');
  });

  it('marks danger items with the data-danger attribute', async () => {
    const el = await fixture(html`
      <bridge-popover-menu label="Actions" .items=${items}></bridge-popover-menu>
    `);
    const itemButtons = el.querySelectorAll('.item');
    expect(itemButtons[0].hasAttribute('data-danger')).to.equal(false);
    expect(itemButtons[1].hasAttribute('data-danger')).to.equal(true);
  });

  it('emits bridge-select with the chosen item value on click', async () => {
    const el = await fixture(html`
      <bridge-popover-menu label="Actions" .items=${items}></bridge-popover-menu>
    `);
    setTimeout(() => el.querySelectorAll('.item')[0].click(), 0);
    const evt = await oneEvent(el, 'bridge-select');
    expect(evt.detail.value).to.equal('refund');
  });

  it('uses popovertarget that matches the popover id', async () => {
    const el = await fixture(html`
      <bridge-popover-menu label="Actions" .items=${items}></bridge-popover-menu>
    `);
    const trigger = el.querySelector('bridge-button');
    const popover = el.querySelector('[popover]');
    expect(popover.id).to.equal(trigger.getAttribute('popovertarget'));
  });
});
