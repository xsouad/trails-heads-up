const fs = require('fs');
const path = require('path');

const gameOrder = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/gameOrder.json')));
const characters = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/characters.json')));
const events = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/events.json')));

const orderByTag = {};
gameOrder.forEach(g => { orderByTag[g.tag] = g.order; });

function buildPool(cutoffTag, categories) {
  const cutoffOrder = orderByTag[cutoffTag] || gameOrder.length;
  const pool = [];
  if (categories.includes('characters')) {
    characters.forEach(c => {
      if (c.order !== null && c.order <= cutoffOrder) {
        pool.push({ type: 'character', name: c.name, tag: c.tag, image: c.image });
      }
    });
  }
  if (categories.includes('events')) {
    events.forEach(e => {
      if (e.order !== null && e.order <= cutoffOrder) {
        pool.push({ type: 'event', name: e.text, tag: e.tag, image: e.image });
      }
    });
  }
  // Locations category is a stub until a Locations data tab exists.
  return pool;
}

module.exports = { gameOrder, characters, events, buildPool };
