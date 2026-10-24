// Track mode for the piano roll: every note of the focused free track on the
// absolute timeline, clips drawn as bands, full editing.
//
// The roll (pianoroll.js, seq.js) gets its clip from focusedClipObjects() and
// edits it through clip.notes (push/splice) and note.start/beats/midi. In
// track mode that function hands out a *virtual clip* spanning the track:
// its `notes` is a proxy array over the clips' notes, and each note is a
// proxy whose `start` is absolute. Writes go back to the real clip:
//   - moving a note inside its clip just rebases its start;
//   - moving it into another clip re-homes it there;
//   - moving it outside every clip stretches its own clip to cover it;
//   - new notes land in the clip under them, or get a one-bar clip of their own;
//   - erasing removes the note from its clip.
// Undo, autosave and the engine model all see only the real clips.

SEQ.prTrackMode = false;
try { SEQ.prTrackMode = localStorage.getItem('chord-pad-pr-mode') === 'track'; } catch (_) {}

(function _trackRoll() {
  const owner   = new WeakMap();   // real note -> { clip, track }
  const proxies = new WeakMap();   // real note -> proxy
  const vclips  = new WeakMap();   // track -> virtual clip

  function clipAt(track, beat) {
    return track.items.find(c => beat >= c.start && beat < c.start + c.beats) || null;
  }

  // Stretch a clip so [absStart, absStart + beats] lies inside it, keeping
  // every other note where it sounds (their starts are clip-relative).
  function coverWithClip(clip, absStart, beats) {
    if (absStart < clip.start) {
      const delta = clip.start - absStart;
      for (const n of clip.notes) n.start += delta;
      clip.start -= delta;
      clip.beats += delta;
    }
    const end = absStart + Math.max(0, beats || 0);
    if (end > clip.start + clip.beats) clip.beats = end - clip.start;
  }

  function placeNote(track, note, absStart) {
    const home = owner.get(note);
    let target = clipAt(track, absStart);
    if (home && target && target !== home.clip) {
      // Re-home into the clip under the new position.
      const i = home.clip.notes.indexOf(note);
      if (i >= 0) home.clip.notes.splice(i, 1);
      target.notes.push(note);
      owner.set(note, { clip: target, track });
    } else if (home && !target) {
      // Nothing there: the note's own clip grows to keep it.
      target = home.clip;
      coverWithClip(target, absStart, note.beats);
    } else if (!home) {
      if (!target) {
        const bpb = state.beatsPerBar || 4;
        target = makeClip({ start: Math.floor(absStart / bpb) * bpb, beats: bpb });
        track.items.push(target);
        track.items.sort((a, b) => a.start - b.start);
      }
      target.notes.push(note);
      owner.set(note, { clip: target, track });
      coverWithClip(target, absStart, note.beats);
    }
    note.start = absStart - target.start;
    if (typeof invalidateFreeTrackFlat === 'function') invalidateFreeTrackFlat(track);
  }

  const noteHandler = {
    get(t, k) {
      if (k === 'start') { const o = owner.get(t); return t.start + (o ? o.clip.start : 0); }
      if (k === '__real') return t;
      return Reflect.get(t, k);
    },
    set(t, k, v) {
      if (k === 'start') {
        const o = owner.get(t);
        if (o) placeNote(o.track, t, v); else t.start = v;
        return true;
      }
      if (k === 'beats') {
        t.beats = v;
        const o = owner.get(t);
        if (o) { coverWithClip(o.clip, o.clip.start + t.start, v); if (typeof invalidateFreeTrackFlat === 'function') invalidateFreeTrackFlat(o.track); }
        return true;
      }
      return Reflect.set(t, k, v);
    },
  };

  function proxyFor(note, clip, track) {
    owner.set(note, { clip, track });
    let p = proxies.get(note);
    if (!p) { p = new Proxy(note, noteHandler); proxies.set(note, p); }
    return p;
  }

  // Clips in arrangement order, notes in clip order: the order the roll saw
  // at render time stays valid for its index-based erase until it re-renders.
  function mergedNotes(track) {
    const out = [];
    for (const c of track.items) for (const n of c.notes) out.push(proxyFor(n, c, track));
    return out;
  }

  const notesHandler = {
    get(arr, k, recv) {
      if (k === 'push') return (...items) => {
        for (const it of items) {
          const real = it && it.__real ? it.__real : it;
          const abs  = typeof real.start === 'number' ? real.start : 0;
          owner.delete(real);
          placeNote(arr.__track, real, abs);
        }
        return arr.length + items.length;
      };
      if (k === 'splice') return (i, n = 1, ...ins) => {
        const removed = arr.slice(i, i + n);
        for (const p of removed) {
          const real = p && p.__real ? p.__real : p;
          const o = owner.get(real);
          if (!o) continue;
          const j = o.clip.notes.indexOf(real);
          if (j >= 0) o.clip.notes.splice(j, 1);
          owner.delete(real);
        }
        if (ins.length) recv.push(...ins);
        if (typeof invalidateFreeTrackFlat === 'function') invalidateFreeTrackFlat(arr.__track);
        return removed;
      };
      return Reflect.get(arr, k, recv);
    },
  };

  function virtualClip(track) {
    let v = vclips.get(track);
    if (!v) {
      v = {
        get id() { return 'track:' + track.id; },
        virtual: true,
        track,
        start: 0,
        get label() { return track.name + ' · all clips'; },
        get beats() {
          let end = 0;
          for (const c of track.items) end = Math.max(end, c.start + c.beats);
          return Math.max(state.beatsPerBar || 4, end);
        },
        set beats(_) {},
        get notes() {
          const arr = mergedNotes(track);
          arr.__track = track;
          return new Proxy(arr, notesHandler);
        },
        set notes(_) {},
      };
      vclips.set(track, v);
    }
    return v;
  }

  // ---- hook the roll ----
  const _focused = focusedClipObjects;
  focusedClipObjects = function () {
    const r = _focused();
    if (!SEQ.prTrackMode || !r.track || r.track.kind !== 'free' || !r.clip) return r;
    return { track: r.track, clip: virtualClip(r.track), realClip: r.clip };
  };

  // Bands for the clips behind the notes; the focused one stands out.
  const _render = renderPianoRoll;
  renderPianoRoll = function () {
    _render();
    const body = document.getElementById('seq-pianoroll-body');
    if (!body || !SEQ.prTrackMode) return;
    const r = _focused();
    if (!r.track || r.track.kind !== 'free') return;
    const h = ((body._prHi - body._prLo + 1) * PR_ROW_H) + 'px';
    for (const c of r.track.items) {
      const band = document.createElement('div');
      band.className = 'pr-clip-band' + (c === r.clip ? ' focused' : '');
      band.style.left   = (c.start * PR_BEAT_PX + prKbW()) + 'px';
      band.style.width  = (c.beats * PR_BEAT_PX) + 'px';
      band.style.height = h;
      const plain = String(c.label || '').replace(/<[^>]*>/g, '');   // chord labels carry glyph markup
      band.title = (plain || 'clip') + ' · ' + c.beats + ' beats';
      const lbl = document.createElement('span');
      lbl.textContent = plain;
      band.appendChild(lbl);
      body.insertBefore(band, body.querySelector('.pr-sizer')?.nextSibling || null);
    }
  };

  // Opening a clip in track mode keeps the whole track in view and scrolls
  // to the clip.
  const _open = openPianoRoll;
  openPianoRoll = function (track, clip) {
    _open(track, clip);
    if (SEQ.prTrackMode && track && clip) {
      const body = document.getElementById('seq-pianoroll-body');
      if (body) body.scrollLeft = Math.max(0, clip.start * PR_BEAT_PX - 40);
    }
  };

  function setMode(track) {
    SEQ.prTrackMode = !!track;
    try { localStorage.setItem('chord-pad-pr-mode', track ? 'track' : 'clip'); } catch (_) {}
    document.getElementById('pr-mode-clip')?.classList.toggle('active', !track);
    document.getElementById('pr-mode-track')?.classList.toggle('active', track);
    const body = document.getElementById('seq-pianoroll-body');
    if (body) delete body.dataset.initialized;   // re-centre for the new extent
    if (typeof refreshPianoRollTitle === 'function') refreshPianoRollTitle();
    renderPianoRoll();
    if (track) {
      const r = _focused();
      if (body && r.clip) body.scrollLeft = Math.max(0, r.clip.start * PR_BEAT_PX - 40);
    }
  }

  // Clip | Track switch in the roll's toolbar.
  const tools = document.querySelector('.seq-pianoroll-tools');
  if (tools) {
    const sep = document.createElement('div');
    sep.className = 'seq-tool-sep';
    const mk = (id, text, title, on) => {
      const b = document.createElement('button');
      b.className = 'btn seq-tool-btn pr-mode-btn' + (on ? ' active' : '');
      b.id = id; b.textContent = text; b.title = title;
      b.addEventListener('mousedown', e => e.preventDefault());
      return b;
    };
    const bClip  = mk('pr-mode-clip',  'clip',  'Clip: only the opened clip, clip-relative', !SEQ.prTrackMode);
    const bTrack = mk('pr-mode-track', 'track', 'Track: every clip of the track on the song timeline', SEQ.prTrackMode);
    bClip.addEventListener('click',  () => setMode(false));
    bTrack.addEventListener('click', () => setMode(true));
    tools.appendChild(sep); tools.appendChild(bClip); tools.appendChild(bTrack);
  }
})();
