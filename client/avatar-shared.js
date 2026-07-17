// Shared avatar builder logic used by both Trails Heads Up (app.js) and
// Trails Guess Who (guesswho.js). Loaded before both, on both pages, so a
// player's avatar (and the sprites/layer rules behind it) is identical and
// stays in sync between the two games via sessionStorage.

const AVATAR_STORAGE_KEY = 'trailsHeadsUp_avatar';

function saveAvatar(a) { sessionStorage.setItem(AVATAR_STORAGE_KEY, JSON.stringify(a)); }
function loadAvatar() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(AVATAR_STORAGE_KEY));
    if (parsed && parsed.base && parsed.face && parsed.hat) return parsed;
  } catch (e) { /* ignore malformed/missing data */ }
  return null;
}

// The hat/Accessories cycle always treats its FIRST value (1) as "no
// accessory" and is also the default, rather than needing a real blank image
// file. Values 2-4 map to your actual accessory sprites hat_1.png-hat_3.png
// (shifted down by one). If you add a real 4th accessory later, add it as
// hat_4.png and bump this count to 5.
const LAYER_COUNTS = { base: 6, face: 9, hat: 4 };

// SPINSTELLE unlocks this many extra HIDDEN accessories beyond the normal hat
// count above, for whenever you've made bonus/secret accessory sprites. They
// continue the same hat_N.png numbering right after your normal ones -- with
// hat: 4 normal (3 real + blank), the first secret one is hat_4.png, the next
// is hat_5.png, and so on. Bump this number as you add more secret sprites.
const BONUS_HAT_COUNT = 2;

let avatar = loadAvatar() || { base: 1, face: 1, hat: 1 };

// If a prank swap has happened, the avatar object gets a `prank: true` flag
// (see the roomState handler / server) and renders as a single fixed image
// instead of the normal layered base/face/hat stack.
function renderAvatarStage(container, avatarObj) {
  container.innerHTML = '';
  if (avatarObj && avatarObj.prank) {
    const img = document.createElement('img');
    img.src = 'assets/avatar/prank.png';
    container.appendChild(img);
    return;
  }
  ['base', 'face', 'hat'].forEach(layer => {
    if (layer === 'hat') {
      // "No accessory" is value 1 (the default) -- simply renders nothing.
      // Real accessory sprites are values 2-4, mapped down to hat_1-hat_3.
      if (avatarObj.hat === 1) return;
      const img = document.createElement('img');
      img.src = `assets/avatar/hat/hat_${avatarObj.hat - 1}.png`;
      container.appendChild(img);
      return;
    }
    const img = document.createElement('img');
    img.src = `assets/avatar/${layer}/${layer}_${avatarObj[layer]}.png`;
    container.appendChild(img);
  });
}

// Hidden accessories, unlocked for this tab only by typing SPINSTELLE into the
// hidden input on the Heads Up home screen. Nobody who hasn't unlocked it can
// reach past the normal accessory set with the arrows or the dice.
let cheatAccessoriesUnlocked = false;
function effectiveLayerCount(layer) {
  if (layer === 'hat' && cheatAccessoriesUnlocked) return LAYER_COUNTS.hat + BONUS_HAT_COUNT;
  return LAYER_COUNTS[layer];
}
