'use strict';
// Linux top bar item with a text label next to the icon (StatusNotifierItem + dbusmenu).
// Electron's own Tray cannot show text on Linux, and GNOME squashes wide icons to a square.
const dbus = require('dbus-next');

const { Interface } = dbus.interface;
const { Variant, Message } = dbus;

class Item extends Interface {
  constructor(icon, menuPath) {
    super('org.kde.StatusNotifierItem');
    Object.assign(this, {
      Category: 'ApplicationStatus', Id: 'ally', Title: 'Ally', Status: 'Active',
      IconName: icon, ItemIsMenu: true, Menu: menuPath, XAyatanaLabel: '', XAyatanaLabelGuide: '100% ⚑',
    });
  }
  Activate() {}
  SecondaryActivate() {}
  ContextMenu() {}
  Scroll() {}
  XAyatanaNewLabel(label, guide) { return [label, guide]; }
}
const read = (signature) => ({ signature, access: 'read' });
Item.configureMembers({
  properties: {
    Category: read('s'), Id: read('s'), Title: read('s'), Status: read('s'), IconName: read('s'),
    ItemIsMenu: read('b'), Menu: read('o'), XAyatanaLabel: read('s'), XAyatanaLabelGuide: read('s'),
  },
  methods: {
    Activate: { inSignature: 'ii', outSignature: '' },
    SecondaryActivate: { inSignature: 'ii', outSignature: '' },
    ContextMenu: { inSignature: 'ii', outSignature: '' },
    Scroll: { inSignature: 'is', outSignature: '' },
  },
  signals: { XAyatanaNewLabel: { signature: 'ss' } },
});

// Flat menu: id 0 is the root, item n of `items` has id n + 1.
class DbusMenu extends Interface {
  constructor() {
    super('com.canonical.dbusmenu');
    Object.assign(this, { Version: 3, TextDirection: 'ltr', Status: 'normal', IconThemePath: [] });
    this.items = [];
    this.revision = 1;
  }
  props(id) {
    if (id === 0) return { 'children-display': new Variant('s', 'submenu') };
    const it = this.items[id - 1] || {};
    if (it.type === 'separator') return { type: new Variant('s', 'separator') };
    return { label: new Variant('s', it.label || ''), enabled: new Variant('b', it.enabled !== false) };
  }
  click(id, event) { if (event === 'clicked') this.items[id - 1]?.click?.(); }
  GetLayout(parent) {
    const children = parent === 0 ? this.items.map((_, i) => new Variant('(ia{sv}av)', [i + 1, this.props(i + 1), []])) : [];
    return [this.revision, [parent, this.props(parent), children]];
  }
  GetGroupProperties(ids) {
    return (ids.length ? ids : [0, ...this.items.map((_, i) => i + 1)]).map((id) => [id, this.props(id)]);
  }
  GetProperty(id, name) { return this.props(id)[name] || new Variant('s', ''); }
  Event(id, event) { this.click(id, event); }
  EventGroup(events) { for (const [id, event] of events) this.click(id, event); return []; }
  AboutToShow() { return false; }
  AboutToShowGroup() { return [[], []]; }
  LayoutUpdated(revision, parent) { return [revision, parent]; }
}
DbusMenu.configureMembers({
  properties: { Version: read('u'), TextDirection: read('s'), Status: read('s'), IconThemePath: read('as') },
  methods: {
    GetLayout: { inSignature: 'iias', outSignature: 'u(ia{sv}av)' },
    GetGroupProperties: { inSignature: 'aias', outSignature: 'a(ia{sv})' },
    GetProperty: { inSignature: 'is', outSignature: 'v' },
    Event: { inSignature: 'isvu', outSignature: '' },
    EventGroup: { inSignature: 'a(isvu)', outSignature: 'ai' },
    AboutToShow: { inSignature: 'i', outSignature: 'b' },
    AboutToShowGroup: { inSignature: 'ai', outSignature: 'aiai' },
  },
  signals: { LayoutUpdated: { signature: 'ui' } },
});

// Rejects when there is no session bus or no tray host (no AppIndicator extension).
async function createIndicator(icon) {
  const bus = dbus.sessionBus();
  bus.on('error', () => {});
  const name = `org.kde.StatusNotifierItem-${process.pid}-1`;
  const menu = new DbusMenu();
  const item = new Item(icon, '/MenuBar');
  await bus.requestName(name);
  bus.export('/MenuBar', menu);
  bus.export('/StatusNotifierItem', item);
  await bus.call(new Message({
    destination: 'org.kde.StatusNotifierWatcher', path: '/StatusNotifierWatcher',
    interface: 'org.kde.StatusNotifierWatcher', member: 'RegisterStatusNotifierItem',
    signature: 's', body: [name],
  }));

  let shown = '';
  return {
    update(label, items) {
      menu.items = items;
      if (label !== item.XAyatanaLabel) {
        item.XAyatanaLabel = label;
        item.XAyatanaNewLabel(label, item.XAyatanaLabelGuide);
      }
      const key = items.map((i) => i.label).join('\n');
      if (key !== shown) {
        shown = key;
        menu.LayoutUpdated(++menu.revision, 0);
      }
    },
  };
}

module.exports = { createIndicator };
