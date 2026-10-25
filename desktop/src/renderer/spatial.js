// Moving between buttons with the D-pad or arrow keys: from the focused element, the nearest one in
// that direction. Used wherever the controller has to reach ordinary buttons (Setup, Library
// Check, the banner, empty pages, dialogs). Pure geometry, so it's tested without a window
// (test/spatial.test.js).
(function (exports) {
  /**
   * The index of the rect to move to from rects[from] in direction ('up' | 'down' | 'left' | 'right'),
   * or -1 when there's nothing that way. Rects are { left, top, right, bottom }.
   *
   * A candidate has to lie in that direction (its centre past the current one's centre). One in
   * line (overlapping the same row for ← →, the same column for ↑ ↓) always beats one that isn't:
   * from a button, → goes to the button on its right in the same row before a closer one on the
   * row below. Otherwise the nearest wins.
   */
  function nextInDirection(rects, from, direction) {
    const a = rects[from];
    if (!a) return -1;
    const centre = (r) => ({ x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 });
    const c = centre(a);
    let best = -1;
    let bestScore = Infinity;
    rects.forEach((r, i) => {
      if (i === from) return;
      const d = centre(r);
      let ahead;
      let across;
      if (direction === 'left') { ahead = c.x - r.right; across = Math.abs(d.y - c.y); if (d.x >= c.x) return; }
      else if (direction === 'right') { ahead = r.left - c.x; across = Math.abs(d.y - c.y); if (d.x <= c.x) return; }
      else if (direction === 'up') { ahead = c.y - r.bottom; across = Math.abs(d.x - c.x); if (d.y >= c.y) return; }
      else if (direction === 'down') { ahead = r.top - c.y; across = Math.abs(d.x - c.x); if (d.y <= c.y) return; }
      else return;
      // Overlapping in the other axis (the same row or column) counts as in line.
      const overlap = direction === 'left' || direction === 'right'
        ? Math.min(a.bottom, r.bottom) - Math.max(a.top, r.top)
        : Math.min(a.right, r.right) - Math.max(a.left, r.left);
      // In line always wins over out of line; among those in line, nearer and more centred wins.
      const score = overlap > 0 ? Math.max(0, ahead) + across * 0.25 : 1e6 + Math.max(0, ahead) + across * 3;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    });
    return best;
  }

  exports.nextInDirection = nextInDirection;
})(typeof module === 'object' ? module.exports : (window.SPATIAL = {}));
