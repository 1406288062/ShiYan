/* Dots voice material: the original InterviewOrb layered CSS material, continued
 * through a deterministic grain field into the composer. This controller owns
 * presentation only. It never starts, pauses or stops the voice session. */
(() => {
  'use strict';
  const clamp = (n, a = 0, b = 1) => Math.min(b, Math.max(a, n));
  const mix = (a, b, t) => a + (b - a) * t;
  const smooth = t => { t = clamp(t); return t * t * (3 - 2 * t); };
  const palette = [[78,175,234], [94,96,237], [171,99,223], [243,129,134], [88,190,220]];
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${clamp(a)})`;
  const labels = {idle:'准备就绪',listening:'我在听',waiting:'正在思考',thinking:'正在思考',sending:'正在思考',starting:'正在准备语音',speaking:'正在回应',muted:'麦克风已静音',paused:'已暂停聆听'};
  const duration = 3600;

  class ShiYanDotsVoiceOrb {
    options: any;
    state: { active: boolean; phase: string; level: number; visible: boolean };
    mode: string;
    progress: number;
    time: number;
    level: number;
    floatOffset: number;
    drag: { id: number; startX: number; startY: number; distance: number; began: number; started: boolean } | null;
    handle!: HTMLDivElement;
    view: any;
    surface: any;
    animation: any;
    riseOrigin!: { x: number; y: number } | null;
    geometry!: { width: number; height: number; cx: number; cy: number; radius: number; sink: any; surfaceWidth: number; surfaceHeight: number; dpr: number };
    releaseProgress!: number;
    appliedOrbClip: any;
    canvas: any;
    caption: any;
    context: any;
    destroyed: any;
    frame: any;
    fullOrbClip: any;
    fullOrbClipKey: any;
    grains: any;
    hit: any;
    host: any;
    hover: any;
    hoverHalo: any;
    hoverLight: any;
    hoverStyle: any;
    ink: any;
    inkContext: any;
    lastFrame: any;
    layoutDirty: any;
    materialClip: any;
    materialLight: any;
    observer: any;
    onReducedMotion: any;
    onResize: any;
    onVisibility: any;
    phaseLabel: any;
    pointerId: any;
    reducedMotion: any;
    renderShown: any;
    constructor(options = {}) {
      this.options = options;
      this.state = {active:false, phase:'idle', level:0, visible:true};
      this.mode = 'orb';
      this.progress = 0; // amount of material transferred into the composer
      this.time = 0;
      this.level = 0;
      this.floatOffset = 0;
      this.hover = {target:0, amount:0, x:.5, y:.35, targetX:.5, targetY:.35};
      this.hoverStyle = {};
      this.fullOrbClip = '';
      this.fullOrbClipKey = '';
      this.appliedOrbClip = '';
      this.animation = null;
      this.drag = null;
      this.frame = 0;
      this.lastFrame = 0;
      this.layoutDirty = true;
      this.destroyed = false;
      this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.onResize = () => { this.layoutDirty = true; this.wake(); };
      this.onVisibility = () => this.syncVisibility();
      this.onReducedMotion = () => { this.resetHover(true); this.updatePresentation(); this.wake(); };
      this.observer = new ResizeObserver(this.onResize);
      window.addEventListener('resize', this.onResize);
      document.addEventListener('visibilitychange', this.onVisibility);
      this.reducedMotion.addEventListener?.('change', this.onReducedMotion);
      // Fixed seed means reversing a gesture reverses the same sand grains,
      // rather than replacing them with a newly randomised particle cloud.
      let seed = 15731;
      const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      this.grains = Array.from({length:1350}, () => ({
        born:random() * .79, life:.13 + random() * .08, side:random() * 2 - 1,
        drift:random() * 2 - 1, depth:random(), phase:random() * Math.PI * 2,
        size:.35 + random() * 1.05, colour:palette[Math.floor(random() * palette.length)]
      }));
      this.createScene();
    }

    createScene() {
      this.host = document.createElement('div');
      this.host.className = 'dots-voice-scene';
      this.host.hidden = true;
      // Keep the actual InterviewOrb material throughout the conversion. Its
      // conic base, screen-blended pools, glint and sheen all erode together;
      // there is no CSS-to-canvas replacement at the start of a gesture.
      // Exterior light follows the same shape, independently of the sand cut.
      this.materialLight = document.createElement('div');
      this.materialLight.className = 'dots-voice-material-light';
      this.materialLight.setAttribute('aria-hidden', 'true');
      this.materialLight.innerHTML = '<span class="dots-voice-material-halo"></span><span class="dots-voice-hover-halo"></span>';
      this.materialClip = document.createElement('div');
      this.materialClip.className = 'dots-voice-material-clip';
      this.materialClip.setAttribute('aria-hidden', 'true');
      this.materialClip.innerHTML = '<div class="dots-voice-material"><span class="dots-voice-material-sheen"></span><span class="dots-voice-material-core"></span><span class="dots-voice-material-hover"></span></div>';
      this.hoverLight = this.materialClip.querySelector('.dots-voice-material-hover');
      this.hoverHalo = this.materialLight.querySelector('.dots-voice-hover-halo');
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'dots-voice-scene-canvas';
      this.canvas.setAttribute('aria-hidden', 'true');
      this.context = this.canvas.getContext('2d');
      this.hit = document.createElement('div');
      this.hit.className = 'dots-voice-orb-hit';
      this.hit.tabIndex = 0;
      this.hit.setAttribute('role', 'button');
      this.hit.setAttribute('aria-label', '将语音球融入输入框，语音交流继续');
      this.hit.addEventListener('click', () => this.collapse());
      this.hit.addEventListener('pointerenter', event => this.moveHover(event));
      this.hit.addEventListener('pointermove', event => this.moveHover(event));
      this.hit.addEventListener('pointerleave', () => this.resetHover());
      this.hit.addEventListener('pointercancel', () => this.resetHover());
      this.hit.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.collapse(); }
      });
      this.caption = document.createElement('div');
      this.caption.className = 'dots-voice-orb-caption';
      this.caption.innerHTML = '<span class="dots-voice-orb-phase"></span>';
      this.phaseLabel = this.caption.firstElementChild;
      this.host.append(this.materialLight, this.materialClip, this.canvas, this.hit, this.caption);
      this.ink = document.createElement('canvas');
      this.ink.className = 'dots-voice-ink-canvas';
      this.ink.setAttribute('aria-hidden', 'true');
      this.inkContext = this.ink.getContext('2d');
      this.handle = document.createElement('div');
      this.handle.className = 'dots-voice-flow-handle';
      this.handle.setAttribute('role', 'slider');
      this.handle.setAttribute('aria-label', '向上拖动流光，重新凝聚语音球');
      this.handle.setAttribute('aria-valuemin', '0');
      this.handle.setAttribute('aria-valuemax', '100');
      this.handle.setAttribute('aria-valuenow', '0');
      this.handle.setAttribute('aria-orientation', 'vertical');
      this.handle.title = '按住流光向上拖动';
      this.handle.tabIndex = -1;
      this.handle.innerHTML = '<span aria-hidden="true"></span>';
      this.handle.addEventListener('pointerdown', event => this.beginDrag(event));
      this.handle.addEventListener('pointermove', event => this.moveDrag(event));
      this.handle.addEventListener('pointerup', event => this.endDrag(event));
      this.handle.addEventListener('pointercancel', event => this.endDrag(event, true));
      this.handle.addEventListener('lostpointercapture', event => { if(this.drag?.id === event.pointerId) this.endDrag(event, true); });
      this.handle.addEventListener('keydown', event => {
        if (this.mode === 'fused' && ['ArrowUp', 'Home'].includes(event.key)) {
          event.preventDefault(); this.riseOrigin = null; this.animate(0, 'gathering', duration);
        }
      });
    }

    attach(view, composerSurface) {
      if (this.destroyed || !view) return this;
      let changed = false;
      if (this.view !== view) {
        if (this.view) { this.observer.unobserve(this.view); this.clearView(this.view); }
        this.view = view;
        this.observer.observe(view);
        changed = true;
      }
      if (this.host.parentNode !== view) { view.append(this.host); changed = true; }
      if (this.surface !== composerSurface) {
        changed = true;
        if (this.surface) {
          this.observer.unobserve(this.surface);
          this.surface.classList.remove('dots-voice-composer','dots-voice-composer-live');
          this.surface.style.removeProperty('--dots-voice-material');
        }
        this.surface = composerSurface || null;
        if (this.surface) {
          this.surface.classList.add('dots-voice-composer');
          this.surface.prepend(this.ink);
          this.surface.append(this.handle);
          this.observer.observe(this.surface);
        } else { this.ink.remove(); this.handle.remove(); }
        // Pointer capture can be lost when an SSE update replaces the composer.
        // Return to the fused material continuously rather than abandoning it.
        if (this.drag) this.finishDrag(true);
      }
      if (changed) this.layoutDirty = true;
      this.updatePresentation();
      this.syncVisibility();
      return this;
    }

    setState(next = {}) {
      if (this.destroyed) return this;
      const wasActive = this.state.active;
      Object.assign(this.state, next);
      this.state.level = clamp(Number(this.state.level) || 0);
      if (!wasActive && this.state.active) {
        this.mode = 'orb'; this.progress = 0; this.animation = null; this.drag = null;
        this.riseOrigin = null; this.time = 0; this.level = 0; this.floatOffset = 0;
        this.emit();
      } else if (wasActive && !this.state.active) {
        this.drag = null; this.animation = null; this.progress = 0; this.mode = 'orb';
        this.releasePointer(); this.emit();
      }
      this.phaseLabel.textContent = labels[this.state.phase] || '语音交流中';
      this.updatePresentation();
      this.syncVisibility();
      return this;
    }

    getSnapshot() {
      return {mode:this.mode, progress:this.progress, active:this.state.active, visible:this.state.visible};
    }

    moveHover(event) {
      if (event.pointerType !== 'mouse' || !this.renderShown || this.mode !== 'orb' || this.reducedMotion.matches) return;
      const rect = this.hit.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      this.hover.target = 1;
      this.hover.targetX = clamp((event.clientX-rect.left)/rect.width, .12, .88);
      this.hover.targetY = clamp((event.clientY-rect.top)/rect.height, .12, .88);
      this.wake();
    }

    resetHover(immediate = false) {
      this.hover.target = 0;
      this.hover.targetX = .5; this.hover.targetY = .35;
      if (immediate) {
        this.hover.amount = 0; this.hover.x = .5; this.hover.y = .35;
        this.paintHover();
      } else this.wake();
    }

    updateHover(dt) {
      const hover = this.hover;
      const strength = 1-Math.exp(-dt/(hover.target ? 150 : 210));
      hover.amount += (hover.target-hover.amount)*strength;
      hover.x += (hover.targetX-hover.x)*(1-Math.exp(-dt/110));
      hover.y += (hover.targetY-hover.y)*(1-Math.exp(-dt/110));
      if(Math.abs(hover.target-hover.amount)<.0005)hover.amount=hover.target;
      if(Math.abs(hover.targetX-hover.x)<.00005)hover.x=hover.targetX;
      if(Math.abs(hover.targetY-hover.y)<.00005)hover.y=hover.targetY;
      this.paintHover();
    }

    paintHover() {
      // Keep the light texture fixed inside its rounded layer. Paint only its
      // background position and opacity; moving a composited square can escape
      // WebKit's animated parent clip. Cache local styles once the light settles.
      const hover=this.hover,cache=this.hoverStyle;
      const values={
        lightOpacity:(hover.amount*.72).toFixed(3),
        lightPosition:`${((1-hover.x)*100).toFixed(2)}% ${((1-hover.y)*100).toFixed(2)}%`,
        haloOpacity:(hover.amount*.68).toFixed(3),
        haloTransform:`translateZ(0) scale(${(.99+hover.amount*.025).toFixed(4)})`
      };
      if(cache.lightOpacity!==values.lightOpacity)this.hoverLight.style.opacity=values.lightOpacity;
      if(cache.lightPosition!==values.lightPosition)this.hoverLight.style.backgroundPosition=values.lightPosition;
      if(cache.haloOpacity!==values.haloOpacity)this.hoverHalo.style.opacity=values.haloOpacity;
      if(cache.haloTransform!==values.haloTransform)this.hoverHalo.style.transform=values.haloTransform;
      Object.assign(cache,values);
    }

    emit() {
      this.updatePresentation();
      const detail = this.getSnapshot();
      this.options.onFormChange?.(detail);
      this.view?.dispatchEvent(new CustomEvent('dots-voice-form', {detail}));
    }

    updatePresentation() {
      const active = !!this.state.active;
      const immersive = active && this.progress < .82;
      if (this.view) {
        this.view.classList.toggle('dots-voice-immersive', immersive);
        this.view.classList.toggle('dots-voice-live', active);
        this.view.dataset.dotsVoiceForm = active ? this.mode : 'off';
        // Re-applied on composer/records replacement without changing form.
        const records = this.view.querySelector('.dots-records');
        if (records) {
          records.inert = immersive;
          if (immersive) records.setAttribute('aria-hidden', 'true');
          else records.removeAttribute('aria-hidden');
        }
      }
      const canCollapse = active && this.mode === 'orb';
      if (!canCollapse) this.resetHover(!active || this.mode === 'fused');
      this.hit.hidden = !canCollapse;
      this.hit.tabIndex = canCollapse ? 0 : -1;
      // Keep the caption on the same reversible material path as the orb.
      // A form change starts the descent; it must not remove the text mid-frame.
      const captionReveal = smooth((1 - this.progress - .68) / .32);
      const falling = 1 - captionReveal;
      const reduced = this.reducedMotion.matches;
      this.caption.hidden = !active;
      this.caption.setAttribute('aria-hidden', String(!active || captionReveal < .95));
      Object.assign(this.caption.style, {
        opacity:String(captionReveal),
        transform:`translate(-50%,${reduced ? 0 : 18 * falling * falling}px)`,
        filter:reduced ? 'none' : `blur(${3 * falling}px)`
      });
      const canDrag = active && (this.mode === 'fused' || this.mode === 'dragging');
      // A fully formed orb can still be held by the pointer. Keep its capture
      // target mounted until release, even when the flow handle is transparent.
      this.handle.hidden = !active || (this.progress < .05 && this.mode !== 'dragging');
      this.handle.classList.toggle('dots-voice-flow-ready', canDrag);
      this.handle.classList.toggle('dots-voice-flow-dragging', this.mode === 'dragging');
      this.handle.tabIndex = active && this.mode === 'fused' ? 0 : -1;
      this.handle.setAttribute('aria-valuenow', String(Math.round((1 - this.progress) * 100)));
      this.surface?.classList.toggle('dots-voice-composer-live', active);
    }

    syncVisibility() {
      const shown = this.state.active && this.state.visible && !document.hidden && this.view?.isConnected;
      const changed = shown !== this.renderShown;
      this.renderShown = shown;
      this.host.hidden = !shown;
      this.ink.hidden = !shown;
      this.handle.style.visibility = shown ? '' : 'hidden';
      if (shown) { if(changed)this.layoutDirty = true; this.wake(); }
      else {
        this.resetHover(true);
        cancelAnimationFrame(this.frame); this.frame = 0; this.lastFrame = 0;
        // Store progress, not elapsed wall-clock time: changing work areas does
        // not finish or restart a transformation while it is off screen.
        if (this.drag) this.finishDrag(true);
      }
    }

    wake() {
      if (!this.frame && !this.destroyed && this.state.active && this.state.visible && !document.hidden && this.view?.isConnected) {
        this.frame = requestAnimationFrame(now => this.tick(now));
      }
    }

    collapse() {
      if (!this.state.active || !this.state.visible || this.mode !== 'orb') return;
      this.riseOrigin = null;
      this.animate(1, 'draining', duration);
    }

    animate(to, mode, milliseconds) {
      this.mode = mode;
      this.animation = {from:this.progress, to, elapsed:0, duration:this.reducedMotion.matches ? Math.min(milliseconds, 800) : milliseconds};
      this.emit(); this.wake();
    }

    beginDrag(event) {
      if (event.button !== 0 || !this.state.active || !this.state.visible || this.mode !== 'fused') return;
      event.preventDefault(); event.stopPropagation();
      if (this.layoutDirty) this.measure();
      this.drag = {id:event.pointerId, startX:event.clientX, startY:event.clientY, distance:0, began:performance.now(), started:false};
      this.riseOrigin = {x:this.geometry.sink.x, y:this.geometry.sink.y};
      try { this.handle.setPointerCapture(event.pointerId); this.pointerId = event.pointerId; } catch {}
      this.wake();
    }

    moveDrag(event) {
      if (!this.drag || event.pointerId !== this.drag.id) return;
      event.preventDefault(); event.stopPropagation();
      const distance = Math.max(0, this.drag.startY - event.clientY);
      if (!this.drag.started && distance < 5) return;
      if (!this.drag.started) { this.drag.started = true; this.mode = 'dragging'; this.emit(); }
      this.drag.distance = distance;
      const travel = Math.max(175, this.geometry.sink.y - this.geometry.cy);
      const formation=clamp(distance/travel);
      this.progress=1-formation;
      // The last part of a long pull settles into the resting position. Beyond
      // a full pull the same complete orb stays centred, rather than overshooting.
      const settle=smooth((formation-.72)/.28);
      this.riseOrigin = {
        x:mix(this.geometry.sink.x+clamp(event.clientX-this.drag.startX,-110,110)*.38,this.geometry.cx,settle),
        y:mix(this.geometry.sink.y-Math.min(distance,travel),this.geometry.cy+18,settle)
      };
      this.handle.classList.toggle('dots-voice-flow-threshold', distance >= this.threshold());
      this.updatePresentation(); this.wake();
    }

    threshold() { return clamp((this.geometry?.sink.y - this.geometry?.cy) * .34, 96, 136); }

    endDrag(event, cancelled = false) {
      if (!this.drag || event.pointerId !== this.drag.id) return;
      event.preventDefault(); event.stopPropagation(); this.finishDrag(cancelled);
    }

    releasePointer() {
      const id = this.pointerId;
      this.pointerId = null;
      if (id !== undefined && id !== null) { try { this.handle.releasePointerCapture(id); } catch {} }
    }

    finishDrag(cancelled) {
      if (!this.drag) return;
      const drag = this.drag;
      this.drag = null;
      this.releasePointer();
      this.handle.classList.remove('dots-voice-flow-threshold');
      if (!drag.started) { this.riseOrigin = null; this.emit(); return; }
      if (!cancelled && drag.distance >= this.threshold()) {
        if(this.progress===0) {
          // The pointer already completed formation and placement. Releasing
          // simply enables the normal orb interaction, with no redundant wait.
          this.mode='orb';this.animation=null;this.riseOrigin=null;this.emit();this.wake();return;
        }
        // Preserve the last dragged centre and let it travel to the resting
        // position over the remaining absorption; no release-time jump.
        this.releaseProgress = this.progress;
        const elapsed = performance.now() - drag.began;
        this.animate(0, 'gathering', Math.max(1500, duration - Math.min(2100, elapsed)));
      } else {
        this.releaseProgress = this.progress;
        this.animate(1, 'returning', Math.max(550, (1 - this.progress) * 1600));
      }
    }

    measure() {
      if (!this.view || !this.surface) return;
      const bounds = this.view.getBoundingClientRect();
      const surface = this.surface.getBoundingClientRect();
      const detail = this.surface.closest('.dots-detail')?.getBoundingClientRect() || bounds;
      if (!bounds.width || !bounds.height || !surface.width) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const sink = {x:surface.left - bounds.left + surface.width / 2, y:surface.top - bounds.top + 3};
      const top = Math.max(18, detail.top - bounds.top);
      const available = Math.max(120, sink.y - top - 44);
      const radius = Math.max(36, Math.min(114, detail.width * .19, available * .28));
      const cx = detail.left - bounds.left + detail.width / 2;
      const cy = top + available * .46;
      this.geometry = {width:bounds.width, height:bounds.height, cx, cy, radius, sink, surfaceWidth:surface.width, surfaceHeight:surface.height, dpr};
      this.canvas.width = Math.round(bounds.width * dpr);
      this.canvas.height = Math.round(bounds.height * dpr);
      this.canvas.style.width = bounds.width + 'px';
      this.canvas.style.height = bounds.height + 'px';
      this.ink.width = Math.round(surface.width * dpr);
      this.ink.height = Math.round(surface.height * dpr);
      Object.assign(this.hit.style, {left:(cx-radius-12)+'px',top:(cy-radius-12)+'px',width:(radius*2+24)+'px',height:(radius*2+24)+'px'});
      Object.assign(this.caption.style, {left:cx+'px',top:(cy+radius+35)+'px'});
      this.layoutDirty = false;
    }

    tick(now) {
      this.frame = 0;
      if (this.destroyed || !this.state.active || !this.state.visible || document.hidden) { this.lastFrame = 0; return; }
      const elapsed = this.lastFrame ? Math.max(0, now - this.lastFrame) : 16;
      const dt = Math.min(50, elapsed);
      this.lastFrame = now;
      this.time += dt / 1000;
      this.level += (this.state.level - this.level) * (1 - Math.exp(-dt / 75));
      this.updateHover(dt);
      if (this.animation) {
        const a = this.animation;
        // Use visible wall time so slower GPUs still finish the 3.6 s gesture.
        // syncVisibility resets lastFrame, so hidden workspaces stay frozen.
        a.elapsed += elapsed;
        const fraction = clamp(a.elapsed / a.duration);
        // Smooth velocity at both ends, with material positions derived from a
        // single progress value so erosion, grain flight and ink stay in phase.
        this.progress = mix(a.from, a.to, smooth(fraction));
        if (fraction >= 1) {
          this.progress = a.to; this.mode = a.to === 1 ? 'fused' : 'orb';
          this.animation = null; this.riseOrigin = null; this.emit();
        }
        this.updatePresentation();
      }
      // Join ambient drift before the last gathering frame, then continue the
      // same offset when the material becomes an idle orb.
      const floatWeight=smooth((1-this.progress-.68)/.32);
      const floatTarget=!this.reducedMotion.matches ? Math.sin(this.time*1.25)*4*floatWeight : 0;
      this.floatOffset+=(floatTarget-this.floatOffset)*(1-Math.exp(-dt/240));
      if (this.layoutDirty) this.measure();
      if (this.geometry && this.context) this.draw();
      // A reduced-motion preference keeps the material conversion but removes
      // ambient drift and idle frame work. Voice updates can still redraw it.
      if (!this.reducedMotion.matches || this.animation || this.drag) this.wake();
      else this.lastFrame = 0;
    }

    ballGeometry() {
      const g=this.geometry, u=1-this.progress;
      if (!['dragging','gathering','returning'].includes(this.mode)) return {x:g.cx,y:g.cy,r:g.radius,erosion:clamp(this.progress/.81)};
      let x=g.cx, y=g.cy;
      if (this.riseOrigin) {
        // Time gives the same double-smooth release path as before, including
        // when the remaining material is almost zero after a near-complete pull.
        const release=this.animation ? smooth(clamp(this.animation.elapsed/this.animation.duration)) : 0;
        const path=this.mode==='gathering'?smooth(release):0;
        x=mix(this.riseOrigin.x,g.cx,path);
        y=mix(this.riseOrigin.y-18,g.cy,path);
        if (this.mode==='returning') y=mix(this.riseOrigin.y-18,g.sink.y,smooth((this.progress-this.releaseProgress)/Math.max(.001,1-this.releaseProgress)));
      } else {
        y=mix(g.sink.y-18,g.cy,smooth(clamp(u*1.45)));
      }
      // The rising material has an unfinished frontier, not a complete sphere
      // being scaled up. Progress controls the same frontier on drag, return and
      // automatic completion, so reversing a gesture also reverses its formation.
      const formation = clamp(u);
      const revealed = 1 - Math.pow(1 - formation, 1.3);
      return {x,y,r:g.radius*Math.pow(smooth(u),.65),erosion:1-revealed,formation};
    }

    draw() {
      const g=this.geometry,ctx=this.context;
      ctx.setTransform(g.dpr,0,0,g.dpr,0,0);ctx.clearRect(0,0,g.width,g.height);
      const reduced=this.reducedMotion.matches;
      const t=reduced?0:this.time;
      const ball=this.ballGeometry();
      const alive=this.mode!=='fused' && (this.mode==='draining'?ball.erosion<1:ball.r>.1);
      this.materialClip.hidden = !alive;
      this.materialLight.hidden = !alive;
      if (alive) {
        const breath=1+this.level*.045;
        ball.y+=this.floatOffset;ball.r*=breath;
        this.drawOrb(ctx,ball,t);
      }
      if (this.mode!=='orb' && this.mode!=='fused') this.drawSand(ctx,ball,t);
      this.drawGatherFinish(ctx,ball);
      this.drawInk(t);
    }

    drawOrb(ctx,ball,t) {
      if(ball.r<.5)return;
      const diameter=ball.r*2;
      const edge=ball.y+ball.r*(1-2*ball.erosion);
      const decay=1-ball.erosion;
      const frontier=smooth(ball.erosion/.16);
      const bounds={left:(ball.x-ball.r)+'px',top:(ball.y-ball.r)+'px',width:diameter+'px',height:diameter+'px'};
      Object.assign(this.materialClip.style,bounds);
      Object.assign(this.materialLight.style,bounds,{opacity:String(1-frontier)});
      this.materialLight.style.setProperty('--dots-orb-voice',String(this.level));
      // Only reconstruction passes through mist into glass. The original
      // falling-sand collapse retains its crisp material and timing.
      const forming = Number.isFinite(ball.formation);
      const haze = forming ? Math.min(ball.r * .28, 12 * (1-smooth(ball.formation))) : 0;
      this.materialClip.style.setProperty('--dots-orb-formation-blur',haze.toFixed(3)+'px');
      // Cut the glass at the same edge that emits sand, for the entire path.
      // Exterior light fades independently; padding the cut to preserve its
      // shadow would delay erosion and then remove a large slice too quickly.
      // Keep a stable polygon, including the 1px rim, at both endpoints.
      const padding=Math.max(100,diameter*.6)/diameter*100;
      const clipKey=padding.toFixed(3);
      let clip=this.fullOrbClip;
      if(ball.erosion>0 || !clip || this.fullOrbClipKey!==clipKey) {
        const polygon=[`${-padding}% ${-padding}%`,`${100+padding}% ${-padding}%`];
        const bottom=(1-ball.erosion)*100+1.5/diameter*100;
        for(let i=0;i<=160;i++) {
          const local=100+padding-(100+2*padding)*i/160;
          const x=ball.x-ball.r+local/100*diameter;
          const ragged=ball.erosion>0 ? Math.sin(x*.31+t*2.7)*2.7+Math.sin(x*.91-t*3)*1.4+Math.cos(x*.11+t)*3 : 0;
          polygon.push(local.toFixed(3)+'% '+(bottom+ragged*frontier/diameter*100).toFixed(3)+'%');
        }
        clip='polygon('+polygon.join(',')+')';
        if(ball.erosion===0){this.fullOrbClip=clip;this.fullOrbClipKey=clipKey;}
      }
      if(this.appliedOrbClip!==clip){this.materialClip.style.clipPath=clip;this.appliedOrbClip=clip;}
      if(ball.erosion>0 && decay>0) {
        const half=ball.r*Math.sqrt(Math.max(0,1-Math.pow(1-2*ball.erosion,2)));
        for(let i=0;i<96;i++) {
          const grain=this.grains[i],x=ball.x+grain.side*half;
          const y=edge+Math.sin(x*.31+t*2.7)*2.7+grain.depth*10;
          ctx.fillStyle=rgba(grain.colour,(.4+grain.depth*.5)*frontier);
          ctx.beginPath();ctx.arc(x,y,grain.size*.65,0,Math.PI*2);ctx.fill();
        }
      }
    }

    drawSand(ctx,ball,t) {
      const g=this.geometry, rising=['dragging','gathering','returning'].includes(this.mode);
      const flow=rising?1-this.progress:this.progress;
      if(flow<=0||flow>=1)return;
      ctx.save();
      // Sand ends at the composer's upper lip; text and controls are never drawn over.
      ctx.beginPath();ctx.rect(0,0,g.width,g.sink.y+2);ctx.clip();
      for(const grain of this.grains) {
        const flight=(flow-grain.born)/grain.life;
        if(flight<0||flight>1)continue;
        const ease=rising?smooth(flight):flight*flight;
        let x,y;
        const spin=Math.sin(grain.phase+flight*Math.PI*4+t*.35);
        if(rising) {
          // Grains join the unfinished lower edge of the visible material,
          // rather than disappearing into the yet-invisible half of a sphere.
          const edge=ball.y+ball.r*(1-2*ball.erosion);
          const half=ball.r*Math.sqrt(Math.max(0,1-Math.pow(1-2*ball.erosion,2)));
          const targetX=ball.x+grain.side*half*.82;
          const targetY=mix(edge,ball.y+Math.cos(grain.phase)*ball.r*.76,smooth(clamp(((ball.formation??1)-.72)/.28)));
          x=mix(g.sink.x+grain.side*31,targetX,ease)+spin*Math.sin(flight*Math.PI)*(9+grain.depth*13);
          y=mix(g.sink.y,targetY,ease);
        } else {
          const erosion=clamp(grain.born/.81);
          const originY=g.cy+this.floatOffset+g.radius*(1-2*erosion);
          const width=g.radius*Math.sqrt(Math.max(0,1-Math.pow(1-2*erosion,2)));
          const originX=g.cx+grain.side*width*.96;
          const funnel=smooth(clamp(flight*1.55));
          x=mix(originX,g.sink.x+grain.drift*14,funnel)+spin*Math.sin(flight*Math.PI)*(3+grain.depth*8);
          y=mix(originY,g.sink.y,ease);
        }
        const alpha=(.38+grain.depth*.58)*Math.min(1,flight*14)*Math.min(1,(1-flight)*17);
        ctx.fillStyle=rgba(grain.colour,alpha);
        ctx.beginPath();ctx.ellipse(x,y,grain.size*(.7+grain.depth*.45),grain.size*(1.05+(!rising?flight*.7:0)),0,0,Math.PI*2);ctx.fill();
      }
      // An absorbing ripple belongs to the same material, never an extra control.
      const contact=rising?Math.sin(flow*Math.PI):Math.sin(clamp((flow-.1)/.9)*Math.PI);
      if(contact>0) {
        const glow=ctx.createRadialGradient(g.sink.x,g.sink.y,0,g.sink.x,g.sink.y,42);
        glow.addColorStop(0,rgba(palette[2],contact*.21));glow.addColorStop(1,rgba(palette[2],0));
        ctx.fillStyle=glow;ctx.fillRect(g.sink.x-45,g.sink.y-45,90,90);
      }
      ctx.restore();
    }

    drawInk(t) {
      const ctx=this.inkContext,g=this.geometry;
      if(!ctx||!this.surface)return;
      ctx.setTransform(g.dpr,0,0,g.dpr,0,0);ctx.clearRect(0,0,g.surfaceWidth,g.surfaceHeight);
      // Delay the first colour until grains have had time to reach the input.
      const amount=this.mode==='draining'?smooth(clamp((this.progress-.13)/.87)):smooth(this.progress);
      this.surface.style.setProperty('--dots-voice-material',String(amount));
      if(amount<=.001)return;
      const width=g.surfaceWidth,height=g.surfaceHeight,centre=width/2;
      const spread=mix(15,width*.72,amount);
      ctx.save();
      // Unroll the orb's colours from left to right. A conic field introduces a
      // centre seam/opposing halves in a shallow composer; one linear field
      // keeps the full width continuous, including while its glass gently flows.
      const drift=Math.sin(t*.12)*width*.025;
      const field=ctx.createLinearGradient(-width*.035+drift,0,width*1.035+drift,0);
      [[0,4],[.23,0],[.48,1],[.73,2],[1,3]].forEach(([stop,i])=>field.addColorStop(stop,rgba(palette[i],1)));
      ctx.globalAlpha=amount*.30;
      ctx.fillStyle=field;ctx.fillRect(0,0,width,height);
      ctx.globalAlpha=1;
      const pool=(x,y,rx,ry,colour,alpha)=>{
        ctx.save();ctx.translate(x,y);ctx.scale(rx,ry);
        const glow=ctx.createRadialGradient(0,0,0,0,0,1);
        glow.addColorStop(0,rgba(colour,alpha));glow.addColorStop(.45,rgba(colour,alpha*.62));glow.addColorStop(1,rgba(colour,0));
        ctx.fillStyle=glow;ctx.fillRect(-1,-1,2,2);ctx.restore();
      };
      ctx.globalCompositeOperation='screen';
      pool(width*(.20+Math.sin(t*.21)*.035),height*.34,width*.48,height*1.5,[102,224,255],amount*.13);
      pool(width*(.80+Math.cos(t*.17+1.3)*.035),height*.95,width*.48,height*1.6,[255,123,183],amount*.10);
      ctx.globalCompositeOperation='source-over';
      // Narrow refracted highlights, tinted by the orb instead of a white wash.
      // They stay against the glass edges, beneath the text and selection layer.
      pool(width*(.30+Math.sin(t*.18)*.055),2,width*.31,Math.min(13,height*.20),[202,235,255],amount*.45);
      pool(width*(.72+Math.cos(t*.15)*.045),height-1,width*.28,Math.min(11,height*.17),[171,99,223],amount*.30);
      if(amount<.999) {
        ctx.globalCompositeOperation='destination-in';
        const diffusion=ctx.createRadialGradient(centre,3,spread*.08,centre,3,spread);
        diffusion.addColorStop(0,'rgba(0,0,0,1)');diffusion.addColorStop(.66,'rgba(0,0,0,1)');diffusion.addColorStop(1,`rgba(0,0,0,${smooth(clamp((amount-.55)/.45))})`);
        ctx.fillStyle=diffusion;ctx.fillRect(0,0,width,height);
      }
      ctx.restore();
      this.drawGlassRipples(ctx, g);
      this.drawComposerFinish(ctx,g,amount);
      // Low-contrast flowing filaments at the upper/bottom edge keep the middle
      // quiet enough for IME composition, selection, the caret and small text.
      for(let line=0;line<4;line++) {
        ctx.beginPath();
        for(let x=0;x<=width;x+=8) {
          const y=height-3+Math.sin(x*.012+t*.6+line)*2-line*2;
          if(!x)ctx.moveTo(x,y);else ctx.lineTo(x,y);
        }
        ctx.strokeStyle=rgba(palette[line],amount*.12);ctx.lineWidth=.7;ctx.stroke();
      }
    }

    lastGrainState() {
      if(this.reducedMotion.matches || !this.state.active || !this.state.visible)return null;
      const rising=['dragging','gathering','returning'].includes(this.mode);
      if(!rising && this.mode!=='draining')return null;
      const position=rising?1-this.progress:this.progress;
      const start=rising ? .68 : .78,peak=rising ? .90 : .94;
      if(position<=start || position>=1)return null;
      // The same material progress owns both highlights. Returning through a
      // cancelled gesture reverses them continuously, without a second clock.
      return {rising,phase:smooth((position-start)/(1-start)),
        strength:smooth((position-start)/(peak-start))*smooth((1-position)/(1-peak))};
    }

    drawComposerFinish(ctx,g,amount) {
      const finish=this.lastGrainState();
      if(!finish)return;
      const phase=finish.phase;
      const distance=finish.rising?mix(72,0,phase):mix(8,75,phase);
      const radius=finish.rising?mix(32,10,phase):mix(12,32,phase);
      const strength=finish.strength*(finish.rising?Math.sqrt(clamp(amount)):1);
      ctx.save();
      ctx.beginPath();ctx.rect(0,0,g.surfaceWidth,Math.min(12,g.surfaceHeight));ctx.clip();
      ctx.globalCompositeOperation='source-over';
      for(const side of [-1,1]) {
        ctx.save();
        ctx.translate(g.surfaceWidth/2+side*distance,4);
        ctx.scale(radius,3+Math.sin(phase*Math.PI)*2);
        const colour=palette[side<0?4:2];
        const sheen=ctx.createRadialGradient(0,0,0,0,0,1);
        sheen.addColorStop(0,rgba(colour,strength*.12));
        sheen.addColorStop(.45,rgba(colour,strength*.05));
        sheen.addColorStop(1,rgba(colour,0));
        ctx.fillStyle=sheen;ctx.fillRect(-1,-1,2,2);
        ctx.restore();
      }
      ctx.restore();
    }

    drawGatherFinish(ctx,ball) {
      const finish=this.lastGrainState();
      if(!finish?.rising || ball.r<1)return;
      ctx.save();ctx.globalCompositeOperation='source-over';
      // Soft refractions travel inward over the formed upper hemisphere. Their
      // feathered edges merge into the existing sheen rather than drawing lines.
      for(let lane=0;lane<2;lane++) {
        const radius=ball.r*(.82-.20*finish.phase-lane*.055);
        const angle=Math.PI*(1.10+.26*finish.phase+lane*.085);
        const x=ball.x+Math.cos(angle)*radius,y=ball.y+Math.sin(angle)*radius;
        const colour=palette[lane===0?4:2];
        ctx.save();ctx.translate(x,y);ctx.rotate(angle+Math.PI/2);
        ctx.scale(ball.r*mix(.17,.09,finish.phase),ball.r*.045);
        const refraction=ctx.createRadialGradient(0,0,0,0,0,1);
        refraction.addColorStop(0,rgba(colour,finish.strength*.13));
        refraction.addColorStop(.45,rgba(colour,finish.strength*.055));
        refraction.addColorStop(1,rgba(colour,0));
        ctx.fillStyle=refraction;ctx.fillRect(-1,-1,2,2);ctx.restore();
      }
      ctx.restore();
    }

    drawGlassRipples(ctx, g) {
      // Reuse the material clock and canvas; never paint a continuous baseline.
      if(this.mode !== 'draining' || this.reducedMotion.matches)return;
      const contact=clamp((this.progress-.13)/.87);
      if(contact<=0 || contact>=1)return;
      const envelope=smooth(contact/.10)*smooth((1-contact)/.18);
      const reach=Math.min(g.surfaceWidth/2-26,220);
      if(reach<28)return;
      const centre=g.surfaceWidth/2;
      ctx.save();
      ctx.beginPath();ctx.rect(0,0,g.surfaceWidth,Math.min(12,g.surfaceHeight));ctx.clip();
      ctx.lineCap='round';ctx.lineJoin='round';
      const trace=(x,halfWidth,strength,profile)=>{
        if(strength<.001)return;
        const path=new Path2D();
        for(let step=0;step<=24;step++) {
          const offset=(step/12-1)*halfWidth;
          const y=3+profile(offset);
          if(!step)path.moveTo(x+offset,y);else path.lineTo(x+offset,y);
        }
        // Each small packet has transparent ends and a saturated tint. There
        // is no pale centre, bloom pass, or straight line joining the packets.
        const colour=palette[clamp(Math.round((x-centre+reach)/(2*reach)*3),0,3)];
        const tint=ctx.createLinearGradient(x-halfWidth,0,x+halfWidth,0);
        tint.addColorStop(0,rgba(colour,0));
        tint.addColorStop(.35,rgba(colour,.34));
        tint.addColorStop(.65,rgba(colour,.34));
        tint.addColorStop(1,rgba(colour,0));
        ctx.globalAlpha=strength;ctx.strokeStyle=tint;ctx.lineWidth=.8;ctx.stroke(path);
      };
      const depression=2.6*Math.sin(contact*Math.PI);
      trace(centre,28,envelope*Math.sin(contact*Math.PI),
        offset=>depression*Math.exp(-Math.pow(offset/15,2)));
      for(const start of [0,.32]) {
        const age=(contact-start)/.68;
        if(age<=0 || age>=1)continue;
        const amplitude=Math.pow(Math.sin(age*Math.PI),2)*Math.exp(-1.2*age);
        const front=10+(reach-10)*age;
        for(const side of [-1,1]) {
          trace(centre+side*front,19,envelope*amplitude,
            offset=>2.1*amplitude*Math.cos(offset*.16)*Math.exp(-Math.pow(offset/18,2)));
        }
      }
      ctx.restore();
    }

    clearView(view) {
      view.classList.remove('dots-voice-immersive','dots-voice-live');
      delete view.dataset.dotsVoiceForm;
      const records=view.querySelector('.dots-records');
      if(records){records.inert=false;records.removeAttribute('aria-hidden');}
    }

    destroy() {
      if(this.destroyed)return;
      this.destroyed=true;this.drag=null;this.releasePointer();cancelAnimationFrame(this.frame);
      this.resetHover(true);
      this.frame=0;this.lastFrame=0;this.animation=null;this.riseOrigin=null;
      this.state={active:false,phase:'idle',level:0,visible:false};
      this.observer.disconnect();window.removeEventListener('resize',this.onResize);
      document.removeEventListener('visibilitychange',this.onVisibility);
      this.reducedMotion.removeEventListener?.('change',this.onReducedMotion);
      if(this.view)this.clearView(this.view);
      this.surface?.classList.remove('dots-voice-composer','dots-voice-composer-live');
      this.surface?.style.removeProperty('--dots-voice-material');
      this.host.remove();this.ink.remove();this.handle.remove();
      // End of a call releases both GPU backing stores and the grain field.
      this.canvas.width=this.canvas.height=this.ink.width=this.ink.height=0;
      this.grains.length=0;this.context=null;this.inkContext=null;this.geometry=null as any;
      this.fullOrbClip='';this.fullOrbClipKey='';this.appliedOrbClip='';
      this.view=null;this.surface=null;
    }
  }
  window.ShiYanDotsVoiceOrb=ShiYanDotsVoiceOrb;
})();
