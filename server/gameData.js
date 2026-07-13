const fs = require('fs');
const path = require('path');

const gameOrder = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/gameOrder.json')));
const characters = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/characters.json')));
const events = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/events.json')));

const orderByTag = {};
gameOrder.forEach(g => { orderByTag[g.tag] = g.order; });

// Order is always derived live from each entry's `tag` (looked up against
// gameOrder.json), never trusted from a stored number. This means when you add a
// new character/event by hand, you only ever need to set its `tag` correctly --
// there's no separate order number that can drift out of sync or get typo'd.
function orderForTag(tag) {
  return Object.prototype.hasOwnProperty.call(orderByTag, tag) ? orderByTag[tag] : null;
}

function buildPool(cutoffTag, categories) {
  // Fail SAFE, not open: if cutoffTag is ever missing/unrecognized, restrict to the
  // very first game (order 1) rather than defaulting to "allow everything," which
  // would silently defeat the entire point of the spoiler cutoff.
  const hasTag = Object.prototype.hasOwnProperty.call(orderByTag, cutoffTag);
  if (!hasTag) {
    console.warn('buildPool called with unrecognized cutoffTag:', cutoffTag, '-- defaulting to most restrictive (FC only)');
  }
  const cutoffOrder = hasTag ? orderByTag[cutoffTag] : 1;
  const pool = [];
  if (categories.includes('characters')) {
    characters.forEach(c => {
      const order = orderForTag(c.tag);
      if (order !== null && order <= cutoffOrder) {
        pool.push({ type: 'character', name: c.name, tag: c.tag, image: c.image });
      }
    });
  }
  if (categories.includes('events')) {
    events.forEach(e => {
      const order = orderForTag(e.tag);
      if (order !== null && order <= cutoffOrder) {
        pool.push({ type: 'event', name: e.text, tag: e.tag, image: e.image });
      }
    });
  }
  // Locations category is a stub until a Locations data tab/data file exists.
  return pool;
}

module.exports = { gameOrder, characters, events, buildPool };
